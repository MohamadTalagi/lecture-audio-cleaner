import { buildChain } from './dsp.js';

let ctx = null, stream = null, chain = null;

async function start(streamId, settings) {
  await stop();
  stream = await navigator.mediaDevices.getUserMedia({
    audio: { mandatory: { chromeMediaSource: 'tab', chromeMediaSourceId: streamId } },
    video: false,
  });
  ctx = new AudioContext({ latencyHint: 'interactive' });
  const source = ctx.createMediaStreamSource(stream);
  chain = await buildChain(ctx, source, chrome.runtime.getURL('denoise-worklet.js'), settings);
  chain.connect(ctx.destination); // capturing mutes the tab, so we play the cleaned audio back
  await ctx.resume();
  stream.getAudioTracks().forEach((t) => (t.onended = () => {
    chrome.runtime.sendMessage({ target: 'background', type: 'ended' }).catch(() => {});
  }));
}

async function stop() {
  if (chain) { chain.stop(); chain = null; }
  if (stream) { stream.getTracks().forEach((t) => t.stop()); stream = null; }
  if (ctx) { try { await ctx.close(); } catch (e) {} ctx = null; }
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.target !== 'offscreen') return;
  (async () => {
    if (msg.type === 'start') { await start(msg.streamId, msg.settings); sendResponse({ ok: true }); }
    else if (msg.type === 'stop') { await stop(); sendResponse({ ok: true }); }
    else if (msg.type === 'set') { if (chain) chain.set(msg.settings); sendResponse({ ok: true }); }
    else if (msg.type === 'bypass') { if (chain) chain.setEnabled(!msg.bypass, ctx.destination); sendResponse({ ok: true }); }
  })().catch((e) => sendResponse({ ok: false, error: String((e && e.message) || e) }));
  return true;
});
