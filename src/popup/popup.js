// Urgent Table — popup UI
//
// Reads state from chrome.storage.session (mirrored by the SW on every
// mutation) and re-renders on every storage change. Polls a wall-clock
// timer at 500 ms while open just to refresh the "for 4.2s" elapsed counters
// next to each queue entry — no SW round-trips for that.

const RELAY_NS = '__ut_v1__';
const STORAGE_KEY = 'ut_state_v1';
const STAGE_RECT_KEY = 'ut_stage_rect_v1';

const el = {
  enabled: document.getElementById('enabled'),
  setStagePos: document.getElementById('setStagePos'),
  clearStage: document.getElementById('clearStage'),
  stageStatus: document.getElementById('stageStatus'),
  queueList: document.getElementById('queueList'),
  tableList: document.getElementById('tableList'),
  copyDebug: document.getElementById('copyDebug'),
  copyDebugStatus: document.getElementById('copyDebugStatus'),
  rescanTabs: document.getElementById('rescanTabs'),
  reloadStale: document.getElementById('reloadStale'),
  staleList: document.getElementById('staleList'),
};

let latest = null;

async function loadInitial() {
  // Storage is the canonical source. Fall back to a SW round-trip if storage
  // hasn't been populated yet (first run before any frame has landed).
  try {
    const r = await chrome.storage.session.get([STORAGE_KEY]);
    if (r && r[STORAGE_KEY]) {
      latest = r[STORAGE_KEY];
      render();
      return;
    }
  } catch (e) { /* ignore */ }
  chrome.runtime.sendMessage({ [RELAY_NS]: 1, kind: 'popup_get_state' }, (resp) => {
    if (chrome.runtime.lastError) return;
    if (resp && resp.ok) {
      latest = resp.state;
      render();
    }
  });
}

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'session' && changes[STORAGE_KEY]) {
    latest = changes[STORAGE_KEY].newValue;
    render();
  }
  if (area === 'local' && changes[STAGE_RECT_KEY]) {
    renderStage(changes[STAGE_RECT_KEY].newValue);
  }
});

el.enabled.addEventListener('change', () => {
  chrome.runtime.sendMessage({
    [RELAY_NS]: 1, kind: 'popup_set_enabled', value: el.enabled.checked,
  }, () => { /* state will be pushed back through storage change */ });
});

el.setStagePos.addEventListener('click', () => {
  el.setStagePos.disabled = true;
  chrome.runtime.sendMessage(
    { [RELAY_NS]: 1, kind: 'popup_open_stage_picker' },
    (resp) => {
      el.setStagePos.disabled = false;
      if (chrome.runtime.lastError || !resp || !resp.ok) {
        console.warn('[ut popup] open stage picker failed:', resp && resp.error);
      }
      // The popup typically closes itself when focus moves to the new
      // window. No further render needed; the storage.local change will
      // re-paint if the user saves.
    }
  );
});

el.clearStage.addEventListener('click', () => {
  chrome.runtime.sendMessage(
    { [RELAY_NS]: 1, kind: 'popup_clear_stage' },
    () => { /* storage.onChanged refreshes */ }
  );
});

async function loadStage() {
  try {
    const r = await chrome.storage.local.get([STAGE_RECT_KEY]);
    renderStage(r && r[STAGE_RECT_KEY]);
  } catch (e) { /* ignore */ }
}

function renderStage(rect) {
  if (rect && typeof rect.width === 'number') {
    el.stageStatus.classList.add('set');
    const ts = new Date(rect.savedAt || 0);
    el.stageStatus.textContent =
      `${rect.width}×${rect.height} @ (${rect.left}, ${rect.top})`
      + (rect.displayId != null ? `  display ${String(rect.displayId).slice(0, 10)}` : '');
    el.clearStage.style.display = '';
    el.setStagePos.textContent = 'Re-set stage position';
  } else {
    el.stageStatus.classList.remove('set');
    el.stageStatus.textContent = 'Not set';
    el.clearStage.style.display = 'none';
    el.setStagePos.textContent = 'Set stage position';
  }
}

function fmtElapsed(ms) {
  if (!ms || ms < 0) return '';
  if (ms < 1000) return `${ms} ms`;
  const s = ms / 1000;
  if (s < 60) return `${s.toFixed(1)}s`;
  const m = Math.floor(s / 60);
  return `${m}m ${Math.round(s - m * 60)}s`;
}

