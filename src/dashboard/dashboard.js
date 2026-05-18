// Urgent Table — Live dashboard (v0.4.14)
//
// Mirrors Hijack Logger's dashboard structure. Tab bar at top lets
// the user flip between the two dashboards in the same browser tab.

const RELAY_NS = '__ut_v1__';
const POLL_MS = 1000;

const el = {
  banners: document.getElementById('banners'),
  clock: document.getElementById('clock'),
  pulse: document.getElementById('pulse'),
  queueLen: document.getElementById('queueLen'),
  trackedTabs: document.getElementById('trackedTabs'),
  trackedTables: document.getElementById('trackedTables'),
  urgentCount: document.getElementById('urgentCount'),
  stagedFlag: document.getElementById('stagedFlag'),
  heroGuid: document.getElementById('heroGuid'),
  queueGrid: document.getElementById('queueGrid'),
  tableGrid: document.getElementById('tableGrid'),
  stageRect: document.getElementById('stageRect'),
  stageDisp: document.getElementById('stageDisp'),
  currentStage: document.getElementById('currentStage'),
  bootedAt: document.getElementById('bootedAt'),
  enabledCb: document.getElementById('enabledCb'),
  autoReloadCb: document.getElementById('autoReloadCb'),
  rescanTabs: document.getElementById('rescanTabs'),
  reloadStale: document.getElementById('reloadStale'),
  copyDebug: document.getElementById('copyDebug'),
  actionStatus: document.getElementById('actionStatus'),
  staleList: document.getElementById('staleList'),
  eventLog: document.getElementById('eventLog'),
  tabHJK: document.getElementById('tabHJK'),
  tabUT: document.getElementById('tabUT'),
};

let latest = null;
let latestSnap = null;

function send(kind, extra) {
  return new Promise((res) => {
    chrome.runtime.sendMessage({ [RELAY_NS]: 1, kind, ...(extra || {}) }, (r) => {
      if (chrome.runtime.lastError) res(null); else res(r);
    });
  });
}

function fmtAge(ts) {
  if (!ts) return 'never';
  const s = Math.floor((Date.now() - ts) / 1000);
  if (s < 60) return s + 's';
  if (s < 3600) return Math.floor(s / 60) + 'm' + (s % 60) + 's';
  return Math.floor(s / 3600) + 'h' + Math.floor((s % 3600) / 60) + 'm';
}

function fmtAbsTime(ts) {
  if (!ts) return '—';
  return new Date(ts).toLocaleString();
}

