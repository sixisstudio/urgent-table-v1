// Urgent Table — Page <-> Service Worker relay (ISOLATED world)
//
// Bridges window.postMessage from the MAIN-world ws_proxy to the service
// worker via a long-lived chrome.runtime port. Mirror of Hijack Logger's
// relay.js with its own namespace so the two extensions don't collide.

(() => {
  'use strict';

  // v0.2.1: guard against double-injection. The SW programmatically re-injects
  // this script into existing Hijack tabs on every boot so users don't have
  // to refresh after reloading the extension; that means an extension reload
  // can leave the previous instance's port + listener still alive when this
  // copy runs. Without the guard we'd get duplicate frame forwarding.
  if (window.__ut_v1_relay_installed__) return;
  Object.defineProperty(window, '__ut_v1_relay_installed__', {
    value: true, writable: false, configurable: false, enumerable: false,
  });

  const RELAY_NS = '__ut_v1__';
  const PORT_NAME = 'ut-relay';

  let port = null;
  let droppedCount = 0;
  let lastDropReport = 0;
  let reconnectTimer = null;

  function openPort() {
    try {
      port = chrome.runtime.connect({ name: PORT_NAME });
      port.onDisconnect.addListener(() => {
        port = null;
        if (reconnectTimer) return;
        reconnectTimer = setTimeout(() => {
          reconnectTimer = null;
          openPort();
        }, 1000);
      });
      port.postMessage({ [RELAY_NS]: 1, kind: 'relay_loaded', t: Date.now() });
    } catch (e) {
      port = null;
      droppedCount++;
    }
  }

  function send(msg) {
    if (!port) {
      droppedCount++;
      openPort();
      return;
    }
    try {
      port.postMessage(msg);
    } catch (e) {
      droppedCount++;
      port = null;
      openPort();
    }
  }

  openPort();

  window.addEventListener('message', (ev) => {
    if (ev.source !== window) return;
    const msg = ev.data;
    if (!msg || msg[RELAY_NS] !== 1) return;
    send(msg);
    const now = Date.now();
    if (droppedCount > 0 && now - lastDropReport > 30000) {
      lastDropReport = now;
      send({ [RELAY_NS]: 1, kind: 'relay_drops', count: droppedCount, t: now });
      droppedCount = 0;
    }
  }, false);
})();
