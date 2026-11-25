// Coordinates the capture: popup -> background -> offscreen document (where the audio is processed).

const OFFSCREEN = 'offscreen.html';

async function ensureOffscreen() {
  const existing = await chrome.runtime.getContexts({ contextTypes: ['OFFSCREEN_DOCUMENT'] });
  if (existing.length) return;
  await chrome.offscreen.createDocument({
    url: OFFSCREEN,
    reasons: ['USER_MEDIA'],
    justification: 'Process the tab audio live to remove hum and hiss and boost the voice.',
  });
}

async function setBadge(tabId, on) {
  try {
    await chrome.action.setBadgeText({ tabId, text: on ? 'ON' : '' });
    if (on) {
      await chrome.action.setBadgeBackgroundColor({ tabId, color: '#996600' });
      await chrome.action.setBadgeTextColor({ tabId, color: '#ffffff' });
    }
  } catch (e) { /* tab may be gone */ }
}

async function stopCapture() {
  const { tabId } = await chrome.storage.session.get('tabId');
  try { await chrome.runtime.sendMessage({ target: 'offscreen', type: 'stop' }); } catch (e) {}
  if (tabId !== undefined) await setBadge(tabId, false);
  await chrome.storage.session.remove(['tabId', 'bypass']);
}

async function startCapture(tabId, streamId) {
  await stopCapture();
  await ensureOffscreen();
  const settings = await chrome.storage.local.get({ hiss: 75, boost: 3 });
  const res = await chrome.runtime.sendMessage({ target: 'offscreen', type: 'start', streamId, settings });
  if (!res || !res.ok) throw new Error((res && res.error) || 'Could not start audio processing');
  await chrome.storage.session.set({ tabId, bypass: false });
  await setBadge(tabId, true);
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.target !== 'background') return;
  (async () => {
    if (msg.type === 'start') await startCapture(msg.tabId, msg.streamId);
    else if (msg.type === 'stop') await stopCapture();
    else if (msg.type === 'ended') await stopCapture(); // tab closed or capture ended
    sendResponse({ ok: true });
  })().catch((e) => sendResponse({ ok: false, error: String((e && e.message) || e) }));
  return true;
});

chrome.tabs.onRemoved.addListener(async (closedId) => {
  const { tabId } = await chrome.storage.session.get('tabId');
  if (tabId === closedId) await stopCapture();
});
