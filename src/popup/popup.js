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
  const tabStarted = new Map();
  for (const t of latest.tabs || []) {
    tabStarted.set(t.tabId, t.startedAt);
    for (const ts of (t.tables || [])) {
      tableLookup.set(`${t.tabId}:${ts.gameID}`, { tabId: t.tabId, ...ts });
    }
  }

  // Queue list
  el.queueList.innerHTML = '';
  if (!latest.queue || latest.queue.length === 0) {
    const li = document.createElement('li');
    li.className = 'empty';
    li.textContent = 'No tables waiting on you.';
    el.queueList.appendChild(li);
  } else {
    const now = Date.now();
    latest.queue.forEach((q, i) => {
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

  // All known tables
  el.tableList.innerHTML = '';
  const allTables = Array.from(tableLookup.values());
  if (allTables.length === 0) {
    const li = document.createElement('li');
    li.className = 'empty';
    li.textContent = 'No Hijack tabs detected. Open a table to start.';
    el.tableList.appendChild(li);
  } else {
    allTables.sort((a, b) => a.gameID - b.gameID);
    for (const ts of allTables) {
      const li = document.createElement('li');
      const label = document.createElement('span');
      label.className = 'label';
      const dotClass = ts.urgent ? 'urgent' : 'idle';
      label.innerHTML = `<span class="dot ${dotClass}"></span>table ${ts.gameID}${ts.handNo ? ' · hand ' + ts.handNo : ''}`;
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

loadInitial();
loadStage();
