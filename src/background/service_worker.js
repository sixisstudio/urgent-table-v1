// Urgent Table — Service Worker (v0.2.0 — FIFO queue + persistence)
//
// Detects per-tab urgency from gotOmaha snapshots and maintains a global
// FIFO queue of urgent tables ordered by `urgentSince` (whoever buzzed
// first is at the head).
//
// All mutating state lives in `state` but is mirrored into
// chrome.storage.session on every change. Per the council pre-build review,
// the MV3 SW can be evicted at any moment and the alarm-driven keepalive
// is not reliable — storage is the idiomatic replacement for global state.
// On SW boot we rehydrate from storage and reconcile against open tabs.
//
// Window-moving is NOT in this version. The queue is purely informational
// here; it becomes the input to staging in v0.4.

import { isRealCard } from '../lib/card_codec.js';

const RELAY_NS = '__ut_v1__';
const HIJACK_HOST = 'game.hijack.poker';
const STORAGE_KEY = 'ut_state_v1';
const STAGE_RECT_KEY = 'ut_stage_rect_v1';  // persistent — in chrome.storage.local

// ─── Per-tab state (in-memory mirror of storage) ───────────────────
// state.perTab: Map<tabId, { perTable: Map<gameID, TableEntry>, startedAt }>
// state.queue:  Array<{ tabId, gameID, urgentSince }>   // FIFO order
// state.settings: { enabled: bool }
const state = {
  perTab: new Map(),
  queue: [],
  settings: { enabled: true },
  bootedAt: Date.now(),
};

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
    heroSeat: 0,
    currentActorSeat: 0,
    urgent: false,
    urgentSince: 0,
    lastSnapshotAt: 0,
    handNo: '',
  };
  tab.perTable.set(gameID, ts);
  return ts;
}

// ─── Storage persistence ──────────────────────────────────────────
// Mirror in-memory state to chrome.storage.session on every mutation.
// Map+nested structures are serialised to plain arrays so structured-clone
// (storage's transport) is happy.
function serializeState() {
  const tabs = [];
  for (const [tabId, t] of state.perTab) {
    const tables = [];
    for (const [gameID, ts] of t.perTable) {
      tables.push({
        gameID, heroSeat: ts.heroSeat, currentActorSeat: ts.currentActorSeat,
        urgent: ts.urgent, urgentSince: ts.urgentSince,
        lastSnapshotAt: ts.lastSnapshotAt, handNo: ts.handNo,
      });
    }
    tabs.push({ tabId, startedAt: t.startedAt, tables });
  }
  return {
    tabs,
    queue: state.queue.slice(),
    settings: { ...state.settings },
    bootedAt: state.bootedAt,
    serializedAt: Date.now(),
  };
}

let _persistTimer = null;
function schedulePersist() {
  // Coalesce bursts (many snapshots in one tick) into a single storage write
  // ~30 ms later. Still well under any meaningful staleness window.
  if (_persistTimer) return;
  _persistTimer = setTimeout(() => {
    _persistTimer = null;
    chrome.storage.session.set({ [STORAGE_KEY]: serializeState() }).catch((e) => {
      console.warn('[ut] storage.session persist failed:', e && e.message);
    });
  }, 30);
}