function render() {
  if (!latest) return;
  el.enabled.checked = !!(latest.settings && latest.settings.enabled);

  // Build a lookup: (tabId, gameID) → table entry
  const tableLookup = new Map();
  for (const t of latest.tabs || []) {
    for (const ts of (t.tables || [])) {
      tableLookup.set(`${t.tabId}:${ts.gameID}`, { tabId: t.tabId, ...ts });
    }
  }

  // v0.4.5: collapse by gameID for display. Multiple tabs on the same
  // Hijack table all show one row. We pick the "best" entry per gameID:
  //   - prefer one whose heroSeat != 0 (player view over spectator view)
  //   - prefer one currently urgent
  //   - prefer most recent snapshot
  // Tab count is shown in parentheses so the duplication isn't hidden.
  const byGameID = new Map();
  for (const ts of tableLookup.values()) {
    const cur = byGameID.get(ts.gameID);
    if (!cur) {
      byGameID.set(ts.gameID, { entry: ts, count: 1 });
      continue;
    }
    cur.count++;
    // Score: heroSeat present + urgent + recent snapshot
    const score = (x) =>
      ((x.heroSeat ? 100 : 0) + (x.urgent ? 50 : 0) + ((x.lastSnapshotAt || 0) / 1e12));
    if (score(ts) > score(cur.entry)) cur.entry = ts;
  }

  // Queue list — also dedupe by gameID so a multi-tab table doesn't
  // produce multiple urgent rows. First-fired wins.
  el.queueList.innerHTML = '';
  if (!latest.queue || latest.queue.length === 0) {
    const li = document.createElement('li');
    li.className = 'empty';
    li.textContent = 'No tables waiting on you.';
    el.queueList.appendChild(li);
  } else {
    const seenGameIDs = new Set();
    const dedupedQueue = [];
    for (const q of latest.queue) {
      if (seenGameIDs.has(q.gameID)) continue;
      seenGameIDs.add(q.gameID);
      dedupedQueue.push(q);
    }
    const now = Date.now();
    dedupedQueue.forEach((q, i) => {
      const entry = tableLookup.get(`${q.tabId}:${q.gameID}`) || {};
      const li = document.createElement('li');
      li.className = 'urgent';
      const label = document.createElement('span');
      label.className = 'label';
      label.innerHTML = `<span class="dot urgent"></span>#${i + 1} &nbsp; table ${q.gameID}${entry.handNo ? ' · hand ' + entry.handNo : ''}`;
      const meta = document.createElement('span');
      meta.className = 'meta';
      meta.textContent = `for ${fmtElapsed(now - q.urgentSince)}`;
      li.appendChild(label);
      li.appendChild(meta);
      el.queueList.appendChild(li);
    });
  }

  // All known tables — one row per unique gameID
  el.tableList.innerHTML = '';
  if (byGameID.size === 0) {
    const li = document.createElement('li');
    li.className = 'empty';
    li.textContent = 'No Hijack tabs detected. Open a table to start.';
    el.tableList.appendChild(li);
  } else {
    const rows = Array.from(byGameID.values());
    rows.sort((a, b) => a.entry.gameID - b.entry.gameID);
    for (const { entry: ts, count } of rows) {
      const li = document.createElement('li');
      const label = document.createElement('span');
      label.className = 'label';
      const dotClass = ts.urgent ? 'urgent' : 'idle';
      const tabSuffix = count > 1 ? ` <span style="opacity:.6">(${count} tabs)</span>` : '';
      label.innerHTML = `<span class="dot ${dotClass}"></span>table ${ts.gameID}${ts.handNo ? ' · hand ' + ts.handNo : ''}${tabSuffix}`;
      const meta = document.createElement('span');
      meta.className = 'meta';
      meta.textContent = ts.heroSeat
        ? (ts.urgent ? `hero seat ${ts.heroSeat} TO ACT` : `hero seat ${ts.heroSeat}`)
        : 'spectator';
      li.appendChild(label);
      li.appendChild(meta);
      el.tableList.appendChild(li);
    }
  }
}

