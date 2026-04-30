<div align="center">

# 📖 FarziPedia — Chrome Extension

### *de pictura mota — illuminata*

**Turn any YouTube video into a beautifully illustrated, Renaissance-codex-styled blog post — entirely in your browser.**

</div>

---

## What it does

Open a YouTube video → click the FarziPedia icon → click **Render the Codex**.

The extension:
1. Reads the transcript directly from YouTube's player data (three fallback methods, one of them always works)
2. Seeks the video to ~30–40 cue-driven timestamps and screenshots each
3. Sends the transcript + frames to Claude (your own Anthropic API key)
4. Returns a magazine-style blog post — illuminated initials, parchment background, Cinzel Roman caps
5. Saves it as Markdown or PDF on demand

No proxies. No yt-dlp. No server. No anti-bot dance — your browser, your IP, your YouTube session.

---

## Install (~3 minutes)

### 1. Download the extension folder

Either clone with git:

```powershell
git clone https://github.com/FarziBuilder/farzipedia-extension.git
```

Or download as a ZIP: green **Code** button on this page → **Download ZIP** → unzip somewhere you'll keep it (don't delete the folder later — Chrome reads from it directly).

### 2. Load it into Chrome

1. Open `chrome://extensions/`
2. Toggle **Developer mode** on (top-right)
3. Click **Load unpacked**
4. Pick the `farzipedia-extension/` folder you just downloaded
5. Pin the icon: click the puzzle-piece in the Chrome toolbar → 📌 next to FarziPedia

### 3. Get an Anthropic API key

The extension calls Claude directly from your browser, so it needs your own key.

1. Sign up at [console.anthropic.com](https://console.anthropic.com/) (free)
2. **Settings → API Keys → Create Key** — copy the `sk-ant-…` value once (Anthropic shows it only once)
3. **Set a spend limit** at [console.anthropic.com/settings/limits](https://console.anthropic.com/settings/limits) — $5–10/month is plenty for hundreds of videos. **Do this** — it's cheap insurance against bugs or accidental loops.

### 4. Paste the key in the popup

Click the FarziPedia icon → expand "Use my own API key" → paste your `sk-ant-…` → **Save**.

The popup status will switch to **✓ using your saved key** and the **Render the Codex** button will enable.

That's it. Open any YouTube video with captions and try it.

---

## What each video costs you

Roughly **$0.05–$0.20** in Claude vision tokens, depending on length and frame count. A 15-min video with 30 frames is ~$0.10. Your $5 spend limit covers ~50 videos comfortably.

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
Send transcript + frames to api.anthropic.com (claude-sonnet-4-5)
       ↓
Open result tab with the rendered blog
```

Sequential capture (not parallel) takes ~1–2s per frame. A 15-minute video → ~30 frames → ~40s of capture + ~30s of Claude generation = **~1 minute total**.

---

## File layout

```
farzipedia-extension/
├── manifest.json
├── icons/                     # 16/48/128 PNG (open book + red bookmark)
├── popup/                     # API-key entry, "Render" button, live progress
├── background/service-worker.js  # The whole pipeline
├── lib/
│   ├── config.js              # Optional built-in key (leave empty)
│   ├── config.example.js      # Template
│   ├── planner.js             # Cue-driven timestamp picking
│   └── analyzer.js            # Claude vision API call
└── result/                    # Rendered blog page (HTML + CSS + JS)
```

---

## Troubleshooting

| Symptom | Fix |
|---|---|
| "**No API key configured**" in popup | Paste your `sk-ant-…` in the popup's "Use my own API key" section. |
| "**Couldn't read YouTube's player data**" | Refresh the YouTube tab (Ctrl+R), then reopen the popup. |
| "**No captions enabled**" | The video doesn't have a caption track. Try a different video. |
| "**An ad is currently playing**" | Skip the ad in the player, then click Render again. |
| "**Crop bounds outside the captured image**" | The YouTube tab needs to stay on screen during capture. |
| Some frames look black | DRM-protected sections — the extension auto-retries with a ±1.5s nudge but a few may be skipped. |
| "**Claude API error 401**" | Bad key — re-paste a fresh one from the Anthropic console. |
| "**Claude API error 529**" | Anthropic is overloaded. Wait a couple of minutes and retry. |

For deeper debugging, open `chrome://extensions/` → "Inspect views: service worker" — the console there has detailed step-by-step logs.

---

## Updating

Since this isn't on the Chrome Web Store, there's no auto-update.

```powershell
cd path/to/farzipedia-extension
git pull
```

Then `chrome://extensions/` → click the ⟳ reload icon on the FarziPedia card.

---

## Power-user: built-in key without the popup

If you want every install on your machine to use the same key without pasting it through the popup, edit `lib/config.js`:

```js
export const BUILTIN_API_KEY = "sk-ant-your-real-key-here";
```

Then prevent git from tracking your local edit so a future `git pull` doesn't fight you:

```powershell
git update-index --skip-worktree lib/config.js
```

⚠️ The key is now visible to anyone with read access to the folder. Set a spend limit. Don't share the unpacked folder with others if you've got a real key in there.

---

## Limitations

- **YouTube tab must stay on screen during capture.** `captureVisibleTab` only sees the active tab. Switch away mid-capture and a few frames will fail (you'll get warnings, not a hard fail).
- **Captions required.** Videos without manual or auto-generated captions can't be processed.
- **Livestreams unsupported.** The pipeline checks for `videoDetails.isLive` and bails early.
- **API key sits in your browser's `chrome.storage.sync`.** Set a spend limit. Don't share devices.

---

## Tech stack

- **Manifest V3** Chrome extension
- **`chrome.scripting.executeScript({ world: 'MAIN' })`** for all YouTube page reads
- **Claude Sonnet 4.5** with `anthropic-dangerous-direct-browser-access` for browser-direct API calls
- **OffscreenCanvas** for in-SW frame cropping + black-frame detection
- **Cinzel + Cormorant Garamond + IM Fell English + Italianno** for the Renaissance typography

---

## License

MIT. Take it, fork it, ship it.