function render(state, snap) {
  if (!state) return;

  // Banners
  const banners = [];
  // (UT has fewer top-level health signals than HJK; reserved for future)
  el.banners.innerHTML = banners.map(b => `<div class="banner ${b.cls}">${b.html}</div>`).join('');

  // Metrics
  const queue = state.queue || [];
  el.queueLen.textContent = queue.length;
  const tabs = state.tabs || [];
  el.trackedTabs.textContent = tabs.length;
  let tablesTotal = 0;
  let urgentTotal = 0;
  for (const t of tabs) {
    tablesTotal += (t.tables || []).length;
    for (const ts of (t.tables || [])) if (ts.urgent) urgentTotal++;
  }
  el.trackedTables.textContent = tablesTotal;
  el.urgentCount.textContent = urgentTotal;
  el.stagedFlag.textContent = state.stage ? `T${state.stage.gameID}` : 'none';
  el.heroGuid.textContent = state.heroGUID
    ? state.heroGUID.slice(0, 8) + '…'
    : (snap && snap.heroGUID ? snap.heroGUID : '—');

  // Settings checkboxes
  if (state.settings) {
    el.enabledCb.checked = !!state.settings.enabled;
    el.autoReloadCb.checked = !!state.settings.autoReloadStale;
  }

  // Queue
  if (queue.length === 0) {
    el.queueGrid.innerHTML = '<div class="empty">No tables waiting on you.</div>';
  } else {
    el.queueGrid.innerHTML = '';
    queue.forEach((q, i) => {
      const div = document.createElement('div');
      div.className = 'row-card urgent';
      const ageMs = Date.now() - (q.urgentSince || Date.now());
      div.innerHTML = `
        <span class="gid"><span class="health-dot health-urgent"></span>#${i + 1} · table ${q.gameID}</span>
        <span class="meta">urgent ${fmtAge(q.urgentSince)}</span>
      `;
      el.queueGrid.appendChild(div);
    });
  }

  // All tables (one row per unique gameID, with tab count)
  const byGameID = new Map();
  for (const t of tabs) {
    for (const ts of (t.tables || [])) {
      const cur = byGameID.get(ts.gameID);
      if (!cur) byGameID.set(ts.gameID, { entry: ts, tabIds: [t.tabId] });
      else {
        cur.tabIds.push(t.tabId);
        // prefer urgent/hero-seat entries for display
        if ((ts.urgent && !cur.entry.urgent) || (ts.heroSeat && !cur.entry.heroSeat)) {
          cur.entry = ts;
        }
      }
    }
  }
  if (byGameID.size === 0) {
    el.tableGrid.innerHTML = '<div class="empty">No tables.</div>';
  } else {
    el.tableGrid.innerHTML = '';
    const rows = Array.from(byGameID.values()).sort((a, b) => a.entry.gameID - b.entry.gameID);
    for (const { entry, tabIds } of rows) {
      const div = document.createElement('div');
      div.className = 'row-card' + (entry.urgent ? ' urgent' : '');
      const dot = entry.urgent ? 'health-urgent' : (entry.heroSeat ? 'health-green' : 'health-yellow');
      const tabSuffix = tabIds.length > 1 ? ` <span style="opacity:.6">(${tabIds.length} tabs)</span>` : '';
      div.innerHTML = `
        <span class="gid"><span class="health-dot ${dot}"></span>T${entry.gameID} · hand ${entry.handNo || '?'}${tabSuffix}</span>
        <span class="meta">${entry.heroSeat ? 'hero seat ' + entry.heroSeat : 'spectator'} · last ${fmtAge(entry.lastSnapshotAt)}</span>
      `;
      el.tableGrid.appendChild(div);
    }
  }

  // Stage
  const rect = state.stageRect || (snap && snap.stageRect);
  if (rect && typeof rect.width === 'number') {
    el.stageRect.textContent = `${rect.width}×${rect.height} @ (${rect.left}, ${rect.top})`;
    el.stageRect.className = 'output-value ok';
    el.stageDisp.textContent = rect.displayId != null ? String(rect.displayId).slice(0, 12) : '—';
  } else {
    el.stageRect.textContent = 'not set';
    el.stageRect.className = 'output-value bad';
    el.stageDisp.textContent = '—';
  }
  if (state.stage) {
    el.currentStage.textContent = `tab=${state.stage.tabId} table=${state.stage.gameID}`;
    el.currentStage.className = 'output-value ok';
  } else {
    el.currentStage.textContent = '—';
    el.currentStage.className = 'output-value';
  }
  if (snap && snap.bootedAt) el.bootedAt.textContent = fmtAbsTime(snap.bootedAt);

  // Event log
  if (snap && snap.ringBuffer) {
    const last60 = snap.ringBuffer.slice(-60);
    el.eventLog.innerHTML = last60.map(e => {
      const time = new Date(e.t).toLocaleTimeString();
      const cls = e.level === 'warn' ? 'log-warn' : e.level === 'error' ? 'log-error' : '';
      const safe = (e.msg || '').replace(/</g, '&lt;').replace(/>/g, '&gt;');
      return `<span class="${cls}">${time}  ${safe}</span>`;
    }).join('\n');
    el.eventLog.scrollTop = el.eventLog.scrollHeight;
  }
}

async function tick() {
  el.clock.textContent = new Date().toLocaleTimeString();
  el.pulse.classList.add('pulse');
  setTimeout(() => el.pulse.classList.remove('pulse'), 150);

  const stateResp = await send('popup_get_state');
  const snapResp = await send('popup_debug_snapshot');
  latest = stateResp && stateResp.state;
  latestSnap = snapResp && snapResp.snapshot;
  render(latest, latestSnap);
}

