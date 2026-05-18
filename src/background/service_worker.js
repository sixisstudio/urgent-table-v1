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
// v0.4.12: accept any subdomain of hijack.poker, not just game.* —
// table 147 was being served from play.hijack.poker and our tab
// detection completely missed it because we only matched game.*
const HIJACK_HOST_RE = /(^|\.)hijack\.poker$/i;
const HIJACK_URL_PATTERNS = [
  'https://game.hijack.poker/*',
  'https://play.hijack.poker/*',
  'https://*.hijack.poker/*',
];
const STORAGE_KEY = 'ut_state_v1';
const STAGE_RECT_KEY = 'ut_stage_rect_v1';  // persistent — in chrome.storage.local

// ─── Debug ring buffer (v0.4.8) ───────────────────────────────────
// Last ~300 SW console messages, captured for cross-machine debugging.
// In-memory only — lost on SW eviction (acceptable: Tommy grabs a snapshot
// the moment something looks off). Wraps console.log/warn/error.
const _ringBuffer = [];
const _RING_SIZE = 300;
const _origConsole = {
  log: console.log.bind(console),
  warn: console.warn.bind(console),
  error: console.error.bind(console),
};
function _pushRing(level, args) {
  try {
    const msg = args.map(a =>
      typeof a === 'string' ? a
      : (typeof a === 'object' && a !== null) ? (() => { try { return JSON.stringify(a).slice(0, 400); } catch (e) { return String(a); } })()
      : String(a)
    ).join(' ').slice(0, 800);
    _ringBuffer.push({ t: Date.now(), level, msg });
    if (_ringBuffer.length > _RING_SIZE) _ringBuffer.shift();
  } catch (e) { /* never throw from logging */ }
}
console.log = (...a) => { _pushRing('log', a); _origConsole.log(...a); };
console.warn = (...a) => { _pushRing('warn', a); _origConsole.warn(...a); };
console.error = (...a) => { _pushRing('error', a); _origConsole.error(...a); };

// ─── Per-tab state (in-memory mirror of storage) ───────────────────
// state.perTab: Map<tabId, { perTable: Map<gameID, TableEntry>, startedAt }>
// state.queue:  Array<{ tabId, gameID, urgentSince }>   // FIFO order
// state.settings: { enabled: bool }
// state.stage = null OR { tabId, gameID, windowId, homeBounds: {left, top, width, height, state}, stagedAt }
const state = {
  perTab: new Map(),
  queue: [],
  stage: null,
  heroGUID: null,  // v0.4.3: captured from any outgoing frame's playerGUID field
  settings: {
    enabled: true,
    // v0.4.13: when on, the periodic reinject probe (every 60s) calls
    // chrome.tabs.reload on any stale tab (Hijack tab tracked >60s with
    // zero per-table state). Default off — auto-reload could interrupt
    // a hand on a tab we're blind to. With it on, recovery is hands-off.
    autoReloadStale: false,
  },
  bootedAt: Date.now(),
  // v0.4.13: per-tab last-reload timestamp so we don't reload-loop a
  // tab that comes back stale immediately (e.g. the page itself doesn't
  // open a WebSocket and never will).
  _lastReloadAt: new Map(),
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
    // v0.4.2: timestamp of the most recent fast-clear. Snapshots received
    // within PENDING_ACT_GRACE_MS that still say move===heroSeat are
    // ignored — server-side action processing has latency and a stale
    // snapshot can race back ahead of the real "actor moved on" snapshot.
    // Cleared the moment we see a snapshot where move !== heroSeat (or 0).
    pendingActComplete: 0,
  };
  tab.perTable.set(gameID, ts);
  return ts;
}

