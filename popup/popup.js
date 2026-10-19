// FarziPedia popup — UI for the foolproof background pipeline.

import { MODEL } from '../lib/analyzer.js';

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
  playlistBox:  $('playlist-box'),
  playlistUrl:  $('playlist-url'),
  playlistInfo: $('playlist-info'),
  playlistBtn:  $('playlist-btn'),
  lastrunBox:   $('lastrun-box'),
  lastrunBody:  $('lastrun-body'),
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

// ---------- API key handling ----------
// A key is optional: without one, generation goes through FarziPedia's
// server, which holds its own key.

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
  ui.saveMsg.textContent = "Cleared. Using FarziPedia's built-in key.";
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
  ui.keyStatus.textContent = userKey ? '✓ using your saved key' : "✓ using FarziPedia's built-in key";
  ui.keyStatus.className = 'key-status ok';
  ui.playlistBtn.disabled = false;

  // Post-mortem of the most recent run — the live warnings vanish when a run
  // ends, so a failed run leaves its chronicle here for the curious.
  try {
    const { __farzi_lastrun: lastrun } = await chrome.storage.local.get('__farzi_lastrun');
    if (lastrun && !lastrun.ok) {
      renderLastRun(lastrun);
      ui.lastrunBox.classList.remove('hidden');
    } else {
      ui.lastrunBox.classList.add('hidden');
    }
  } catch {}

  // Pre-fill the playlist box when the current tab already carries a list id.
  if (tab && /[?&]list=/.test(tab.url || '') && !ui.playlistUrl.value) {
    ui.playlistUrl.value = tab.url;
    ui.playlistBox.open = true;
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

  ui.generateBtn.disabled = false;
  ui.generateBtn.title = '';
}

function renderLastRun(lastrun) {
  ui.lastrunBody.innerHTML = '';
  const when = new Date(lastrun.finishedAt || 0);
  const head = document.createElement('p');
  head.textContent = `${lastrun.kind === 'playlist' ? 'Playlist run' : 'Run'} failed at ${when.toLocaleTimeString()}: ${lastrun.error || 'unknown error'}`;
  ui.lastrunBody.appendChild(head);
  if (lastrun.warnings?.length) {
    const ul = document.createElement('ul');
    for (const w of lastrun.warnings) {
      const li = document.createElement('li');
      li.textContent = w;
      ul.appendChild(li);
    }
    ui.lastrunBody.appendChild(ul);
  }
}

// ---------- Reattach if a job is already running ----------

async function maybeReattach() {
  // Ask the worker rather than trusting storage: a worker that died mid-run
  // leaves its last state behind, and reattaching to it freezes the popup.
  let running = false;
  try { running = !!(await chrome.runtime.sendMessage({ type: 'IS_RUNNING' }))?.data; } catch {}
  if (!running) {
    await initIdle();
    return;
  }
  const { __farzi_running } = await chrome.storage.local.get('__farzi_running');
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
      let text = msg.message || 'unknown error';
      // Carry the run's warnings into the error view — they usually hold the
      // per-video reasons behind a summary error.
      const ws = [...ui.warnings.querySelectorAll('li')].map(li => li.textContent);
      if (ws.length) text += `\n\nAlong the way:\n${ws.map(w => `• ${w}`).join('\n')}`;
      ui.errorMsg.textContent = text;
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

// ---------- Playlist ----------

ui.playlistBtn.addEventListener('click', async () => {
  const tab = await getActiveTab();
  if (!tab) return;
  const playlistUrl = ui.playlistUrl.value.trim();
  if (!playlistUrl) { ui.playlistInfo.textContent = 'Paste a playlist link first.'; return; }
  // The run plays the videos in this tab, so it must already be YouTube —
  // taking over any other page would throw away what's open there.
  if (!/^https:\/\/([a-z0-9-]+\.)?youtube\.com\//i.test(tab.url || '')) {
    ui.playlistInfo.textContent = 'Open any YouTube page in this tab first — the playlist plays here.';
    return;
  }

  ui.playlistBtn.disabled = true;
  ui.playlistInfo.textContent = 'reading playlist…';
  try {
    const res = await chrome.runtime.sendMessage({ type: 'GET_PLAYLIST_INFO', playlistUrl });
    if (!res?.ok) {
      const err = res?.error || 'Could not read that playlist.';
      if (/unknown message type/i.test(err)) {
        // The popup was re-read from disk but the old service worker is still
        // registered. Reload the whole extension so the new worker takes over.
        ui.playlistInfo.textContent = 'Extension updated — rebinding the quill… reopen the popup.';
        setTimeout(() => chrome.runtime.reload(), 800);
        return;
      }
      ui.playlistInfo.textContent = err;
      return;
    }
    const { count, title } = res.data;
    if (!count) { ui.playlistInfo.textContent = 'That playlist has no videos (is it public?).'; return; }
    ui.playlistInfo.textContent = `${count} videos · ${title || 'untitled'}`;
    showRunning();
    startListeningForProgress();
    await chrome.runtime.sendMessage({ type: 'START_PLAYLIST_JOB', tabId: tab.id, playlistUrl });
  } catch (e) {
    // No listener at all (worker crashed or mid-update) — same remedy.
    ui.playlistInfo.textContent = 'Extension needs a reload — rebinding the quill… reopen the popup.';
    setTimeout(() => chrome.runtime.reload(), 800);
  } finally {
    ui.playlistBtn.disabled = false;
  }
});

ui.retryBtn.addEventListener('click', () => initIdle());

// ---------- boot ----------
document.getElementById('build').textContent =
  `v${chrome.runtime.getManifest().version} · ${MODEL}`;
maybeReattach();
