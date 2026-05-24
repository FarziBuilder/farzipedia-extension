<div align="center">

# 📖 FarziPedia — Chrome Extension

### *de pictura mota — illuminata*

**Turn any YouTube video into a beautifully illustrated, Renaissance-codex-styled blog post — and add it to the public library at [farzi.me](https://farzi.me).**

</div>

---

## What it does

Open a YouTube video → click the FarziPedia icon → click **Render the Codex**.

The extension:
1. Reads the transcript directly from YouTube's player data (three fallback methods, one always works)
2. Seeks the video to ~30–40 cue-driven timestamps and screenshots each
3. Sends the transcript + frames to Claude **via farzi.me's server-side proxy** — no Anthropic key needed
4. Returns a magazine-style blog post — illuminated initials, parchment background, Cinzel Roman caps
5. Publishes the folio to [farzi.me](https://farzi.me) so it appears in the public library
6. Saves a local copy you can re-open offline

No accounts. No API keys. No paste-this-thing-into-the-popup ritual. Install and go.

---

## Install (~1 minute)

### Option A — From the Chrome Web Store
*(coming soon — once we publish)*

### Option B — Load unpacked from this repo

1. Clone or download:
   ```powershell
   git clone https://github.com/FarziBuilder/farzipedia-extension.git
   ```
2. Open `chrome://extensions/`
3. Toggle **Developer mode** on (top-right)
4. Click **Load unpacked** → pick the `farzipedia-extension/` folder
5. Pin the icon: puzzle-piece in the toolbar → 📌 next to FarziPedia

Open any YouTube video with captions and click the icon. That's it.

---

## How it works

```
You click "Render the Codex"
       ↓
Service worker reads YouTube's player data via chrome.scripting (MAIN world)
       ↓
Three transcript layers (timedtext → InnerTube → DOM scrape) — first one wins
       ↓
For each planned timestamp:
   ├─ seek video, hide overlays
   ├─ chrome.tabs.captureVisibleTab → crop to video bounds
   └─ verify frame isn't black, retry if it is
       ↓
POST transcript + frames to farzi.me/v1/proxy/messages
   └─ server attaches its Anthropic API key, forwards to Claude
       ↓
POST result to farzi.me/v1/folios → appears in the public library
       ↓
Open result tab with the rendered blog (also saved locally)
```

Sequential capture (not parallel) takes ~1–2s per frame. A 15-minute video → ~30 frames → ~40s of capture + ~30s of Claude generation + ~3s of upload = **~1 minute total**.

---

## File layout

```
farzipedia-extension/
├── manifest.json
├── icons/                          # 16/48/128 PNG (open book + red bookmark)
├── popup/                          # "Render" button + live progress
├── background/service-worker.js    # The whole pipeline
├── lib/
│   ├── config.js                   # FARZIPEDIA_BASE_URL (defaults to https://farzi.me)
│   ├── planner.js                  # Cue-driven timestamp picking
│   └── analyzer.js                 # Proxy call + folio upload
└── result/                         # Rendered blog page (HTML + CSS + JS)
```

---

## Troubleshooting

| Symptom | Fix |
|---|---|
| "**farzi.me proxy is misconfigured**" | The server is missing `ANTHROPIC_API_KEY`. Tell the maintainer; try again later. |
| "**Too many requests**" | Per-IP rate limit hit. Wait a minute. |
| "**Anthropic is overloaded**" | Upstream issue at Anthropic. Wait a couple of minutes. |
| "**Couldn't publish to farzi.me**" | Network blip or server down. Your local copy is still saved — try again later for the public folio. |
| "**Couldn't read YouTube's player data**" | Refresh the YouTube tab (Ctrl+R), then reopen the popup. |
| "**No captions enabled**" | The video doesn't have a caption track. Try a different video. |
| "**An ad is currently playing**" | Skip the ad in the player, then click Render again. |
| "**Crop bounds outside the captured image**" | The YouTube tab needs to stay on screen during capture. |
| Some frames look black | DRM-protected sections — the extension auto-retries with a ±1.5s nudge; a few may still be skipped. |

For deeper debugging, open `chrome://extensions/` → "Inspect views: service worker" — the console has detailed step-by-step logs.

---

## Updating

Since this isn't on the Chrome Web Store yet:

```powershell
cd path/to/farzipedia-extension
git pull
```

Then `chrome://extensions/` → click the ⟳ reload icon on the FarziPedia card.

---

## Pointing at a different backend (dev / self-hosted)

By default the extension calls `https://farzi.me`. To point it at a local
backend (e.g. `python app.py` of the `farzipedia` repo running on
`http://localhost:8000`):

1. Edit `lib/config.js` and change `FARZIPEDIA_BASE_URL`.
2. Edit `manifest.json` and add your local origin (e.g. `"http://localhost:8000/*"`)
   to `host_permissions`.
3. Reload the extension in `chrome://extensions/`.

---

## Limitations

- **YouTube tab must stay on screen during capture.** `captureVisibleTab` only sees the active tab. Switch away mid-capture and a few frames will fail (you'll get warnings, not a hard fail).
- **Captions required.** Videos without manual or auto-generated captions can't be processed.
- **Livestreams unsupported.** The pipeline checks for `videoDetails.isLive` and bails early.
- **Per-IP rate limit on the proxy.** 20 requests / minute. The maintainer pays for Claude usage — generous but finite.

---

## Tech stack

- **Manifest V3** Chrome extension
- **`chrome.scripting.executeScript({ world: 'MAIN' })`** for all YouTube page reads
- **Claude Sonnet 4.5** via the [farzi.me](https://farzi.me) FastAPI proxy
- **OffscreenCanvas** for in-SW frame cropping + black-frame detection
- **Cinzel + Cormorant Garamond + IM Fell English + Italianno** for the Renaissance typography

---

## License

MIT. Take it, fork it, ship it.