const PENDING_ACT_GRACE_MS = 2000;
// v0.4.4: if a table has been urgent this long without a fresh snapshot
// updating it, force URGENT OFF. Handles the case where the user exits a
// Hijack table inside the client but leaves the Chrome tab open at a
// lobby/empty screen — no more snapshots arrive, so urgency would otherwise
// be stuck indefinitely.
const URGENCY_TIMEOUT_MS = 30 * 1000;
// v0.4.6: per-table state is evicted once snapshots haven't arrived for
// this long. Live tables snapshot every few seconds, so 5 min of silence
// means the tab is parked at a lobby, the table closed, or the same
// gameID just isn't getting routed there anymore. Stops the popup from
// listing stale "table X hand 5 (last seen yesterday)" entries.
const STALE_TABLE_MS = 5 * 60 * 1000;

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
    stage: state.stage ? { ...state.stage } : null,
    heroGUID: state.heroGUID,
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
    state.stage = s.stage || null;
    state.heroGUID = s.heroGUID || null;
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
    // Reconcile stage: tab must still exist and still be urgent.
    if (state.stage) {
      const stillThere = liveTabIds.has(state.stage.tabId)
        && queueIndex(state.stage.tabId, state.stage.gameID) !== -1;
      if (!stillThere) {
        console.log(`[ut] rehydrate: stage entry for tab=${state.stage.tabId} is stale, clearing`);
        state.stage = null;
      }
    }
    if (state.queue.length > 0 || state.perTab.size > 0 || state.stage) {
      console.log(`[ut] rehydrated: ${state.perTab.size} tab(s), ${state.queue.length} queued, stage=${state.stage ? state.stage.tabId : 'none'}`);
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
// v0.4.3: every minute, scan for Hijack tabs that exist in Chrome but have
// never sent a relay message. Most likely cause: tab was loading / discarded
// when the SW first auto-injected, or opened via a code path that doesn't
// fire webNavigation.onCommitted. The proxy + relay both have window-scope
// guards so re-injecting an already-running pair is a no-op.
chrome.alarms.create('ut-reinject-probe', { periodInMinutes: 1 });
// v0.4.7: every 5 min, re-inject scripts into every live Hijack tab to
// recover from any silent script death. Runs always — no state wiped.
chrome.alarms.create('ut-refresh', { periodInMinutes: 5 });
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === 'ut-keepalive') {
    pruneStaleUrgency();
    evictStaleTables();
    const n = state.perTab.size;
    const q = state.queue.length;
    if (n > 0 || q > 0) console.log(`[ut] keepalive: ${n} tab(s), ${q} queued`);
  } else if (alarm.name === 'ut-reinject-probe') {
    reinjectMissingTabs();
  } else if (alarm.name === 'ut-refresh') {
    refreshAllTabs('scheduled-5min');
  }
});

async function reinjectMissingTabs() {
  let tabs = [];
  try { tabs = await chrome.tabs.query({ url: [...HIJACK_URL_PATTERNS] }); }
  catch (e) { return; }

  // v0.4.13: opt-in auto-reload of stale tabs. Runs before injection so
  // freshly-reloaded tabs don't get immediately reflagged this tick.
  if (state.settings.autoReloadStale) {
    const now = Date.now();
    let reloadedCount = 0;
    for (const tab of tabs) {
      const tracked = state.perTab.get(tab.id);
      if (!tracked) continue;
      const ageMs = (now / 1000 - (tracked.startedAt || 0)) * 1000;
      if (ageMs < 60_000 || tracked.perTable.size > 0) continue;
      // Throttle: don't reload the same tab more than once every 5 min
      const lastReload = state._lastReloadAt.get(tab.id) || 0;
      if (now - lastReload < 5 * 60_000) continue;
      try {
        await chrome.tabs.reload(tab.id);
        state._lastReloadAt.set(tab.id, now);
        reloadedCount++;
        console.log(`[ut] auto-reloaded stale tab=${tab.id} (tracked ${Math.round(ageMs/1000)}s, no tables)`);
      } catch (e) { /* skip */ }
    }
    if (reloadedCount > 0) console.log(`[ut] auto-reload: ${reloadedCount} stale tab(s) reloaded`);
  }

  const trackedIds = new Set(state.perTab.keys());
  const liveIds = new Set();
  // v0.4.4: verbose summary so we can diagnose missing tabs.
  console.log(`[ut] reinject probe: ${tabs.length} Hijack tab(s) in Chrome (${trackedIds.size} tracked)`);
  for (const tab of tabs) {
    liveIds.add(tab.id);
    const status = state.perTab.has(tab.id) ? 'tracked' : 'NEW';
    const flags = [];
    if (tab.discarded) flags.push('discarded');
    if (tab.status && tab.status !== 'complete') flags.push(tab.status);
    if (tab.frozen) flags.push('frozen');
    console.log(`[ut]   tab=${tab.id} [${status}${flags.length ? ' ' + flags.join(',') : ''}]`);
    if (state.perTab.has(tab.id)) continue;
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
      console.log(`[ut]     injected into tab=${tab.id}`);
    } catch (e) {
      console.warn(`[ut]     inject failed for tab=${tab.id}: ${e.message}`);
    }
  }

  // v0.4.4: reconcile — any tracked tab whose tab no longer exists gets
  // its state cleared. chrome.tabs.onRemoved usually fires, but edge cases
  // (window close, crash, Chrome eviction) can skip it.
  let removed = 0;
  for (const tabId of Array.from(trackedIds)) {
    if (!liveIds.has(tabId)) {
      const exists = await chrome.tabs.get(tabId).then(() => true).catch(() => false);
      if (!exists) {
        state.perTab.delete(tabId);
        dequeueTab(tabId);
        if (state.stage && state.stage.tabId === tabId) {
          state.stage = null;
          ensureStageInSync();
        }
        removed++;
      }
    }
  }
  if (removed > 0) {
    console.log(`[ut] reinject probe: reconciled ${removed} dead tab(s) out of state`);
    schedulePersist();
  }
}