async function rehydrate() {
  try {
    const r = await chrome.storage.session.get([STORAGE_KEY]);
    const s = r && r[STORAGE_KEY];
    if (!s) return;
    state.settings = { enabled: true, ...(s.settings || {}) };
    state.queue = Array.isArray(s.queue) ? s.queue.slice() : [];
    if (Array.isArray(s.tabs)) {
      for (const t of s.tabs) {
        const tab = ensureTab(t.tabId);
        tab.startedAt = t.startedAt || tab.startedAt;
        for (const ts of (t.tables || [])) {
          const e = ensureTable(t.tabId, ts.gameID);
          Object.assign(e, ts);
        }
      }
    }
    // Reconcile: drop queue entries for tabs that no longer exist.
    const liveTabIds = new Set();
    const allTabs = await chrome.tabs.query({}).catch(() => []);
    for (const t of allTabs) liveTabIds.add(t.id);
    const before = state.queue.length;
    state.queue = state.queue.filter(q => liveTabIds.has(q.tabId));
    for (const tabId of Array.from(state.perTab.keys())) {
      if (!liveTabIds.has(tabId)) state.perTab.delete(tabId);
    }
    if (before !== state.queue.length) {
      console.log(`[ut] rehydrate reconcile: dropped ${before - state.queue.length} stale queue entries`);
    }
    if (state.queue.length > 0 || state.perTab.size > 0) {
      console.log(`[ut] rehydrated: ${state.perTab.size} tab(s), ${state.queue.length} queued`);
    }
  } catch (e) {
    console.warn('[ut] rehydrate failed:', e && e.message);
  }
}

// ─── Queue helpers ────────────────────────────────────────────────
function queueIndex(tabId, gameID) {
  for (let i = 0; i < state.queue.length; i++) {
    const q = state.queue[i];
    if (q.tabId === tabId && q.gameID === gameID) return i;
  }
  return -1;
}

function enqueueUrgent(tabId, gameID, urgentSince) {
  if (queueIndex(tabId, gameID) !== -1) return;
  state.queue.push({ tabId, gameID, urgentSince });
}

function dequeueUrgent(tabId, gameID) {
  const i = queueIndex(tabId, gameID);
  if (i !== -1) state.queue.splice(i, 1);
}

function dequeueTab(tabId) {
  state.queue = state.queue.filter(q => q.tabId !== tabId);
}

// ─── Keep-alive ───────────────────────────────────────────────────
chrome.alarms.create('ut-keepalive', { periodInMinutes: 0.5 });
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === 'ut-keepalive') {
    const n = state.perTab.size;
    const q = state.queue.length;
    if (n > 0 || q > 0) console.log(`[ut] keepalive: ${n} tab(s), ${q} queued`);
  }
});

// ─── MAIN-world proxy injection ───────────────────────────────────
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
    dequeueTab(tabId);
    console.log(`[ut] tab ${tabId} closed; cleared state`);
    schedulePersist();
  }
});

// ─── Port relay ───────────────────────────────────────────────────
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
      return;
    case 'frame':
      processFrame(tabId, msg);
      return;
    case 'relay_drops':
      console.warn('[ut] relay dropped', msg.count, 'frames');
      return;
  }
}

