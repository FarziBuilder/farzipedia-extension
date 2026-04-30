// FarziPedia popup — UI for the foolproof background pipeline.

import { BUILTIN_API_KEY } from '../lib/config.js';

const $ = (id) => document.getElementById(id);

const ui = {
  states: {
    idle:    $('state-idle'),
    running: $('state-running'),
    error:   $('state-error'),
  },
  notOnYoutube: $('not-on-youtube'),
  videoSummary: $('video-summary'),
  videoTitle:   $('video-title'),
  videoChannel: $('video-channel'),
  videoDuration:$('video-duration'),
  generateBtn:  $('generate-btn'),
  keyStatus:    $('key-status'),
  apiKey:       $('api-key'),
  showKey:      $('show-key'),
  saveKey:      $('save-key'),
  clearKey:     $('clear-key'),
  saveMsg:      $('save-msg'),
  bar:          $('bar'),
  status:       $('status'),
  elapsed:      $('elapsed'),
  warnings:     $('warnings'),
  errorMsg:     $('error-msg'),
  retryBtn:     $('retry-btn'),
};

function show(state) {
  for (const [k, el] of Object.entries(ui.states)) {
    el.classList.toggle('hidden', k !== state);
  }
}

function fmtSeconds(s) {
  s = Math.max(0, Math.round(s || 0));
  const m = Math.floor(s / 60);
  return `${m}:${(s % 60).toString().padStart(2, '0')}`;
}

const HAS_BUILTIN = !!(BUILTIN_API_KEY || '').trim();

// ---------- API key handling ----------

ui.showKey.addEventListener('change', () => {
  ui.apiKey.type = ui.showKey.checked ? 'text' : 'password';
});

(async () => {
  const { anthropicApiKey } = await chrome.storage.sync.get('anthropicApiKey');
  if (anthropicApiKey) ui.apiKey.value = anthropicApiKey;
})();

ui.saveKey.addEventListener('click', async () => {
  const key = ui.apiKey.value.trim();
  if (!key) { ui.saveMsg.textContent = 'Paste a key first.'; return; }
  if (!key.startsWith('sk-ant-')) {
    ui.saveMsg.textContent = "Doesn't look like an Anthropic key (sk-ant-…).";
    return;
  }
  await chrome.storage.sync.set({ anthropicApiKey: key });
  ui.saveMsg.textContent = 'Saved.';
  setTimeout(() => { ui.saveMsg.textContent = ''; }, 1800);
  await initIdle();
});

ui.clearKey.addEventListener('click', async () => {
  await chrome.storage.sync.remove('anthropicApiKey');
  ui.apiKey.value = '';
  ui.saveMsg.textContent = HAS_BUILTIN ? 'Cleared. Falling back to built-in key.' : 'Cleared.';
  setTimeout(() => { ui.saveMsg.textContent = ''; }, 2200);
  await initIdle();
});

// ---------- Idle state ----------

async function getActiveTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab;
}

