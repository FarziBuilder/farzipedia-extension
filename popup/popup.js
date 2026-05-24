// FarziPedia popup — UI for the foolproof background pipeline.
// No API key handling: requests are proxied through farzi.me, which holds
// the server-side Anthropic key.

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