// ─── Frame parsing ────────────────────────────────────────────────
function decodeData(encData) {
  if (!encData) return null;
  if (encData.type === 'string') return encData.value;
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

function resolveCurrentActorSeat(game) {
  const m = game && game.move;
  if (m === undefined || m === null || m === '' || m === '0') return 0;
  const n = parseInt(m, 10);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

// v0.3.3: outgoing-frame fast-clear.
//
// Hero actions fly out on engine.hijack.poker/socket.io/ as socket.io EVENT
// frames of the form `42<ackId>["get_playermove", {gameID, seatId, data}]`
// where data is a URL-encoded query string like "&action=fold&opt=&actionTrigger=".
// (Discovered in v0.3.2-discovery.)
//
// Per the council pre-build review:
//   - Whitelist opcode: only "get_playermove" counts as a real action.
//   - Gate clear on table currently urgent AND payload.gameID matches AND
//     payload.seatId === ts.heroSeat. Without these guards a stale action
//     frame (e.g. delayed by network jitter) or a ping/heartbeat shouldn't
//     clear urgency.
//   - Inbound snapshot (`game.move` flipping away from hero) remains the
//     source of truth — the outbound match is just the ~200 ms fast path.
//     Both paths converge on the same state mutation, making the clear
//     fully idempotent.

function tryFastClear(tabId, msg) {
  const raw = decodeData(msg.data);
  if (typeof raw !== 'string') return;
  // socket.io EVENT framing: "42" + optional ack id + JSON array
  const m = raw.match(/^42\d*(\[.+\])$/s);
  if (!m) return;
  let arr;
  try { arr = JSON.parse(m[1]); } catch (e) { return; }
  if (!Array.isArray(arr) || arr.length < 2 || arr[0] !== 'get_playermove') return;
  const payload = arr[1];
  if (!payload || typeof payload !== 'object') return;
  const gameID = parseInt(payload.gameID, 10);
  const seatId = payload.seatId;
  if (!gameID || !Number.isFinite(seatId)) return;

  const tab = state.perTab.get(tabId);
  if (!tab) return;
  const ts = tab.perTable.get(gameID);
  if (!ts || !ts.urgent) return;
  if (ts.heroSeat !== seatId) return;

  // Extract action label for the log line only
  let actionLabel = '?';
  try {
    const data = String(payload.data || '');
    const params = new URLSearchParams(data.startsWith('&') ? data.slice(1) : data);
    actionLabel = params.get('action') || '?';
  } catch (e) { /* swallow */ }

  ts.urgent = false;
  ts.urgentSince = 0;
  dequeueUrgent(tabId, gameID);
  console.log(`[ut] URGENT OFF (fast)  tab=${tabId} table=${gameID} action=${actionLabel} seat=${seatId}; remaining queue=${state.queue.length}`);
  schedulePersist();
}

function processFrame(tabId, msg) {
  if (msg.dir === 'out') {
    tryFastClear(tabId, msg);
    return;
  }

  if (!msg.url || !msg.url.includes('game-ws.hijackpoker.com')) return;

  const raw = decodeData(msg.data);
  const parsed = parseGameWSFrame(raw);
  if (!parsed || parsed.event !== 'gotOmaha') return;
  const game = parsed.payload.game;
  if (!game || !game.gameID) return;

  const ts = ensureTable(tabId, game.gameID);
  const now = Date.now();
  ts.lastSnapshotAt = now;
  if (game.hand) ts.handNo = String(game.hand);

  const heroSeat = resolveHeroSeat(game);
  if (heroSeat !== ts.heroSeat) {
    if (ts.heroSeat === 0 && heroSeat !== 0) {
      console.log(`[ut] tab=${tabId} table=${game.gameID} hero seat resolved to ${heroSeat}`);
    }
    ts.heroSeat = heroSeat;
  }

  const actorSeat = resolveCurrentActorSeat(game);
  ts.currentActorSeat = actorSeat;

  const nowUrgent = state.settings.enabled && heroSeat !== 0 && actorSeat === heroSeat;
  if (nowUrgent !== ts.urgent) {
    ts.urgent = nowUrgent;
    if (nowUrgent) {
      ts.urgentSince = now;
      enqueueUrgent(tabId, game.gameID, now);
      console.log(`[ut] URGENT ON  tab=${tabId} table=${game.gameID} (hand ${ts.handNo || '?'}, seat=${heroSeat}, queuePos=${queueIndex(tabId, game.gameID) + 1}/${state.queue.length})`);
    } else {
      ts.urgentSince = 0;
      dequeueUrgent(tabId, game.gameID);
      console.log(`[ut] URGENT OFF (snap)  tab=${tabId} table=${game.gameID} (actor now seat ${actorSeat || 'none'}; remaining queue=${state.queue.length})`);
    }
  }
  schedulePersist();
}

// ─── Stage position capture (v0.4.0) ──────────────────────────────
// User clicks "Set stage position" in the extension popup → SW opens a
// dragger placeholder window centered on the primary display → user moves +
// resizes it to where they want every urgent table snapped → user clicks
// Save inside the placeholder → SW reads the window's bounds via
// chrome.windows.get(), figures out which display its center lies on via
// chrome.system.display.getInfo(), persists {left, top, width, height,
// displayId, savedAt} to chrome.storage.local, and closes the placeholder.
//
// v0.4.0 only captures + persists. Actual window-snapping lands in v0.4.1.

let stagePlaceholderWindowId = null;

async function openStagePlaceholder() {
  if (stagePlaceholderWindowId !== null) {
    try {
      await chrome.windows.update(stagePlaceholderWindowId, { focused: true });
      return { ok: true, reused: true };
    } catch (e) {
      stagePlaceholderWindowId = null;
    }
  }
  let displays;
  try { displays = await chrome.system.display.getInfo(); }
  catch (e) { return { ok: false, error: 'system.display.getInfo failed: ' + e.message }; }
  const primary = displays.find(d => d.isPrimary) || displays[0];
  if (!primary) return { ok: false, error: 'no display info' };

  // If a stage rect is already saved, open the placeholder at that position
  // so re-set workflow lands you on top of the current setting.
  let initial = null;
  try {
    const r = await chrome.storage.local.get([STAGE_RECT_KEY]);
    if (r && r[STAGE_RECT_KEY]) initial = r[STAGE_RECT_KEY];
  } catch (e) { /* ignore */ }

  const w = (initial && initial.width)  || 720;
  const h = (initial && initial.height) || 540;
  const left = (initial && initial.left !== undefined)
    ? initial.left
    : Math.round(primary.workArea.left + (primary.workArea.width  - w) / 2);
  const top  = (initial && initial.top  !== undefined)
    ? initial.top
    : Math.round(primary.workArea.top  + (primary.workArea.height - h) / 2);

  try {
    const win = await chrome.windows.create({
      url: chrome.runtime.getURL('src/popup/stage_placeholder.html'),
      type: 'popup',
      left, top, width: w, height: h,
      focused: true,
    });
    stagePlaceholderWindowId = win.id;
    console.log(`[ut] stage placeholder opened windowId=${win.id} at (${win.left},${win.top}) ${win.width}x${win.height}`);
    return { ok: true, windowId: win.id };
  } catch (e) {
    return { ok: false, error: 'windows.create failed: ' + e.message };
  }
}

async function saveStageFromPlaceholder() {
  if (stagePlaceholderWindowId === null) return { ok: false, error: 'no placeholder window open' };
  let win;
  try { win = await chrome.windows.get(stagePlaceholderWindowId); }
  catch (e) {
    stagePlaceholderWindowId = null;
    return { ok: false, error: 'windows.get failed: ' + e.message };
  }
  if (typeof win.left !== 'number' || typeof win.top !== 'number'
      || typeof win.width !== 'number' || typeof win.height !== 'number') {
    return { ok: false, error: 'window has no bounds (was it minimized?)' };
  }

  // Figure out which display its center is on. Multi-monitor + DPI mixing
  // is the main reason the council insisted on tracking displayId, not
  // just the bare rect.
  let displayId = null;
  try {
    const displays = await chrome.system.display.getInfo();
    const cx = win.left + win.width / 2;
    const cy = win.top + win.height / 2;
    const hit = displays.find(d =>
      cx >= d.bounds.left && cx < d.bounds.left + d.bounds.width &&
      cy >= d.bounds.top  && cy < d.bounds.top  + d.bounds.height
    );
    displayId = (hit && hit.id) || (displays[0] && displays[0].id) || null;
  } catch (e) { /* leave null */ }

  const stageRect = {
    left: win.left, top: win.top, width: win.width, height: win.height,
    displayId, savedAt: Date.now(),
  };
  try {
    await chrome.storage.local.set({ [STAGE_RECT_KEY]: stageRect });
  } catch (e) {
    return { ok: false, error: 'storage.local.set failed: ' + e.message };
  }
  console.log(`[ut] stage saved: ${stageRect.width}x${stageRect.height} at (${stageRect.left},${stageRect.top}) displayId=${displayId}`);

  // Close the placeholder (briefly delay so the placeholder UI can render
  // its "Saved … closing" toast first).
  const closingId = stagePlaceholderWindowId;
  setTimeout(() => {
    chrome.windows.remove(closingId).catch(() => { /* may already be gone */ });
  }, 600);
  return { ok: true, stageRect };
}

async function cancelStagePlaceholder() {
  if (stagePlaceholderWindowId === null) return { ok: true };
  const closingId = stagePlaceholderWindowId;
  stagePlaceholderWindowId = null;
  try { await chrome.windows.remove(closingId); } catch (e) {}
  return { ok: true };
}

async function clearStageRect() {
  await chrome.storage.local.remove(STAGE_RECT_KEY);
  console.log('[ut] stage rect cleared');
  return { ok: true };
}

// Track placeholder closure so we don't leak the windowId
chrome.windows.onRemoved.addListener((wid) => {
  if (wid === stagePlaceholderWindowId) {
    stagePlaceholderWindowId = null;
    console.log('[ut] stage placeholder closed');
  }
});

// ─── Popup + placeholder message handler ──────────────────────────
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || msg[RELAY_NS] !== 1) return false;
  switch (msg.kind) {
    case 'popup_get_state':
      sendResponse({ ok: true, state: serializeState() });
      return false;  // sync response
    case 'popup_set_enabled': {
      state.settings.enabled = !!msg.value;
      console.log(`[ut] enabled = ${state.settings.enabled}`);
      if (!state.settings.enabled) {
        for (const tab of state.perTab.values()) {
          for (const ts of tab.perTable.values()) {
            if (ts.urgent) { ts.urgent = false; ts.urgentSince = 0; }
          }
        }
        state.queue = [];
      }
      schedulePersist();
      sendResponse({ ok: true });
      return false;
    }
    case 'popup_open_stage_picker': {
      openStagePlaceholder().then(r => sendResponse(r));
      return true;  // async response
    }
    case 'popup_clear_stage': {
      clearStageRect().then(r => sendResponse(r));
      return true;
    }
    case 'stage_placeholder_save': {
      saveStageFromPlaceholder().then(r => sendResponse(r));
      return true;
    }
    case 'stage_placeholder_cancel': {
      cancelStagePlaceholder().then(r => sendResponse(r));
      return true;
    }
  }
  return false;
});

