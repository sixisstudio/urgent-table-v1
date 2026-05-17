// Urgent Table — Stealth-hardened WebSocket proxy (MAIN world)
//
// Mirror of Hijack Logger's ws_proxy.js with its own namespace so the two
// extensions can run side-by-side without colliding. If Logger loads first,
// its PatchedWebSocket becomes Urgent Table's "original" — frames cascade
// through both proxies, which is fine since neither rejects double-patching.
//
// HARDENING (same spec as Logger):
//   1. Originals stashed in closure before any patching.
//   2. Per-function masked toString returns native-code string.
//   3. Property descriptors preserved.
//   4. No leaks via constructor / Symbol.toStringTag / prototype.constructor.
//   5. No DOM mutations, no extra network requests, single namespaced relay.

(() => {
  'use strict';

  if (window.__ut_v1_proxy_installed__) return;
  Object.defineProperty(window, '__ut_v1_proxy_installed__', {
    value: true, writable: false, configurable: false, enumerable: false
  });

  const _Orig = {
    WebSocket: window.WebSocket,
    send: WebSocket.prototype.send,
    addEventListener: WebSocket.prototype.addEventListener,
    removeEventListener: WebSocket.prototype.removeEventListener,
    onmessageDesc: Object.getOwnPropertyDescriptor(WebSocket.prototype, 'onmessage'),
    sendDesc: Object.getOwnPropertyDescriptor(WebSocket.prototype, 'send'),
    fnToString: Function.prototype.toString,
    objectDefineProperty: Object.defineProperty,
    postMessage: window.postMessage.bind(window),
    Date_now: Date.now.bind(Date),
  };

  const _toStringMap = new WeakMap();
  function makeNativeToString(displayName) { return `function ${displayName}() { [native code] }`; }

  function maskFunction(patchedFn, originalFn, displayName) {
    _toStringMap.set(patchedFn, makeNativeToString(displayName || originalFn.name || 'anonymous'));
    _Orig.objectDefineProperty(patchedFn, 'toString', {
      value: function toString() { return _toStringMap.get(this) || _Orig.fnToString.call(this); },
      writable: true, configurable: true, enumerable: false
    });
    const ts = patchedFn.toString;
    _toStringMap.set(ts, makeNativeToString('toString'));
    _Orig.objectDefineProperty(ts, 'toString', {
      value: function toString() { return _toStringMap.get(this) || _Orig.fnToString.call(this); },
      writable: true, configurable: true, enumerable: false
    });
    try {
      _Orig.objectDefineProperty(patchedFn, 'name', {
        value: displayName || originalFn.name, configurable: true, writable: false
      });
    } catch (e) { /* swallow */ }
  }

  const RELAY_NS = '__ut_v1__';

  function safeUrl(url) {
    if (typeof url !== 'string') return '';
    const q = url.indexOf('?');
    return q === -1 ? url : url.slice(0, q);
  }

  function encodeData(data) {
    if (typeof data === 'string') return { type: 'string', value: data };
    if (data instanceof ArrayBuffer) {
      const bytes = new Uint8Array(data);
      let bin = '';
      for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
      return { type: 'arraybuffer', value: btoa(bin), byteLength: bytes.length };
    }
    if (data && data.constructor && data.constructor.name === 'Blob') {
      return { type: 'blob', size: data.size, _blob: data };
    }
    return { type: 'unknown', value: null };
  }

  function relay(kind, payload) {
    try {
      _Orig.postMessage({ [RELAY_NS]: 1, kind, t: _Orig.Date_now(), ...payload }, '*');
    } catch (e) { /* swallow */ }
  }

  // Patch send (outbound) — we don't use it in v0.1.0 detection-only, but
  // increment 3 (fast-clear via outgoing action frame) will, so the hook
  // ships now to avoid a second prototype-patch churn later.
  const patchedSend = function send(data) {
    try {
      const url = safeUrl(this.url);
      const enc = encodeData(data);
      if (enc.type === 'blob') {
        enc._blob.arrayBuffer().then(buf => {
          relay('frame', { dir: 'out', url, data: encodeData(buf) });
        }).catch(() => {});
      } else {
        relay('frame', { dir: 'out', url, data: enc });
      }
    } catch (e) {}
    return _Orig.send.call(this, data);
  };
  maskFunction(patchedSend, _Orig.send, 'send');
  _Orig.objectDefineProperty(WebSocket.prototype, 'send', {
    value: patchedSend,
    writable: _Orig.sendDesc.writable,
    enumerable: _Orig.sendDesc.enumerable,
    configurable: _Orig.sendDesc.configurable,
  });

  // Patch addEventListener (inbound)
  const patchedAddListener = function addEventListener(type, listener, options) {
    if (type === 'message' && typeof listener === 'function') {
      const url = this.url;
      const wrapped = function wrapped(ev) {
        try {
          const enc = encodeData(ev.data);
          if (enc.type === 'blob') {
            enc._blob.arrayBuffer().then(buf => {
              relay('frame', { dir: 'in', url: safeUrl(url), data: encodeData(buf) });
            }).catch(() => {});
          } else {
            relay('frame', { dir: 'in', url: safeUrl(url), data: enc });
          }
        } catch (e) {}
        return listener.call(this, ev);
      };
      maskFunction(wrapped, listener, listener.name || 'anonymous');
      return _Orig.addEventListener.call(this, type, wrapped, options);
    }
    return _Orig.addEventListener.call(this, type, listener, options);
  };
  maskFunction(patchedAddListener, _Orig.addEventListener, 'addEventListener');
  _Orig.objectDefineProperty(WebSocket.prototype, 'addEventListener', {
    value: patchedAddListener,
    writable: true, enumerable: false, configurable: true,
  });

  // Patch onmessage setter
  if (_Orig.onmessageDesc && _Orig.onmessageDesc.set && _Orig.onmessageDesc.get) {
    const origOnMessageSet = _Orig.onmessageDesc.set;
    const origOnMessageGet = _Orig.onmessageDesc.get;
    _Orig.objectDefineProperty(WebSocket.prototype, 'onmessage', {
      configurable: _Orig.onmessageDesc.configurable,
      enumerable: _Orig.onmessageDesc.enumerable,
      get: origOnMessageGet,
      set: function (fn) {
        if (typeof fn === 'function') {
          const url = this.url;
          const wrapped = function wrapped(ev) {
            try {
              const enc = encodeData(ev.data);
              if (enc.type === 'blob') {
                enc._blob.arrayBuffer().then(buf => {
                  relay('frame', { dir: 'in', url: safeUrl(url), data: encodeData(buf) });
                }).catch(() => {});
              } else {
                relay('frame', { dir: 'in', url: safeUrl(url), data: enc });
              }
            } catch (e) {}
            return fn.call(this, ev);
          };
          maskFunction(wrapped, fn, fn.name || 'anonymous');
          return origOnMessageSet.call(this, wrapped);
        }
        return origOnMessageSet.call(this, fn);
      }
    });
  }

  // Wrap WebSocket constructor
  const _OrigWS = _Orig.WebSocket;
  function PatchedWebSocket(url, protocols) {
    let ws;
    if (protocols === undefined) {
      ws = new _OrigWS(url);
    } else {
      ws = new _OrigWS(url, protocols);
    }
    try {
      relay('socket_open', { url: safeUrl(typeof url === 'string' ? url : url.toString()) });
    } catch (e) {}
    return ws;
  }
  maskFunction(PatchedWebSocket, _OrigWS, 'WebSocket');
  _Orig.objectDefineProperty(PatchedWebSocket, 'name', { value: 'WebSocket', configurable: true });
  PatchedWebSocket.prototype = _OrigWS.prototype;
  try {
    _Orig.objectDefineProperty(WebSocket.prototype, 'constructor', {
      value: PatchedWebSocket,
      writable: true, enumerable: false, configurable: true,
    });
  } catch (e) {}
  ['CONNECTING', 'OPEN', 'CLOSING', 'CLOSED'].forEach(k => {
    try {
      _Orig.objectDefineProperty(PatchedWebSocket, k, {
        value: _OrigWS[k], writable: false, enumerable: true, configurable: false
      });
    } catch (e) {}
  });
  _Orig.objectDefineProperty(window, 'WebSocket', {
    value: PatchedWebSocket,
    writable: true, enumerable: true, configurable: true,
  });

  relay('proxy_installed', { v: '0.1.0' });
})();