// Refresh "for X.Xs" counters every 500ms while the popup is open.
setInterval(() => { if (latest && (latest.queue || []).length > 0) render(); }, 500);

// ─── Rescan + reload stale tabs (v0.4.9) ──────────────────────────
let lastStaleIds = [];
if (el.rescanTabs) {
  el.rescanTabs.addEventListener('click', async () => {
    el.rescanTabs.disabled = true;
    el.copyDebugStatus.textContent = 'rescanning…';
    el.staleList.style.display = 'none';
    el.reloadStale.style.display = 'none';
    const resp = await new Promise((res) => {
      chrome.runtime.sendMessage({ [RELAY_NS]: 1, kind: 'popup_rescan_tabs' }, (r) => {
        if (chrome.runtime.lastError) res(null); else res(r);
      });
    });
    el.rescanTabs.disabled = false;
    if (!resp || !resp.ok) {
      el.copyDebugStatus.textContent = 'rescan failed';
      return;
    }
    el.copyDebugStatus.textContent = `re-injected ${resp.injected}/${resp.scanned} tab(s)`;
    el.staleList.className = 'stale-box';
    if (resp.stale && resp.stale.length > 0) {
      lastStaleIds = resp.stale.map(s => s.tabId);
      const items = resp.stale.map(s => `<li>Tab #${s.tabId} — ${(s.title || 'no title').slice(0, 60)}</li>`).join('');
      el.staleList.innerHTML = `<strong>${resp.stale.length} tab(s) tracked but no frames captured.</strong> WebSocket likely pre-dates the proxy; reload to fix:<ul>${items}</ul>`;
      el.staleList.style.display = 'block';
      el.reloadStale.textContent = `Reload ${resp.stale.length} stale tabs`;
      el.reloadStale.style.display = '';
    } else {
      lastStaleIds = [];
      el.staleList.classList.add('ok');
      el.staleList.innerHTML = '<strong>All good.</strong> Every Hijack tab is producing frames.';
      el.staleList.style.display = 'block';
      setTimeout(() => { el.staleList.style.display = 'none'; }, 3500);
    }
  });
}
if (el.reloadStale) {
  el.reloadStale.addEventListener('click', async () => {
    if (lastStaleIds.length === 0) return;
    if (!confirm(`Reload ${lastStaleIds.length} stale tab(s)? Any in-progress decision on those tables will be interrupted.`)) return;
    el.reloadStale.disabled = true;
    const resp = await new Promise((res) => {
      chrome.runtime.sendMessage({ [RELAY_NS]: 1, kind: 'popup_reload_stale_tabs', tabIds: lastStaleIds }, (r) => {
        if (chrome.runtime.lastError) res(null); else res(r);
      });
    });
    el.reloadStale.disabled = false;
    el.reloadStale.style.display = 'none';
    el.staleList.style.display = 'none';
    el.copyDebugStatus.textContent = `reloaded ${resp ? resp.reloaded : 0} tab(s)`;
    setTimeout(() => { el.copyDebugStatus.textContent = ''; }, 3000);
  });
}

// ─── Debug snapshot (v0.4.8) ──────────────────────────────────────
if (el.copyDebug) {
  el.copyDebug.addEventListener('click', async () => {
    el.copyDebug.disabled = true;
    el.copyDebugStatus.textContent = 'fetching…';
    const resp = await new Promise((res) => {
      chrome.runtime.sendMessage({ [RELAY_NS]: 1, kind: 'popup_debug_snapshot' }, (r) => {
        if (chrome.runtime.lastError) res({ ok: false, error: chrome.runtime.lastError.message });
        else res(r);
      });
    });
    if (!resp || !resp.ok) {
      el.copyDebugStatus.textContent = 'failed: ' + ((resp && resp.error) || 'no response');
      el.copyDebug.disabled = false;
      return;
    }
    const json = JSON.stringify(resp.snapshot, null, 2);
    try {
      await navigator.clipboard.writeText(json);
      const kb = (json.length / 1024).toFixed(1);
      el.copyDebugStatus.textContent = `copied ${kb} KB · ${resp.snapshot.ringBuffer.length} log lines`;
    } catch (e) {
      el.copyDebugStatus.textContent = 'clipboard blocked: ' + e.message;
    }
    el.copyDebug.disabled = false;
  });
}

loadInitial();
loadStage();
