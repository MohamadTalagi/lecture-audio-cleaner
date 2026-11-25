const $ = (id) => document.getElementById(id);
const statusEl = $('status'), mainBtn = $('main'), abBtn = $('ab');
const hiss = $('hiss'), boost = $('boost');

let tab = null, activeTabId, bypass = false;

const send = (msg) => chrome.runtime.sendMessage(msg).catch(() => null);

function setStatus(text, cls) { statusEl.textContent = text; statusEl.className = 'status' + (cls ? ' ' + cls : ''); }

function render() {
  const here = activeTabId !== undefined && activeTabId === tab.id;
  if (here) {
    setStatus(bypass ? 'Playing the ORIGINAL audio (for comparison)' : '● Cleaning this tab', bypass ? '' : 'on');
    mainBtn.textContent = 'Stop'; mainBtn.className = 'stop';
    abBtn.hidden = false; abBtn.textContent = bypass ? 'Back to cleaned audio' : 'Hear original (A/B)';
  } else {
    setStatus(activeTabId !== undefined ? 'Cleaning another tab. Start here to switch to this one.'
                                        : 'Removes hum & hiss and boosts the voice in this tab.');
    mainBtn.textContent = "Clean this tab's audio"; mainBtn.className = '';
    abBtn.hidden = true;
  }
}

function fill(el) { el.style.setProperty('--p', ((el.value - el.min) / (el.max - el.min)) * 100 + '%'); }
function showValues() {
  fill(hiss); fill(boost);
  $('hissV').textContent = hiss.value + '%';
  $('boostV').textContent = '+' + boost.value + ' dB';
}

async function init() {
  [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  const s = await chrome.storage.local.get({ hiss: 75, boost: 3 });
  hiss.value = s.hiss; boost.value = s.boost; showValues();
  const sess = await chrome.storage.session.get(['tabId', 'bypass']);
  activeTabId = sess.tabId; bypass = !!sess.bypass;
  render();
}

mainBtn.onclick = async () => {
  mainBtn.disabled = true;
  try {
    if (activeTabId === tab.id) {
      await send({ target: 'background', type: 'stop' });
      activeTabId = undefined;
    } else {
      setStatus('Starting…');
      // Must be requested from the popup click (user gesture) for the current tab.
      const streamId = await chrome.tabCapture.getMediaStreamId({ targetTabId: tab.id });
      const res = await send({ target: 'background', type: 'start', tabId: tab.id, streamId });
      if (!res || !res.ok) throw new Error((res && res.error) || 'Could not start');
      activeTabId = tab.id; bypass = false;
    }
    render();
  } catch (e) {
    const m = String(e.message || e);
    setStatus(/chrome:\/\/|Chrome pages|webstore/i.test(m) ? "Chrome doesn't allow this on its own pages. Open a normal web page." : 'Error: ' + m, 'err');
  } finally { mainBtn.disabled = false; }
};

abBtn.onclick = async () => {
  bypass = !bypass;
  await chrome.storage.session.set({ bypass });
  await send({ target: 'offscreen', type: 'bypass', bypass });
  render();
};

let t;
function onSlide() {
  showValues();
  const settings = { hiss: Number(hiss.value), boost: Number(boost.value) };
  send({ target: 'offscreen', type: 'set', settings });
  clearTimeout(t); t = setTimeout(() => chrome.storage.local.set(settings), 200);
}
hiss.oninput = onSlide; boost.oninput = onSlide;

init();