// ─── Auto-inject into existing Hijack tabs on SW boot ────────────
// v0.2.1: webNavigation.onCommitted only fires on FUTURE navigations.
// Tabs already open on game.hijack.poker when the extension is loaded
// (or reloaded) get no content script and no MAIN-world proxy, so
// frames don't flow and the user has to manually refresh. We fix that
// by querying all currently-open Hijack tabs at boot and programmatically
// injecting both scripts. Both have window-scope guards so double-inject
// is a no-op.
async function injectIntoExistingTabs() {
  let tabs = [];
  try {
    tabs = await chrome.tabs.query({ url: ['https://game.hijack.poker/*'] });
  } catch (e) {
    console.warn('[ut] tabs.query failed:', e && e.message);
    return;
  }
  for (const tab of tabs) {
    try {
      await chrome.scripting.executeScript({
        target: { tabId: tab.id, allFrames: true },
        world: 'ISOLATED',
        files: ['src/content/relay.js'],
      });
      await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        world: 'MAIN',
        files: ['src/background/ws_proxy.js'],
      });
      console.log(`[ut] auto-injected into existing tab ${tab.id}`);
    } catch (e) {
      // Tabs that are mid-discard, chrome:// hops, or otherwise unreachable
      // will throw — fine. Future navigations will be picked up by
      // webNavigation.onCommitted.
    }
  }
}

// ─── Boot ─────────────────────────────────────────────────────────
(async () => {
  await rehydrate();
  await injectIntoExistingTabs();
})();
console.log('[ut] service worker booted v0.4.0 — stage capture (no snap yet)');
