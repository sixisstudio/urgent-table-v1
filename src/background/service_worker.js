// Urgent Table — Service Worker (v0.1.0 detection-only)
//
// Listens for WebSocket frames captured by ws_proxy.js (MAIN world) and
// relayed via content/relay.js (ISOLATED world) over a long-lived port.
// Filters for gotOmaha snapshots on the game-ws auth channel, identifies
// per-tab whose seat is currently to act (game.move), compares to the hero
// seat (the seat with real face-up cards), and logs a console line every
// time a table transitions urgent ON or urgent OFF.
//
// No queue, no popup, no window-moving yet — those land in v0.2 / v0.3 /
// v0.4 increments. The point of v0.1.0 is to prove the detection signal
// is reliable end-to-end before any UI or staging is built.

import { isRealCard } from '../lib/card_codec.js';

const RELAY_NS = '__ut_v1__';
const HIJACK_HOST = 'game.hijack.poker';

// ─── Per-tab state ────────────────────────────────────────────────
// Map<tabId, { perTable: Map<gameID, {heroSeat, currentActorSeat, urgent, lastTransitionAt}> }>
const state = { perTab: new Map() };

function ensureTab(tabId) {
  if (state.perTab.has(tabId)) return state.perTab.get(tabId);
  const t = { perTable: new Map(), startedAt: Math.floor(Date.now() / 1000) };
  state.perTab.set(tabId, t);
  return t;
}

function ensureTable(tabId, gameID) {
  const tab = ensureTab(tabId);
  if (tab.perTable.has(gameID)) return tab.perTable.get(gameID);
  const ts = {
    gameID,
    heroSeat: 0,        // 0 = unknown / spectator
    currentActorSeat: 0, // 0 = no one on the clock
    urgent: false,
    lastTransitionAt: 0,
  };
  tab.perTable.set(gameID, ts);
  return ts;
}

// ─── Keep-alive (MV3 SWs evict after ~30s idle) ───────────────────
chrome.alarms.create('ut-keepalive', { periodInMinutes: 0.5 });
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === 'ut-keepalive') {
    const n = state.perTab.size;
    if (n > 0) console.log(`[ut] keepalive: ${n} active Hijack tab(s)`);
  }
});

// ─── Programmatic MAIN-world proxy injection ──────────────────────
chrome.webNavigation.onCommitted.addListener(async (details) => {
  if (details.frameId !== 0) return;
  let url;
  try { url = new URL(details.url); } catch (e) { return; }
  if (url.hostname !== HIJACK_HOST) return;
  try {
    await chrome.scripting.executeScript({
      target: { tabId: details.tabId },
      world: 'MAIN',
      injectImmediately: true,
      files: ['src/background/ws_proxy.js'],
    });
  } catch (e) {
    console.error('[ut] proxy injection failed:', e.message);
  }
});

// ─── Tab cleanup ──────────────────────────────────────────────────
chrome.tabs.onRemoved.addListener((tabId) => {
  if (state.perTab.has(tabId)) {
    state.perTab.delete(tabId);
    console.log(`[ut] tab ${tabId} closed; cleared state`);
  }
});

// ─── Port relay (frames come in here) ─────────────────────────────
chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== 'ut-relay') return;
  const tabId = port.sender && port.sender.tab && port.sender.tab.id;
  if (!tabId) return;
  port.onMessage.addListener((msg) => {
    if (!msg || msg[RELAY_NS] !== 1) return;
    dispatchRelayMessage(tabId, msg);
  });
});

function dispatchRelayMessage(tabId, msg) {
  ensureTab(tabId);
  switch (msg.kind) {
    case 'proxy_installed':
    case 'relay_loaded':
    case 'socket_open':
      // ack-only; nothing to do in v0.1.0
      return;
    case 'frame':
      processFrame(tabId, msg);
      return;
    case 'relay_drops':
      console.warn('[ut] relay dropped', msg.count, 'frames');
      return;
  }
}

// ─── Frame processing ─────────────────────────────────────────────
function decodeData(encData) {
  if (!encData) return null;
  if (encData.type === 'string') return encData.value;
  // We only need string frames for gotOmaha — binary heartbeats can be skipped
  return null;
}

function parseGameWSFrame(data) {
  if (typeof data !== 'string') return null;
  if (!data.startsWith('{')) return null;
  let parsed;
  try { parsed = JSON.parse(data); } catch (e) { return null; }
  if (!parsed || typeof parsed.event !== 'string') return null;
  return { event: parsed.event, payload: parsed };
}

/**
 * Hero seat = the seat whose p{N}card slots hold real face-up cards.
 * Returns 0 when no seat has real cards yet (spectator or pre-deal).
 */
function resolveHeroSeat(game) {
  for (let i = 1; i <= 10; i++) {
    const cards = [
      game[`p${i}card1`], game[`p${i}card2`], game[`p${i}card3`],
      game[`p${i}card4`], game[`p${i}card5`],
    ];
    if (cards.some(isRealCard)) return i;
  }
  return 0;
}

/**
 * Current actor seat is the integer parse of game.move.
 * Hijack stores it as a string; '0' / '' / missing means no one is on the clock.
 */
function resolveCurrentActorSeat(game) {
  const m = game && game.move;
  if (m === undefined || m === null || m === '' || m === '0') return 0;
  const n = parseInt(m, 10);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

function processFrame(tabId, msg) {
  // Only the auth'd game-ws channel carries gotOmaha
  if (!msg.url || !msg.url.includes('game-ws.hijackpoker.com')) return;

  const raw = decodeData(msg.data);
  const parsed = parseGameWSFrame(raw);
  if (!parsed || parsed.event !== 'gotOmaha') return;

  const game = parsed.payload.game;
  if (!game || !game.gameID) return;

  const ts = ensureTable(tabId, game.gameID);

  // Refresh hero seat every snapshot — it can change between hands if hero
  // sits out then back in, or if we joined the table after a hand started.
  const heroSeat = resolveHeroSeat(game);
  if (heroSeat !== ts.heroSeat) {
    if (ts.heroSeat === 0 && heroSeat !== 0) {
      console.log(`[ut] tab=${tabId} table=${game.gameID} hero seat resolved to ${heroSeat}`);
    }
    ts.heroSeat = heroSeat;
  }

  const actorSeat = resolveCurrentActorSeat(game);
  ts.currentActorSeat = actorSeat;

  // Urgency = hero is the current actor.
  const nowUrgent = heroSeat !== 0 && actorSeat === heroSeat;
  if (nowUrgent !== ts.urgent) {
    ts.urgent = nowUrgent;
    ts.lastTransitionAt = Date.now();
    if (nowUrgent) {
      console.log(`[ut] URGENT ON  tab=${tabId} table=${game.gameID} (hand ${game.hand || '?'}, seat=${heroSeat})`);
    } else {
      console.log(`[ut] URGENT OFF tab=${tabId} table=${game.gameID} (actor now seat ${actorSeat || 'none'})`);
    }
  }
}

console.log('[ut] service worker booted v0.1.0 — detection-only mode');
