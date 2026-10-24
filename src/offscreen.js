// Adaptive Video Downloader — offscreen host (Chrome MV3).
//
// Offscreen documents only get chrome.runtime, so the engine's privileged
// outputs travel to the service worker as messages:
//   progress → avd:engine:state      save    → avd:engine:save (chrome.downloads)
//   headers  → avd:engine:headers    history → avd:engine:finished
// Commands arrive as avd:engine:cmd and are acked so the worker knows we're up.
const api = globalThis.browser ?? globalThis.chrome;
const send = (msg) => api.runtime.sendMessage(msg).catch(() => null);

AVD_Engine.onState = (state) => send({ type: 'avd:engine:state', state });
AVD_Engine.onSave = (url, filename, saveAs) =>
  send({ type: 'avd:engine:save', url, filename, saveAs }).then((r) => r || { ok: false });
AVD_Engine.onHeaders = (headers) => send({ type: 'avd:engine:headers', headers });
AVD_Engine.onFinished = (record) => send({ type: 'avd:engine:finished', record });

api.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || msg.type !== 'avd:engine:cmd') return false;
  sendResponse({ ack: true });
  AVD_Engine.handleCommand(msg.cmd);
  return false;
});
