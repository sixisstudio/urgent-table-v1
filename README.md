# Urgent Table

Chrome MV3 extension that detects which open Hijack Poker table currently requires the hero's action and (in later increments) brings it into a fixed-position stage window on screen so multi-tabling pilots can keep their eyes on one spot.

Built as a SIBLING extension to [`cash-review-v1`](https://github.com/sixisstudio/cash-review-v1) (the hand-history logger), NOT folded into it — so a bug in one cannot break the other. Both can be installed and run simultaneously; their WebSocket proxies use separate namespaces and layer harmlessly.

## Status: v0.1.0 (increment 1 of 4) — detection-only

This build proves the detection signal works end-to-end. There is **no popup UI, no queue, no window-moving**. When loaded, it injects its own MAIN-world WebSocket proxy on `game.hijack.poker`, parses every `gotOmaha` snapshot, and logs to the service-worker console whenever a tab transitions urgent ON / urgent OFF.

To verify:
1. `chrome://extensions` → Developer mode → Load unpacked → point at this folder.
2. Open `chrome://extensions` → click "service worker" under Urgent Table → open the console of the new DevTools window that appears.
3. Open a Hijack table and sit at a seat. When it becomes your turn you should see:
   ```
   [ut] URGENT ON  tab=NNN table=NNN (hand H, seat S)
   ```
   When you act:
   ```
   [ut] URGENT OFF tab=NNN table=NNN (actor now seat X)
   ```

## Roadmap

- **v0.1.0** — detection + console logging (this build).
- **v0.2.0** — FIFO queue + popup with live queue preview + "Set stage position" UI.
- **v0.3.0** — outgoing-frame fast-clear (decode opcode, gate on whitelisted action types, idempotent with snapshot fallback).
- **v0.4.0** — window-move staging (the disruptive part): when a tab goes urgent, snap its entire window to the configured stage rect; restore on act-complete. Two-step state transitions, `displayId` tracking, multi-monitor support, full `chrome.storage.session` persistence.

## Architecture (high level)

- `src/background/ws_proxy.js` — MAIN-world stealth-hardened WebSocket prototype patch, mirror of Logger's with namespace `__ut_v1__` so the two extensions don't collide.
- `src/content/relay.js` — ISOLATED-world relay that bridges MAIN-world `postMessage` envelopes to the service worker over a long-lived `chrome.runtime` port.
- `src/background/service_worker.js` — receives frames, filters for `gotOmaha`, extracts `game.move` (current actor seat) and the hero seat (the seat with real face-up cards), emits urgent transitions.
- `src/lib/card_codec.js` — `isRealCard` helper, copied from Logger.

## Design notes

The architecture was vetted by a 3-brain council poll (DeepSeek + ChatGPT + Claude.ai) — see commit messages and `cash-review-v1`'s own design notes for the convergence rationale. Key invariants:

- **Never `tabs.move` or `windows.create({tabId})` after a table is loaded.** Both detach the WebContents and tear down the Unity/WebGL canvas plus the WebSocket session. The stage mechanism in v0.4.0 will use `chrome.windows.update` with the existing window's `windowId` instead, which keeps the renderer attached.
- **One Hijack table per Chrome window** will be a soft constraint enforced by warning, not by auto-popping (which would itself be a detach).
- **All persistent state goes to `chrome.storage.session` on every mutation**, because MV3 service workers can be evicted at any moment and the alarm-driven keepalive is not reliable.