// v0.4.4: walk every urgent table and force URGENT OFF on any that have
// been urgent past URGENCY_TIMEOUT_MS without a fresh snapshot. Runs every
// keepalive tick (~30s).
function pruneStaleUrgency() {
  const now = Date.now();
  let pruned = 0;
  for (const [tabId, tab] of state.perTab) {
    for (const [gameID, ts] of tab.perTable) {
      if (!ts.urgent) continue;
      const idleMs = now - (ts.lastSnapshotAt || ts.urgentSince || now);
      const urgentMs = now - (ts.urgentSince || now);
      if (urgentMs > URGENCY_TIMEOUT_MS && idleMs > URGENCY_TIMEOUT_MS / 2) {
        ts.urgent = false;
        ts.urgentSince = 0;
        dequeueUrgent(tabId, gameID);
        console.warn(`[ut] URGENT OFF (timeout) tab=${tabId} table=${gameID} (urgent for ${Math.round(urgentMs/1000)}s, idle ${Math.round(idleMs/1000)}s — table likely exited)`);
        pruned++;
      }
    }
  }
  if (pruned > 0) {
    schedulePersist();
    ensureStageInSync();
  }
}

// v0.4.6: drop per-table entries whose last snapshot is older than
// STALE_TABLE_MS. If all of a tab's tables are gone, drop the tab too.
// Catches the "tab on a closed Hijack table" / "old logger session" case
// where the gameID would otherwise sit in state.perTab forever.
function evictStaleTables() {
  const now = Date.now();
  let evictedTables = 0;
  let evictedTabs = 0;
  for (const [tabId, tab] of Array.from(state.perTab.entries())) {
    for (const [gameID, ts] of Array.from(tab.perTable.entries())) {
      const idleMs = now - (ts.lastSnapshotAt || 0);
      if (idleMs > STALE_TABLE_MS) {
        tab.perTable.delete(gameID);
        dequeueUrgent(tabId, gameID);
        if (state.stage && state.stage.tabId === tabId && state.stage.gameID === gameID) {
          // Was staged — abandon home, advance
          state.stage = null;
        }
        console.log(`[ut] evicted stale table ${gameID} on tab ${tabId} (idle ${Math.round(idleMs/1000)}s)`);
        evictedTables++;
      }
    }
    if (tab.perTable.size === 0) {
      state.perTab.delete(tabId);
      evictedTabs++;
    }
  }
  if (evictedTables > 0 || evictedTabs > 0) {
    schedulePersist();
    ensureStageInSync();
  }
}

