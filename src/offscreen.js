// Adaptive Video Downloader — offscreen host (Chrome MV3).
//
// Offscreen documents only get chrome.runtime, so this wires the engine's
// outputs to the service worker over messaging:
//   • progress  → { type:'avd:engine:state', state }  (SW mirrors it to storage)
//   • save file → { type:'avd:download', url, filename } (SW calls chrome.downloads)
// and feeds engine commands in from { type:'avd:engine:cmd', cmd }.
const api = globalThis.browser ?? globalThis.chrome;

AVD_Engine.onState = (state) => {
  api.runtime.sendMessage({ type: 'avd:engine:state', state }).catch(() => {});
};

AVD_Engine.onSave = (url, filename) =>
  api.runtime
    .sendMessage({ type: 'avd:download', url, filename })
    .then((r) => !!(r && r.ok))
    .catch(() => false);

api.runtime.onMessage.addListener((msg) => {
  if (msg && msg.type === 'avd:engine:cmd') {
    AVD_Engine.handleCommand(msg.cmd);
  }
});

// Tell the service worker we're alive so it can hand over any command that was
// queued while this document was still being created.
api.runtime.sendMessage({ type: 'avd:engine:ready' }).catch(() => {});
