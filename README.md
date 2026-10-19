<div align="center">

# 📖 FarziPedia — Chrome Extension

### *de pictura mota — illuminata*

**Turn any YouTube video into a beautifully illustrated, Renaissance-codex-styled blog post — entirely in your browser.**

</div>

---

## What it does

Open a YouTube video → click the FarziPedia icon → click **Render the Codex**.

The extension:
1. Reads the transcript through YouTube's own player (with three fallbacks)
2. Seeks the video to 20–60 cue-driven timestamps and screenshots each
3. Sends the transcript + frames to Claude (FarziPedia's built-in key, or your own Anthropic key)
4. Returns a magazine-style blog post — illuminated initials, parchment background, Cinzel Roman caps
5. Saves it as Markdown or PDF on demand

No proxies. No yt-dlp. No server. No anti-bot dance — your browser, your IP, your YouTube session.

---

## Install (~3 minutes)

**Easiest:** install it from the [Chrome Web Store](https://chromewebstore.google.com/detail/dbgbnmbjkgaogoemdaldnmgidkaialll), then skip to step 3. Store installs update themselves.

To run the code from this repo instead (for development):

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

### 3. (Optional) Use your own Anthropic API key

FarziPedia works out of the box: without a key, it sends requests through farzipedia.com, which adds FarziPedia's own key on the server. To bill your own Anthropic account instead:

1. At [console.anthropic.com](https://console.anthropic.com/), create a key **inside a workspace** (Settings → Workspaces → pick one → API keys). Keys that aren't tied to a workspace are rejected.
2. **Set a spend limit** at [console.anthropic.com/settings/limits](https://console.anthropic.com/settings/limits).
3. Click the FarziPedia icon → expand "Use your own Claude API key" → paste your `sk-ant-…` → **Save**. The popup shows **✓ using your saved key**. **Clear** goes back to the built-in key.

That's it. Open any YouTube video with captions, press play, and try it.

---

## What each video costs you

Nothing, unless you use your own key: then roughly **$0.50–$1.50** per video with Claude Opus 4.8, depending on length: frames are most of the input (20 for a short video, up to 60 for a long one, ~1,900 tokens each at 1600px), plus the transcript and the written post. A $10 spend limit covers about 10 videos. These are estimates; your Anthropic console shows the real cost per request.

---

## How it works

```
You click "Render the Codex"
       ↓
Service worker reads YouTube's player data via chrome.scripting (MAIN world)
       ↓
Four transcript layers (player's own caption request → timedtext → InnerTube → DOM scrape) — first one wins
       ↓
For each planned timestamp:
   ├─ seek video, hide YouTube's UI (controls, subtitles, end cards, header)
   ├─ chrome.tabs.captureVisibleTab → crop to video bounds → shrink to ≤1600px
   └─ verify frame isn't black, retry if it is
       ↓
Send transcript + frames to Claude (claude-opus-4-8): direct with your key, else via farzipedia.com
       ↓
Publish the post to farzipedia.com (saved locally too) and open it
```

Sequential capture (not parallel) takes ~1–2s per frame. A 15-minute video → ~30 frames → ~40s of capture + ~30s of Claude generation = **~1 minute total**.

---

## File layout

```
farzipedia-extension/
├── manifest.json
├── scripts/publish.mjs         # Package + push to the Chrome Web Store
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
| "**isn't tied to a workspace**" | Your Anthropic key is organization-wide. Create a key inside a workspace and paste that, or press **Clear** to use the built-in key. |
| "**Press play on the video**" | YouTube only loads captions once a video has started. Play it for a moment (skip any ad), then click Render again. |
| "**Start a playlist from a YouTube tab**" | The playlist plays in the current tab, so open any YouTube page first. |
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

Chrome Web Store installs update automatically, usually within a few hours of a new version going live.

For a "Load unpacked" copy:

```powershell
cd path/to/farzipedia-extension
git pull
```

Then `chrome://extensions/` → click the ⟳ reload icon on the FarziPedia card.

Posts that didn't reach farzipedia.com are kept in the browser: open `chrome-extension://<extension id>/result/result.html` to list them.

---

## Publishing to the Chrome Web Store (maintainers)

`scripts/publish.mjs` packages the extension and pushes it through the Chrome Web Store API, so you never have to upload a zip by hand. It needs Node 16+ and nothing else.

**One-time setup** (about 10 minutes, all in your own accounts):

1. In the [Google Cloud console](https://console.cloud.google.com/), pick or create a project, then enable the **Chrome Web Store API**.
2. **IAM & Admin → Service accounts → Create service account** (no roles needed). Open it → **Keys → Add key → JSON**. Store the downloaded file **outside this repo**, for example in `~/.config/farzipedia/`.
3. In the [Developer Dashboard](https://chrome.google.com/webstore/devconsole), open **Account** and add the service account's email (one per publisher). Copy your **publisher ID** from the publisher settings.
4. Create `~/.config/farzipedia/cws.json`:

   ```json
   { "publisherId": "YOUR_PUBLISHER_ID", "serviceAccountKeyFile": "/Users/you/.config/farzipedia/cws-key.json" }
   ```

**Each release:**

1. Bump `"version"` in `manifest.json`, commit, and push. The script refuses to ship uncommitted or unpushed code, so the store always matches GitHub.
2. Run:

   ```bash
   node scripts/publish.mjs status    # what the store has now (read-only)
   node scripts/publish.mjs publish   # zip, upload, submit for review
   ```

`check` only builds `dist/farzipedia-<version>.zip`. `upload` stops at a draft without submitting. `publish --staged` holds the approved version until you release it from the dashboard. The script also refuses to ship a build with a key in `lib/config.js`.

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
- **The video must have started playing.** YouTube only loads captions after playback begins.
- **Livestreams unsupported.** The pipeline checks for `videoDetails.isLive` and bails early.
- **API key sits in your browser's `chrome.storage.sync`.** Set a spend limit. Don't share devices.

---

## Tech stack

- **Manifest V3** Chrome extension
- **`chrome.scripting.executeScript({ world: 'MAIN' })`** for all YouTube page reads
- **Claude Opus 4.8** (adaptive thinking, schema-enforced JSON) with `anthropic-dangerous-direct-browser-access` for browser-direct API calls
- **OffscreenCanvas** for in-SW frame cropping + black-frame detection
- **Cinzel + Cormorant Garamond + IM Fell English + Italianno** for the Renaissance typography

---

## License

MIT. Take it, fork it, ship it.