async function initIdle() {
  show('idle');
  const tab = await getActiveTab();
  const onWatch = tab && /^https:\/\/www\.youtube\.com\/watch\b/.test(tab.url || '');

  ui.notOnYoutube.classList.toggle('hidden', onWatch);
  ui.videoSummary.classList.toggle('hidden', !onWatch);

  // Key status
  const { anthropicApiKey } = await chrome.storage.sync.get('anthropicApiKey');
  const userKey = (anthropicApiKey || '').trim();
  if (userKey) {
    ui.keyStatus.textContent = '✓ using your saved key';
    ui.keyStatus.className = 'key-status ok';
  } else if (HAS_BUILTIN) {
    ui.keyStatus.textContent = '✓ using built-in key';
    ui.keyStatus.className = 'key-status ok';
  } else {
    ui.keyStatus.textContent = '⚠ no API key — set one below';
    ui.keyStatus.className = 'key-status warn';
  }

  if (!onWatch) {
    ui.generateBtn.disabled = true;
    return;
  }

  // Ask SW for video info (it reads via chrome.scripting in MAIN world)
  ui.videoTitle.textContent = 'reading…';
  ui.videoChannel.textContent = '';
  ui.videoDuration.textContent = '';

  try {
    const res = await chrome.runtime.sendMessage({ type: 'GET_VIDEO_INFO', tabId: tab.id });
    if (res?.ok) {
      const info = res.data;
      ui.videoTitle.textContent = info.title || '(no title)';
      ui.videoChannel.textContent = info.channel || '';
      ui.videoDuration.textContent = info.duration ? fmtSeconds(info.duration) : '';
      if (!info.hasCaptions) {
        ui.videoTitle.textContent += ' — no captions';
        ui.generateBtn.disabled = true;
        ui.generateBtn.title = 'This video has captions disabled.';
        return;
      }
      if (info.isLive) {
        ui.videoTitle.textContent += ' — livestream not supported';
        ui.generateBtn.disabled = true;
        return;
      }
    } else {
      ui.videoTitle.textContent = res?.error || '(could not read video)';
    }
  } catch (e) {
    ui.videoTitle.textContent = '(refresh the YouTube tab and reopen the popup)';
  }

  const hasAnyKey = !!userKey || HAS_BUILTIN;
  ui.generateBtn.disabled = !hasAnyKey;
  ui.generateBtn.title = hasAnyKey ? '' : 'Add a Claude API key first';
}

// ---------- Reattach if a job is already running ----------

async function maybeReattach() {
  const { __farzi_running } = await chrome.storage.local.get('__farzi_running');
  if (!__farzi_running) {
    await initIdle();
    return;
  }
  showRunning();
  applyState(__farzi_running);
  startListeningForProgress();
}

// ---------- Running state ----------

function showRunning() {
  show('running');
  ui.bar.style.width = '0%';
  ui.status.textContent = 'starting…';
  ui.elapsed.textContent = '0:00 elapsed';
  ui.warnings.innerHTML = '';
}

function applyState(s) {
  if (!s) return;
  ui.bar.style.width = `${Math.round((s.frac || 0) * 100)}%`;
  ui.status.textContent = s.message || '';
  ui.elapsed.textContent = `${fmtSeconds(s.elapsed)} elapsed`;
  ui.warnings.innerHTML = '';
  for (const w of (s.warnings || [])) {
    const li = document.createElement('li');
    li.textContent = w;
    ui.warnings.appendChild(li);
  }
}

let _port = null;
function startListeningForProgress() {
  if (_port) return;
  _port = chrome.runtime.connect({ name: 'progress' });
  _port.onMessage.addListener((msg) => {
    if (msg.type === 'progress') {
      ui.bar.style.width = `${Math.round(msg.frac * 100)}%`;
      ui.status.textContent = msg.message;
      ui.elapsed.textContent = `${fmtSeconds(msg.elapsed)} elapsed`;
    } else if (msg.type === 'meta') {
      // Could show more here; the running state already shows the title
    } else if (msg.type === 'warning') {
      const li = document.createElement('li');
      li.textContent = msg.message;
      ui.warnings.appendChild(li);
    } else if (msg.type === 'replay') {
      applyState(msg.state);
    } else if (msg.type === 'done') {
      ui.bar.style.width = '100%';
      ui.status.textContent = 'thy codex is ready';
      // SW also opens the result tab.
      setTimeout(() => window.close(), 700);
    } else if (msg.type === 'error') {
      ui.errorMsg.textContent = msg.message || 'unknown error';
      show('error');
    }
  });
  _port.onDisconnect.addListener(() => { _port = null; });
}

// ---------- Generate ----------

ui.generateBtn.addEventListener('click', async () => {
  const tab = await getActiveTab();
  if (!tab) return;
  showRunning();
  startListeningForProgress();
  await chrome.runtime.sendMessage({ type: 'START_JOB', tabId: tab.id });
});

ui.retryBtn.addEventListener('click', () => initIdle());

// ---------- boot ----------
maybeReattach();