// v0.4.7: light periodic refresh — re-inject the proxy + relay into
// every live Hijack tab so anything that silently died gets revived.
// NEVER wipes state. Hero GUID, stage rect, current stage, queue,
// per-table state are all preserved. Both scripts have window-scope
// guards (__ut_v1_proxy_installed__ / __ut_v1_relay_installed__) so
// re-injecting on top of a healthy pair is a free no-op. The point
// is to recover from silent failures (proxy crashed, relay port
// dropped without reconnect, etc.) without disrupting active play.
async function refreshAllTabs(reason) {
  let tabs = [];
  try { tabs = await chrome.tabs.query({ url: [...HIJACK_URL_PATTERNS] }); }
  catch (e) { return; }
  console.log(`[ut] refresh (${reason}): re-injecting into ${tabs.length} Hijack tab(s)`);
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
    } catch (e) {
      // Discarded/unreachable — fine, next refresh tick will try again.
    }
  }
}

// ─── MAIN-world proxy injection ───────────────────────────────────
chrome.webNavigation.onCommitted.addListener(async (details) => {
  if (details.frameId !== 0) return;
  let url;
  try { url = new URL(details.url); } catch (e) { return; }
  if (!HIJACK_HOST_RE.test(url.hostname)) return;
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
    if (state.stage && state.stage.tabId === tabId) {
      console.log(`[ut] tab ${tabId} closed while staged; abandoning home, advancing queue`);
      state.stage = null;
      // Don't try to restore — the home is gone. Pull next from queue.
      ensureStageInSync();
    }
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

// v0.4.3: hero detection by GUID match against p{N}data.
// Each p{N}data is a pipe-delimited string; index 1 is the seat-occupant's
// playerGUID. When we know the hero's GUID (captured from any outgoing
// frame), match it directly — never confuse a showdown reveal or another
// player's visible cards for hero. Falls back to the old "any seat with
// real cards" heuristic only when the GUID hasn't been captured yet
// (fresh install, no hero action sent yet).
function resolveHeroSeat(game) {
  if (state.heroGUID) {
    for (let i = 1; i <= 10; i++) {
      const data = game[`p${i}data`];
      if (typeof data === 'string') {
        const parts = data.split('|');
        if (parts[1] === state.heroGUID) return i;
      }
    }
    return 0;  // GUID known, not at this table → spectator
  }
  // Fallback (used only briefly until first outgoing frame lands)
  for (let i = 1; i <= 10; i++) {
    const cards = [
      game[`p${i}card1`], game[`p${i}card2`], game[`p${i}card3`],
      game[`p${i}card4`], game[`p${i}card5`],
    ];
    if (cards.some(isRealCard)) return i;
  }
  return 0;
}

// Capture hero's playerGUID from any outgoing frame. Setup, action,
// subscribe, ping — they all carry it on the wire.
function captureHeroGUID(rawData) {
  if (typeof rawData !== 'string') return;
  let payload = null;
  if (rawData.startsWith('{')) {
    try { payload = JSON.parse(rawData); } catch (e) {}
  } else {
    // socket.io EVENT framing: "4XX[<name>, <payload>]" (or just "<name>")
    const m = rawData.match(/^4\d*(\[.+\])$/s);
    if (m) {
      try {
        const arr = JSON.parse(m[1]);
        if (Array.isArray(arr) && arr.length >= 2) payload = arr[1];
      } catch (e) {}
    }
  }
  if (!payload || typeof payload !== 'object') return;
  const g = payload.playerGUID;
  if (typeof g === 'string' && g.length >= 16) {
    if (g !== state.heroGUID) {
      console.log(`[ut] hero GUID captured: ${g.slice(0, 12)}…`);
      state.heroGUID = g;
      schedulePersist();
    }
  }
}

function resolveCurrentActorSeat(game) {
  const m = game && game.move;
  if (m === undefined || m === null || m === '' || m === '0') return 0;
  const n = parseInt(m, 10);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

// v0.4.11: hole-cards check. Hijack briefly sets `move` to the SB / BB /
// straddle seat during blind-posting, before any cards are dealt — the
// detector was reading that as "hero to act" and staging the table for
// a fraction of a second every new hand. Suppress urgency until real
// hole cards exist in p{heroSeat}card1..4 so blind-post moments no
// longer trigger a stage/unstage flicker.
function heroHasCards(game, heroSeat) {
  if (!heroSeat) return false;
  for (let i = 1; i <= 4; i++) {
    if (isRealCard(game[`p${heroSeat}card${i}`])) return true;
  }
  return false;
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
  ts.pendingActComplete = Date.now();
  dequeueUrgent(tabId, gameID);
  console.log(`[ut] URGENT OFF (fast)  tab=${tabId} table=${gameID} action=${actionLabel} seat=${seatId}; remaining queue=${state.queue.length}`);
  schedulePersist();
  ensureStageInSync();
}

function processFrame(tabId, msg) {
  if (msg.dir === 'out') {
    // v0.4.3: every outgoing frame is a chance to learn our own GUID
    const raw = decodeData(msg.data);
    captureHeroGUID(raw);
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

  // v0.4.2: pendingActComplete grace window. If we just fast-cleared on a
  // hero outgoing action, suppress URGENT ON re-fires for ~2s while the
  // server catches up. As soon as a snapshot says actor moved on, clear
  // the flag so future urgency works normally.
  if (actorSeat !== heroSeat) {
    ts.pendingActComplete = 0;
  }
  let nowUrgent = state.settings.enabled
    && heroSeat !== 0
    && actorSeat === heroSeat
    && heroHasCards(game, heroSeat);
  if (nowUrgent && ts.pendingActComplete && (now - ts.pendingActComplete < PENDING_ACT_GRACE_MS)) {
    nowUrgent = false;  // stale snapshot during the grace window
  }
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
    schedulePersist();
    ensureStageInSync();
    return;
  }
  schedulePersist();
}

// ─── Window staging (v0.4.1) ──────────────────────────────────────
// The stage rect (from v0.4.0 "Set stage position") tells us WHERE every
// urgent table should be snapped on-screen. v0.4.1 wires the actual move:
//   URGENT ON  → push to FIFO queue → if nothing currently staged, stage
//                the queue head by recording its current window bounds as
//                "home" and chrome.windows.update'ing it to the stage rect.
//   URGENT OFF → if the unstaging table was the staged one, restore its
//                window to its home bounds; if the queue still has entries,
//                stage the new head.
//
// Per the council pre-build review:
//   - Two-step state transition: Chrome forbids combining state:'normal'
//     with bounds in the same windows.update call when the window is
//     currently fullscreen/maximized/minimized. We do state change first,
//     then bounds.
//   - Fullscreen Spaces on macOS are hostile: refuse to stage windows in
//     state 'fullscreen' or 'minimized'.
//   - Track displayId; if the saved display is no longer present, fall
//     back to primary so the rect doesn't land off-screen.
//   - Mutex covers full read-modify-write — two URGENT ON's in the same
//     tick can't race into the stage.
//   - One Hijack table per Chrome window required (auto-popping via
//     windows.create({tabId}) is detach = WebGL tear-down). Tabs that
//     share a window with others get skipped + warned (popup is fine for
//     v0.4.1; in-popup warning lands when needed).

// Promise chain mutex for stage operations
let stageOpChain = Promise.resolve();
function withStageLock(fn) {
  const next = stageOpChain.then(fn).catch(e => { console.warn('[ut] stage op error:', e && e.message); });
  stageOpChain = next.then(() => {});
  return next;
}

async function getStageRect() {
  try {
    const r = await chrome.storage.local.get([STAGE_RECT_KEY]);
    return (r && r[STAGE_RECT_KEY]) || null;
  } catch (e) { return null; }
}

async function resolveEffectiveStageRect(saved) {
  if (!saved) return null;
  let effective = { left: saved.left, top: saved.top, width: saved.width, height: saved.height };
  try {
    const displays = await chrome.system.display.getInfo();
    if (saved.displayId && !displays.find(d => d.id === saved.displayId)) {
      const primary = displays.find(d => d.isPrimary) || displays[0];
      if (primary) {
        // Clamp to primary workArea so it doesn't land off-screen
        effective.left = Math.max(primary.workArea.left, Math.min(saved.left,
          primary.workArea.left + primary.workArea.width - saved.width));
        effective.top = Math.max(primary.workArea.top, Math.min(saved.top,
          primary.workArea.top + primary.workArea.height - saved.height));
        console.warn(`[ut] stage display ${saved.displayId} not present; clamped to primary`);
      }
    }
  } catch (e) { /* leave effective as-is */ }
  return effective;
}

async function stageTable(tabId, gameID) {
  return withStageLock(async () => {
    if (state.stage) {
      // Already staged something else — let the existing entry play out
      return;
    }
    // Tab still exist?
    const tab = await chrome.tabs.get(tabId).catch(() => null);
    if (!tab) { dequeueUrgent(tabId, gameID); schedulePersist(); return; }

    // One-tab-per-window enforcement
    const sameWindowTabs = await chrome.tabs.query({ windowId: tab.windowId }).catch(() => []);
    if (sameWindowTabs.length > 1) {
      console.warn(`[ut] tab ${tabId} shares window ${tab.windowId} with ${sameWindowTabs.length - 1} other tab(s) — skipping stage. Move the Hijack table to its own window to enable staging.`);
      return;
    }

    // Read current window
    const win = await chrome.windows.get(tab.windowId).catch(() => null);
    if (!win) return;
    if (win.state === 'fullscreen' || win.state === 'minimized') {
      console.warn(`[ut] tab ${tabId} window state=${win.state} — refusing to stage (would fight OS state). Exit fullscreen first.`);
      return;
    }
    if (typeof win.left !== 'number') {
      console.warn(`[ut] tab ${tabId} window has no bounds (state=${win.state}) — skipping`);
      return;
    }

    // Resolve stage rect
    const savedRect = await getStageRect();
    if (!savedRect) {
      console.warn('[ut] no stage rect saved — open the popup and click "Set stage position" to enable staging');
      return;
    }
    const target = await resolveEffectiveStageRect(savedRect);
    if (!target) return;

    // Record home bounds BEFORE any move
    const homeBounds = {
      left: win.left, top: win.top, width: win.width, height: win.height,
      state: win.state || 'normal',
    };

    // Two-step transition: normalize state first, then bounds
    if (win.state && win.state !== 'normal') {
      try { await chrome.windows.update(tab.windowId, { state: 'normal' }); }
      catch (e) { console.warn(`[ut] state→normal failed: ${e.message}`); return; }
    }
    try {
      await chrome.windows.update(tab.windowId, {
        left: target.left, top: target.top, width: target.width, height: target.height,
        focused: true,
      });
    } catch (e) {
      console.warn(`[ut] windows.update bounds failed: ${e.message}`);
      return;
    }

    state.stage = {
      tabId, gameID, windowId: tab.windowId,
      homeBounds, stagedAt: Date.now(),
    };
    schedulePersist();
    console.log(`[ut] STAGED  tab=${tabId} table=${gameID} → (${target.left},${target.top}) ${target.width}×${target.height} (home was (${homeBounds.left},${homeBounds.top}) ${homeBounds.width}×${homeBounds.height} state=${homeBounds.state})`);
  });
}

async function unstageCurrent(reason) {
  return withStageLock(async () => {
    const s = state.stage;
    if (!s) return;
    state.stage = null;
    schedulePersist();

    const tab = await chrome.tabs.get(s.tabId).catch(() => null);
    if (!tab) {
      console.log(`[ut] UNSTAGE tab=${s.tabId} table=${s.gameID} reason=${reason} (tab gone)`);
    } else {
      // v0.4.3: re-query current windowId. The user may have dragged the
      // tab to a different window between stage and unstage. Using the
      // stored windowId would target a window that's gone/wrong.
      const currentWindowId = tab.windowId;
      try {
        const home = s.homeBounds;
        await chrome.windows.update(currentWindowId, {
          left: home.left, top: home.top, width: home.width, height: home.height,
        });
        const note = currentWindowId !== s.windowId ? ` (tab moved to window ${currentWindowId})` : '';
        console.log(`[ut] UNSTAGE tab=${s.tabId} table=${s.gameID} reason=${reason} → restored (${home.left},${home.top}) ${home.width}×${home.height}${note}`);
      } catch (e) {
        console.warn(`[ut] unstage restore failed: ${e.message}`);
      }
    }
  }).then(() => {
    // After unstage, pull next from queue (outside the same lock so the
    // recursive stageTable picks up cleanly).
    if (state.queue.length > 0) {
      const head = state.queue[0];
      stageTable(head.tabId, head.gameID);
    }
  });
}

// Called after every queue mutation to keep stage state in sync.
function ensureStageInSync() {
  if (state.stage) {
    const idx = queueIndex(state.stage.tabId, state.stage.gameID);
    if (idx === -1) {
      // The staged table is no longer urgent
      unstageCurrent('off-queue');
    }
    return;
  }
  if (state.queue.length > 0) {
    const head = state.queue[0];
    stageTable(head.tabId, head.gameID);
  }
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
    case 'popup_rescan_tabs': {
      // v0.4.10: force a re-inject NOW + WAIT 5 seconds for relays to
      // connect and gotOmaha frames to start flowing, THEN identify
      // stale tabs. Earlier version checked immediately, before any
      // newly-injected tabs had a chance to register — those tabs
      // weren't in state.perTab yet so `if (!tracked) continue` skipped
      // them entirely and we returned "0 stale" even when the user's
      // problematic tabs were exactly those un-tracked ones.
      //
      // Stale criteria after the wait:
      //   - Tab is a Hijack tab (in chrome.tabs.query result) AND
      //   - Either: not in state.perTab (relay never connected → most
      //     likely lobby/non-table page OR a content-script failure),
      //   - Or: in state.perTab but perTable.size === 0 (relay connected
      //     but proxy never saw a gotOmaha frame → WebSocket pre-dates
      //     the proxy and needs a tab reload).
      (async () => {
        const tabs = await chrome.tabs.query({ url: [...HIJACK_URL_PATTERNS] })
          .catch(() => []);
        let injected = 0;
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
            injected++;
          } catch (e) { /* discarded — skip */ }
        }
        // Wait for relays to connect + first snapshot to arrive
        await new Promise(r => setTimeout(r, 5000));
        const stale = [];
        for (const tab of tabs) {
          const tracked = state.perTab.get(tab.id);
          let reason = null;
          if (!tracked) reason = 'no relay';
          else if (tracked.perTable.size === 0) reason = 'no tables';
          if (reason) {
            stale.push({ tabId: tab.id, title: tab.title || '', url: tab.url || '', reason });
          }
        }
        console.log(`[ut] rescan: re-injected ${injected}/${tabs.length}, waited 5s, ${stale.length} stale`);
        sendResponse({ ok: true, scanned: tabs.length, injected, stale });
      })();
      return true;
    }
    case 'popup_reload_stale_tabs': {
      (async () => {
        const ids = Array.isArray(msg.tabIds) ? msg.tabIds : [];
        let reloaded = 0;
        for (const id of ids) {
          try { await chrome.tabs.reload(id); reloaded++; }
          catch (e) {}
        }
        console.log(`[ut] reloaded ${reloaded}/${ids.length} stale tabs`);
        sendResponse({ ok: true, reloaded });
      })();
      return true;
    }
    case 'popup_debug_snapshot': {
      // v0.4.8: bundle full state + ring buffer for cross-machine debugging.
      // Stage rect is fetched async from chrome.storage.local so we await it.
      (async () => {
        let stageRect = null;
        try {
          const r = await chrome.storage.local.get([STAGE_RECT_KEY]);
          stageRect = (r && r[STAGE_RECT_KEY]) || null;
        } catch (e) { /* ignore */ }
        sendResponse({
          ok: true,
          snapshot: {
            extension: 'Urgent Table',
            version: '0.4.15',
            bootedAt: state.bootedAt,
            capturedAt: Date.now(),
            heroGUID: state.heroGUID ? (state.heroGUID.slice(0, 12) + '…') : null,
            settings: state.settings,
            stageRect,
            currentStage: state.stage,
            queue: state.queue.slice(),
            tabs: serializeState().tabs,
            ringBuffer: _ringBuffer.slice(),
          },
        });
      })();
      return true;  // async response
    }
    case 'popup_set_auto_reload': {
      state.settings.autoReloadStale = !!msg.value;
      console.log(`[ut] autoReloadStale = ${state.settings.autoReloadStale}`);
      schedulePersist();
      sendResponse({ ok: true });
      return false;
    }
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
        // If something was staged, send it home.
        if (state.stage) unstageCurrent('disabled');
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
    tabs = await chrome.tabs.query({ url: [...HIJACK_URL_PATTERNS] });
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
console.log('[ut] service worker booted v0.4.15 — popup launches either dashboard');
