// Urgent Table — Stage placeholder window
//
// This window is opened by the SW when the user clicks "Set stage position"
// in the extension popup. The user drags + resizes it to where they want
// every urgent table to be staged, then clicks Save. The SW reads the
// window's bounds, stores them to chrome.storage.local along with the
// displayId of whichever monitor the window is centered on, and closes
// the window.

const RELAY_NS = '__ut_v1__';

const saveBtn = document.getElementById('save');
const cancelBtn = document.getElementById('cancel');
const footnote = document.getElementById('footnote');

saveBtn.addEventListener('click', () => {
  saveBtn.disabled = true;
  cancelBtn.disabled = true;
  saveBtn.textContent = 'Saving…';
  chrome.runtime.sendMessage(
    { [RELAY_NS]: 1, kind: 'stage_placeholder_save' },
    (resp) => {
      if (chrome.runtime.lastError) {
        footnote.textContent = 'Save failed: ' + chrome.runtime.lastError.message;
        saveBtn.disabled = false; cancelBtn.disabled = false;
        saveBtn.textContent = 'Save this position';
        return;
      }
      if (resp && resp.ok) {
        // SW will close us; show a brief confirmation in case the close
        // takes a moment.
        footnote.textContent = `Saved: ${resp.stageRect.width}×${resp.stageRect.height} at (${resp.stageRect.left}, ${resp.stageRect.top}). Closing…`;
      } else {
        footnote.textContent = 'Save failed: ' + ((resp && resp.error) || 'unknown error');
        saveBtn.disabled = false; cancelBtn.disabled = false;
        saveBtn.textContent = 'Save this position';
      }
    }
  );
});

cancelBtn.addEventListener('click', () => {
  chrome.runtime.sendMessage(
    { [RELAY_NS]: 1, kind: 'stage_placeholder_cancel' },
    () => { /* SW closes us */ }
  );
});