// Settings handlers
el.enabledCb.addEventListener('change', () => {
  send('popup_set_enabled', { value: el.enabledCb.checked });
});
el.autoReloadCb.addEventListener('change', () => {
  send('popup_set_auto_reload', { value: el.autoReloadCb.checked });
});

// Rescan + reload
let lastStaleIds = [];
el.rescanTabs.addEventListener('click', async () => {
  el.rescanTabs.disabled = true;
  el.actionStatus.textContent = 're-injecting + waiting 5s for frames…';
  el.staleList.style.display = 'none';
  el.reloadStale.style.display = 'none';
  const resp = await send('popup_rescan_tabs');
  el.rescanTabs.disabled = false;
  if (!resp || !resp.ok) { el.actionStatus.textContent = 'rescan failed'; return; }
  el.actionStatus.textContent = `re-injected ${resp.injected}/${resp.scanned} tab(s)`;
  if (resp.stale && resp.stale.length > 0) {
    lastStaleIds = resp.stale.map(s => s.tabId);
    const items = resp.stale.map(s => `<li>Tab #${s.tabId} (${s.reason || 'stale'}) — ${(s.title || 'no title').slice(0, 60)}</li>`).join('');
    el.staleList.innerHTML = `<strong>${resp.stale.length} stale tab(s).</strong> Reload to fix:<ul>${items}</ul>`;
    el.staleList.style.display = 'block';
    el.reloadStale.textContent = `Reload ${resp.stale.length} stale tabs`;
    el.reloadStale.style.display = '';
  } else {
    lastStaleIds = [];
    el.staleList.innerHTML = '<strong>All good.</strong> Every Hijack tab is producing frames.';
    el.staleList.style.display = 'block';
    setTimeout(() => { el.staleList.style.display = 'none'; }, 3500);
  }
});

el.reloadStale.addEventListener('click', async () => {
  if (lastStaleIds.length === 0) return;
  if (!confirm(`Reload ${lastStaleIds.length} stale tab(s)? In-progress decisions on those tables will be interrupted.`)) return;
  el.reloadStale.disabled = true;
  const resp = await send('popup_reload_stale_tabs', { tabIds: lastStaleIds });
  el.reloadStale.disabled = false;
  el.reloadStale.style.display = 'none';
  el.staleList.style.display = 'none';
  el.actionStatus.textContent = `reloaded ${resp ? resp.reloaded : 0} tab(s)`;
  setTimeout(() => el.actionStatus.textContent = '', 4000);
});

el.copyDebug.addEventListener('click', async () => {
  el.copyDebug.disabled = true;
  el.actionStatus.textContent = 'fetching…';
  const resp = await send('popup_debug_snapshot');
  if (!resp || !resp.ok) { el.actionStatus.textContent = 'fetch failed'; el.copyDebug.disabled = false; return; }
  const json = JSON.stringify(resp.snapshot, null, 2);
  try {
    await navigator.clipboard.writeText(json);
    el.actionStatus.textContent = `copied ${(json.length / 1024).toFixed(1)} KB`;
  } catch (e) {
    el.actionStatus.textContent = 'clipboard blocked';
  }
  el.copyDebug.disabled = false;
  setTimeout(() => el.actionStatus.textContent = '', 3000);
});

// Cross-extension tab bar: locate the other extension's dashboard URL.
async function wireTabBar() {
  if (!chrome.management || !chrome.management.getAll) {
    el.tabHJK.classList.add('disabled');
    el.tabHJK.title = 'management permission unavailable';
    return;
  }
  try {
    const all = await chrome.management.getAll();
    const hjk = all.find(e =>
      e.id !== chrome.runtime.id &&
      /hijack/i.test(e.name) && /logger|hh|history/i.test(e.name)
    );
    if (hjk) {
      el.tabHJK.href = `chrome-extension://${hjk.id}/src/dashboard/dashboard.html`;
    } else {
      el.tabHJK.classList.add('disabled');
      el.tabHJK.title = 'Hijack Logger extension not installed';
    }
  } catch (e) {
    el.tabHJK.classList.add('disabled');
    el.tabHJK.title = 'cross-extension lookup failed: ' + e.message;
  }
}

tick();
setInterval(tick, POLL_MS);
wireTabBar();
