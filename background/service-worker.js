// FarziPedia background service worker — the entire pipeline.
// Page interaction goes through chrome.scripting.executeScript({world: 'MAIN'})
// so we read YouTube's real globals, not the isolated-world view.

import { planTimestamps } from '../lib/planner.js';
import { generateBlog, uploadFolio } from '../lib/analyzer.js';

// ============================================================================
//   Page-world helpers — all run via chrome.scripting in the user's tab
// ============================================================================

/** Run a function in the page's main world and return its result. */
async function execInPage(tabId, func, args = []) {
  const results = await chrome.scripting.executeScript({
    target: { tabId },
    world: 'MAIN',
    func,
    args,
  });
  return results?.[0]?.result;
}

/**
 * Read YouTube's player data — title, channel, duration, captions.
 * Tries multiple sources, retries up to 10s for fresh data, validates
 * that the videoId matches the URL (catches stale SPA navigations).
 */
async function readPlayerData(tabId) {
  const start = Date.now();
  let lastError = null;
  while (Date.now() - start < 10_000) {
    try {
      const data = await execInPage(tabId, () => {
        const urlVid = new URLSearchParams(location.search).get('v');
        const candidates = [];

        // (A) Window global — set on first load
        if (window.ytInitialPlayerResponse) candidates.push(window.ytInitialPlayerResponse);

        // (B) Polymer `<ytd-watch-flexy>` element data — refreshed on SPA nav
        try {
          const el = document.querySelector('ytd-watch-flexy');
          if (el) {
            if (el.__data?.playerData) candidates.push(el.__data.playerData);
            if (el.playerData)         candidates.push(el.playerData);
            if (el.__data?.playerResponse) candidates.push(el.__data.playerResponse);
          }
        } catch {}

        // (C) Internal player API — has a getPlayerResponse()
        try {
          const player = document.querySelector('#movie_player');
          if (player && typeof player.getPlayerResponse === 'function') {
            candidates.push(player.getPlayerResponse());
          }
        } catch {}

        // Pick the candidate whose videoId matches the URL
        if (urlVid) {
          const match = candidates.find(c => c?.videoDetails?.videoId === urlVid);
          if (match) return { source: 'matched', data: match };
        }
        // Otherwise return any candidate we have
        return candidates.length ? { source: 'any', data: candidates[0] } : null;
      });

      if (data?.data?.videoDetails?.videoId) return data.data;
      lastError = 'no candidate had videoDetails.videoId';
    } catch (e) {
      lastError = String(e?.message || e);
    }
    await sleep(500);
  }
  throw new Error(
    `Couldn't read YouTube's player data after 10s ${lastError ? `(${lastError})` : ''}. ` +
    `Try refreshing the YouTube tab (Ctrl+R) and run again.`
  );
}

/** Strip any existing `fmt=` from a baseUrl and append our own. */
function withFmt(baseUrl, fmt) {
  const stripped = baseUrl.replace(/([?&])fmt=[^&]*&?/g, (m, p1) => p1 === '?' ? '?' : '').replace(/[?&]$/, '');
  const sep = stripped.includes('?') ? '&' : '?';
  return fmt ? `${stripped}${sep}fmt=${fmt}` : stripped;
}

/** Decode the small set of HTML entities YouTube uses in caption XML. */
function decodeHtmlEntities(s) {
  return (s || '')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(parseInt(n, 10)));
}

/** Parse YouTube's classic XML caption format. */
function parseXmlCaptions(xml) {
  const out = [];
  // Greedy-match <text ...>body</text> — `s` flag covers multi-line bodies.
  const re = /<text([^>]*)>([\s\S]*?)<\/text>/g;
  let m;
  while ((m = re.exec(xml)) !== null) {
    const attrs = m[1] || '';
    const startMatch = attrs.match(/\bstart="([\d.]+)"/);
    const durMatch = attrs.match(/\bdur="([\d.]+)"/);
    if (!startMatch) continue;
    const text = decodeHtmlEntities(m[2]).replace(/\s+/g, ' ').trim();
    if (!text) continue;
    out.push({
      start: parseFloat(startMatch[1]) || 0,
      duration: parseFloat(durMatch?.[1] || '0') || 0,
      text,
    });
  }
  return out;
}

/** Parse a json3/srv3 response into our snippets shape. */
function parseJson3Captions(data) {
  if (!data || !Array.isArray(data.events)) return [];
  const out = [];
  for (const ev of data.events) {
    if (!ev.segs) continue;
    const text = ev.segs.map(s => s.utf8 || '').join('').replace(/\s+/g, ' ').trim();
    if (!text) continue;
    out.push({
      start: (ev.tStartMs || 0) / 1000,
      duration: (ev.dDurationMs || 0) / 1000,
      text,
    });
  }
  return out;
}

/** Try one caption track across multiple formats, return snippets or []. */
async function tryTrack(tabId, track) {
  const baseUrl = track.baseUrl;
  const attempts = [
    { fmt: 'json3', as: 'json' },
    { fmt: 'srv3',  as: 'json' },
    { fmt: '',      as: 'xml' },  // YouTube's classic XML format
  ];
  // Auto-translated tracks need an extra `tlang=en` if the base track isn't English.
  const useTlang = track.languageCode && track.languageCode !== 'en';

  for (const { fmt, as } of attempts) {
    const url = (useTlang ? withFmt(baseUrl, fmt) + '&tlang=en' : withFmt(baseUrl, fmt));
    try {
      const text = await execInPage(tabId, async (u) => {
        const r = await fetch(u, { credentials: 'include' });
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return r.text();
      }, [url]);
      if (!text || !text.trim()) continue;

      let snippets = [];
      if (as === 'json') {
        try {
          const data = JSON.parse(text);
          snippets = parseJson3Captions(data);
        } catch { continue; }
      } else {
        snippets = parseXmlCaptions(text);
      }
      if (snippets.length) return { snippets, fmt: fmt || 'xml' };
    } catch {
      // try next format
    }
  }
  return { snippets: [] };
}

/** Order caption tracks by how likely they are to have good content. */
function rankTracks(tracks) {
  const score = (t) => {
    let s = 0;
    if (t.languageCode === 'en') s += 100;
    if (t.kind !== 'asr') s += 30;             // manual > auto
    if (t.isTranslatable) s += 5;
    return s;
  };
  return [...tracks].sort((a, b) => score(b) - score(a));
}

// ============================================================================
//   Transcript layer 2: YouTube's own InnerTube /get_transcript endpoint
//   (the same API its UI uses for the "Show transcript" panel)
// ============================================================================

/** Build the protobuf-encoded `params` from a videoId, base64-url-safe. */
function makeTranscriptParams(videoId) {
  const len = videoId.length;
  const bytes = new Uint8Array(4 + len);
  bytes[0] = 0x0a;          // field 1, wire type 2 (length-delimited)
  bytes[1] = len;           // length of videoId
  for (let i = 0; i < len; i++) bytes[2 + i] = videoId.charCodeAt(i);
  bytes[2 + len] = 0x18;    // field 3, wire type 0 (varint)
  bytes[3 + len] = 0x00;    // value 0
  let bin = '';
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** Pull the transcript `params` from the engagementPanels array if present. */
function findTranscriptParams(playerData) {
  const panels = playerData?.engagementPanels || [];
  for (const panel of panels) {
    const target = panel?.engagementPanelSectionListRenderer?.targetId || '';
    if (!target.toLowerCase().includes('transcript')) continue;
    const sections = panel?.engagementPanelSectionListRenderer?.content?.sectionListRenderer?.contents || [];
    for (const sec of sections) {
      const items = sec?.itemSectionRenderer?.contents || [];
      for (const item of items) {
        const params = item?.continuationItemRenderer?.continuationEndpoint?.getTranscriptEndpoint?.params;
        if (params) return params;
      }
    }
  }
  return null;
}

/** Pull text out of a YouTube "snippet"-like object — handles runs, simpleText, or just text. */
function extractRunsText(obj) {
  if (!obj) return '';
  if (typeof obj === 'string') return obj;
  if (obj.simpleText) return obj.simpleText;
  if (Array.isArray(obj.runs)) return obj.runs.map(r => r.text || '').join('');
  if (Array.isArray(obj)) return obj.map(r => extractRunsText(r)).join('');
  if (obj.text) return typeof obj.text === 'string' ? obj.text : extractRunsText(obj.text);
  return '';
}

/** Try every known response shape, then deep-walk if nothing matches. */
function parseInnerTubeTranscript(response) {
  if (!response || typeof response !== 'object') return [];

  // --- Try every known explicit path first ---
  const knownPaths = [
    // newer: direct segmentList
    r => r?.actions?.[0]?.updateEngagementPanelAction?.content?.transcriptRenderer?.body?.transcriptSegmentListRenderer?.initialSegments,
    // newer with searchPanel wrapper
    r => r?.actions?.[0]?.updateEngagementPanelAction?.content?.transcriptRenderer?.content?.transcriptSearchPanelRenderer?.body?.transcriptSegmentListRenderer?.initialSegments,
    // appendContinuationItemsAction (live updates)
    r => r?.onResponseReceivedActions?.[0]?.appendContinuationItemsAction?.continuationItems,
    // panel-direct shape
    r => r?.actions?.find?.(a => a.updateEngagementPanelAction)?.updateEngagementPanelAction?.content?.transcriptRenderer?.body?.transcriptSegmentListRenderer?.initialSegments,
    // older: cueGroups
    r => r?.actions?.[0]?.updateEngagementPanelAction?.content?.transcriptRenderer?.body?.transcriptBodyRenderer?.cueGroups,
  ];

  for (const path of knownPaths) {
    try {
      const arr = path(response);
      if (Array.isArray(arr) && arr.length) {
        const parsed = parseSegmentsArray(arr);
        if (parsed.length) return parsed;
      }
    } catch {}
  }

  // --- Generic deep walk: find ANY array of segment renderers ---
  const found = deepFindSegmentArray(response);
  if (found) {
    const parsed = parseSegmentsArray(found);
    if (parsed.length) return parsed;
  }

  return [];
}

function parseSegmentsArray(arr) {
  const out = [];
  for (const s of arr) {
    if (!s || typeof s !== 'object') continue;

    // Modern: transcriptSegmentRenderer
    const segR = s.transcriptSegmentRenderer;
    if (segR) {
      const startMs = parseInt(segR.startMs || '0', 10);
      const endMs = parseInt(segR.endMs || '0', 10);
      const text = extractRunsText(segR.snippet).replace(/\s+/g, ' ').trim();
      if (text) {
        out.push({ start: startMs / 1000, duration: Math.max(0, (endMs - startMs) / 1000), text });
      }
      continue;
    }

    // Legacy: transcriptCueGroupRenderer wrapping transcriptCueRenderer
    const grp = s.transcriptCueGroupRenderer;
    if (grp && Array.isArray(grp.cues)) {
      for (const c of grp.cues) {
        const cr = c.transcriptCueRenderer;
        if (!cr) continue;
        const startMs = parseInt(cr.startOffsetMs || '0', 10);
        const durationMs = parseInt(cr.durationMs || '0', 10);
        const text = extractRunsText(cr.cue).replace(/\s+/g, ' ').trim();
        if (text) {
          out.push({ start: startMs / 1000, duration: durationMs / 1000, text });
        }
      }
      continue;
    }
  }
  return out;
}

/** Deep-walk the response looking for an array whose first element is a segment renderer. */
function deepFindSegmentArray(root, maxDepth = 25) {
  const stack = [{ obj: root, depth: 0 }];
  while (stack.length) {
    const { obj, depth } = stack.shift();
    if (!obj || depth > maxDepth) continue;
    if (Array.isArray(obj)) {
      const first = obj[0];
      if (first && typeof first === 'object' && (first.transcriptSegmentRenderer || first.transcriptCueGroupRenderer)) {
        return obj;
      }
      for (const item of obj) stack.push({ obj: item, depth: depth + 1 });
    } else if (typeof obj === 'object') {
      for (const k of Object.keys(obj)) stack.push({ obj: obj[k], depth: depth + 1 });
    }
  }
  return null;
}

async function fetchTranscriptInnerTube(tabId, playerData) {
  const cfg = await execInPage(tabId, () => {
    if (!window.ytcfg || typeof window.ytcfg.get !== 'function') return null;
    return {
      apiKey: window.ytcfg.get('INNERTUBE_API_KEY'),
      ctx:    window.ytcfg.get('INNERTUBE_CONTEXT'),
    };
  });
  if (!cfg?.apiKey || !cfg?.ctx) {
    throw new Error('window.ytcfg has no INNERTUBE config.');
  }

  const videoId = playerData?.videoDetails?.videoId;
  if (!videoId) throw new Error('No videoId in playerData.');

  const params = findTranscriptParams(playerData) || makeTranscriptParams(videoId);

  const url = `https://www.youtube.com/youtubei/v1/get_transcript?key=${cfg.apiKey}&prettyPrint=false`;
  const data = await execInPage(tabId, async (reqUrl, body) => {
    const r = await fetch(reqUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify(body),
    });
    if (!r.ok) throw new Error(`InnerTube HTTP ${r.status}`);
    return r.json();
  }, [url, { context: cfg.ctx, params }]);

  const snippets = parseInnerTubeTranscript(data);
  if (!snippets.length) {
    // Dump the response shape so we can diagnose unexpected structures.
    try {
      const topKeys = Object.keys(data || {});
      const actionKeys = Object.keys(data?.actions?.[0] || {});
      const innerKeys = Object.keys(
        data?.actions?.[0]?.updateEngagementPanelAction?.content?.transcriptRenderer || {}
      );
      console.warn('[FarziPedia] InnerTube returned 0 segments. Response shape:',
        { topKeys, actionKeys, innerKeys });
      console.warn('[FarziPedia] Raw InnerTube response (truncated):',
        JSON.stringify(data).slice(0, 4000));
    } catch {}
    throw new Error('InnerTube response had 0 transcript segments (see SW console for raw response shape).');
  }
  return snippets;
}

// ============================================================================
//   Transcript layer 3: scrape the existing "Show transcript" UI panel
// ============================================================================

async function fetchTranscriptFromDom(tabId) {
  // Wrap everything so even an internal throw returns a structured value
  // (chrome.scripting can otherwise swallow throws to null).
  const result = await execInPage(tabId, async () => {
    const log = [];
    const note = (m) => log.push(m);

    try {
      const sleep = (ms) => new Promise(r => setTimeout(r, ms));

      // ----- (1) Try to make the transcript panel visible WITHOUT clicking -----
      const expandPanel = () => {
        const panelEl = document.querySelector(
          'ytd-engagement-panel-section-list-renderer[target-id="engagement-panel-searchable-transcript"], ' +
          'ytd-engagement-panel-section-list-renderer[target-id="engagement-panel-transcript"]'
        );
        if (!panelEl) { note('no engagement-panel element with transcript target-id'); return false; }
        panelEl.setAttribute('visibility', 'ENGAGEMENT_PANEL_VISIBILITY_EXPANDED');
        try { panelEl.removeAttribute('hidden'); } catch {}
        try { panelEl.style.display = 'block'; } catch {}
        note('expanded panel via attribute');
        return true;
      };

      // ----- (2) Try to click the YouTube engagement panel's open button -----
      const openViaPlayer = () => {
        // Modern YouTube has a "Show transcript" affordance as an engagement-panel link.
        // Try to dispatch a "yt-action" event the way YouTube itself does.
        const watchFlexy = document.querySelector('ytd-watch-flexy');
        if (watchFlexy) {
          const ev = new CustomEvent('yt-engagement-panel-visibility-updated', {
            bubbles: true, composed: true,
            detail: { targetId: 'engagement-panel-searchable-transcript', visibility: 'ENGAGEMENT_PANEL_VISIBILITY_EXPANDED' }
          });
          watchFlexy.dispatchEvent(ev);
          note('dispatched yt-engagement-panel-visibility-updated');
        }
      };

      // ----- (3) Fallback: search for clickable text matches -----
      const clickShowTranscriptText = () => {
        const expand = document.querySelector('tp-yt-paper-button#expand, #description #expand');
        if (expand) { expand.click(); }
        const matches = [
          /show transcript/i, /^transcript$/i, /open transcript/i,
        ];
        const cands = document.querySelectorAll(
          'button, yt-button-shape, ytd-button-renderer, tp-yt-paper-button, ytd-menu-service-item-renderer, ' +
          '[role="button"], [role="menuitem"], yt-formatted-string'
        );
        for (const el of cands) {
          const txt = (el.textContent || '').trim();
          if (!txt) continue;
          if (!matches.some(re => re.test(txt))) continue;
          let cur = el;
          while (cur && cur !== document.body) {
            if (cur.matches('button, yt-button-shape, [role="button"], [role="menuitem"], tp-yt-paper-button, ytd-button-renderer, ytd-menu-service-item-renderer')) {
              cur.click();
              note(`clicked element with text "${txt}"`);
              return true;
            }
            cur = cur.parentElement;
          }
        }
        note('found no element matching transcript text');
        return false;
      };

      // Try strategies in order
      let panel = document.querySelector('ytd-transcript-segment-list-renderer, ytd-transcript-renderer');
      if (!panel) {
        expandPanel();
        await sleep(300);
        panel = document.querySelector('ytd-transcript-segment-list-renderer, ytd-transcript-renderer');
      }
      if (!panel) {
        openViaPlayer();
        await sleep(300);
        panel = document.querySelector('ytd-transcript-segment-list-renderer, ytd-transcript-renderer');
      }
      if (!panel) {
        clickShowTranscriptText();
        await sleep(800);
        panel = document.querySelector('ytd-transcript-segment-list-renderer, ytd-transcript-renderer');
      }
      if (!panel) {
        return { ok: false, error: 'Could not open transcript panel.', log };
      }

      // Wait for segments to populate
      let segments = [];
      const t0 = Date.now();
      while (Date.now() - t0 < 10_000) {
        segments = panel.querySelectorAll('ytd-transcript-segment-renderer');
        if (segments.length > 0) break;
        await sleep(250);
      }
      if (!segments.length) {
        // Try a broader selector
        segments = panel.querySelectorAll('[data-segment-start], yt-formatted-string.segment-text, .segment');
      }
      if (!segments.length) {
        return { ok: false, error: 'Transcript panel opened but stayed empty.', log, panelHtml: panel.outerHTML.slice(0, 2000) };
      }

      const out = [];
      for (const seg of segments) {
        let startMs = seg.dataset?.segmentStart || seg.getAttribute?.('data-segment-start');
        let text = '';
        const textEl = seg.querySelector?.('.segment-text, yt-formatted-string.segment-text');
        if (textEl) text = (textEl.textContent || '').trim();
        if (!text) text = (seg.textContent || '').trim();
        if (!startMs) {
          const tsEl = seg.querySelector?.('.segment-timestamp, [aria-label]');
          const ts = (tsEl?.textContent || '').trim();
          if (ts) {
            const parts = ts.split(':').map(p => parseInt(p, 10));
            if (parts.every(n => !isNaN(n))) {
              const sec = parts.length === 3
                ? parts[0] * 3600 + parts[1] * 60 + parts[2]
                : parts[0] * 60 + parts[1];
              startMs = sec * 1000;
            }
          }
        }
        const start = parseInt(startMs || '0', 10) / 1000;
        if (text) out.push({ start, duration: 0, text });
      }
      if (!out.length) return { ok: false, error: 'Found segments but none had readable text.', log };

      return { ok: true, snippets: out, log };
    } catch (e) {
      return { ok: false, error: 'DOM scrape threw: ' + (e?.message || String(e)), log };
    }
  });

  if (!result) {
    throw new Error('DOM scrape returned no result (chrome.scripting may have refused to inject).');
  }
  if (result.log?.length) console.log('[FarziPedia] DOM scrape log:', result.log);
  if (!result.ok) {
    if (result.panelHtml) console.warn('[FarziPedia] panel HTML (truncated):', result.panelHtml);
    throw new Error(result.error || 'DOM scrape failed.');
  }
  return result.snippets;
}

// ============================================================================
//   Transcript orchestrator — three layers
// ============================================================================

/** Try layer 1 (timedtext), 2 (InnerTube), 3 (DOM scrape) — first success wins. */
async function fetchTranscript(tabId, playerData) {
  const errors = [];

  // ---------- Layer 1: timedtext baseUrl from caption tracks ----------
  try {
    const tracks = playerData?.captions?.playerCaptionsTracklistRenderer?.captionTracks;
    if (tracks && tracks.length) {
      const ranked = rankTracks(tracks);
      for (const track of ranked) {
        const result = await tryTrack(tabId, track);
        if (result?.snippets?.length) {
          return { snippets: result.snippets, source: 'timedtext-' + result.fmt };
        }
      }
      errors.push(`timedtext: ${ranked.length} tracks all empty`);
    } else {
      errors.push('timedtext: no captionTracks listed');
    }
  } catch (e) {
    errors.push('timedtext: ' + (e?.message || e));
  }

  // ---------- Layer 2: InnerTube /get_transcript ----------
  try {
    const snippets = await fetchTranscriptInnerTube(tabId, playerData);
    if (Array.isArray(snippets) && snippets.length) {
      return { snippets, source: 'innertube' };
    }
    errors.push('innertube: empty/null result');
  } catch (e) {
    errors.push('innertube: ' + (e?.message || e));
  }

  // ---------- Layer 3: DOM scrape of the visible transcript panel ----------
  try {
    const snippets = await fetchTranscriptFromDom(tabId);
    if (Array.isArray(snippets) && snippets.length) {
      return { snippets, source: 'dom' };
    }
    errors.push('dom: empty/null result');
  } catch (e) {
    errors.push('dom: ' + (e?.message || e));
  }

  throw new Error(
    `All three transcript methods failed: ${errors.join(' | ')}. ` +
    `Try refreshing the YouTube tab (Ctrl+R), then retry.`
  );
}

/** Pre-flight: video element exists, ready to play, no ad showing, sane bounds. */
async function preflight(tabId) {
  return execInPage(tabId, () => {
    const v = document.querySelector('video.html5-main-video') || document.querySelector('video');
    if (!v) return { ok: false, reason: 'No <video> element on the page.' };

    // Detect ads
    const adShowing =
      document.querySelector('.ad-showing') ||
      document.querySelector('.ytp-ad-player-overlay') ||
      document.querySelector('.ytp-ad-skip-button') ||
      document.querySelector('.ytp-ad-text');
    if (adShowing) return { ok: false, reason: 'An ad is currently playing. Skip the ad in the player, then click Render again.' };

    // readyState >= 2 (HAVE_CURRENT_DATA)
    if (v.readyState < 2) return { ok: false, reason: 'Video isn\'t ready yet — let it buffer for a few seconds and retry.' };

    const r = v.getBoundingClientRect();
    if (r.width < 100 || r.height < 60) return { ok: false, reason: 'Video player is hidden or too small. Make sure the YouTube tab is on screen.' };
    if (r.bottom <= 0 || r.top >= window.innerHeight) return { ok: false, reason: 'Video element is scrolled off-screen. Scroll it into view and retry.' };

    return { ok: true, duration: v.duration };
  });
}

/** Seek video to `t` seconds, hide overlays, return bounds for cropping. */
async function seekAndPrepare(tabId, t) {
  return execInPage(tabId, async (timestamp) => {
    const v = document.querySelector('video.html5-main-video') || document.querySelector('video');
    if (!v) throw new Error('Video element disappeared.');

    // Inject a stylesheet that hides every known piece of YouTube player
    // chrome with !important. This beats:
    //   - YouTube's own JS toggling classes (e.g. removing `.ytp-autohide`
    //     when the video is paused, which re-shows the top title bar)
    //   - inline-style overrides set by YouTube on chrome elements
    // Idempotent: only adds the <style> once per tab.
    const STYLE_ID = 'fp-hide-chrome';
    if (!document.getElementById(STYLE_ID)) {
      const s = document.createElement('style');
      s.id = STYLE_ID;
      s.textContent = `
        /* All player overlays / chrome — anything that floats above the
           actual <video> pixels and would leak into a captureVisibleTab. */
        .ytp-chrome-top,
        .ytp-chrome-top-buttons,
        .ytp-title,
        .ytp-title-channel,
        .ytp-title-text,
        .ytp-title-link,
        .ytp-watch-later-button,
        .ytp-share-button,
        .ytp-overflow-button,
        .ytp-chrome-bottom,
        .ytp-gradient-top,
        .ytp-gradient-bottom,
        .ytp-cc-window-container,
        .ytp-pause-overlay,
        .ytp-pause-overlay-container,
        .ytp-spinner,
        .ytp-watermark,
        .ytp-tooltip,
        .ytp-bezel,
        .ytp-bezel-text-wrapper,
        .ytp-popup,
        .ytp-large-play-button,
        .ytp-cards-button,
        .ytp-cards-teaser,
        .ytp-ce-element,
        .ytp-ce-covering-image,
        .ytp-endscreen-content,
        .ytp-info-panel-preview,
        .ytp-impression-link,
        .ytp-show-cards-title,
        .ytp-paid-content-overlay,
        .ytp-fine-scrubbing-info-bar,
        .ytp-iv-player-content,
        .iv-click-target,
        .iv-branding,
        .annotation,
        .ytp-suggested-action,
        .ytp-suggested-action-badge {
          visibility: hidden !important;
          opacity: 0 !important;
          pointer-events: none !important;
        }
        /* Force "autohide" so YouTube's own CSS path also hides the chrome,
           and never paints a cursor over the captured area. */
        .html5-video-player,
        .html5-video-player * {
          cursor: none !important;
        }
        .html5-video-player.ytp-autohide-active .ytp-chrome-top,
        .html5-video-player.ytp-autohide-active .ytp-chrome-bottom {
          display: none !important;
        }
      `;
      (document.head || document.documentElement).appendChild(s);
    }

    // Belt-and-suspenders: also stamp inline visibility on the elements
    // that exist right now, so we cover any stylesheets that might load
    // late and out-specificity our injected one.
    const HIDE_SELECTORS = [
      '.ytp-chrome-top', '.ytp-chrome-bottom', '.ytp-gradient-top',
      '.ytp-gradient-bottom', '.ytp-cc-window-container', '.ytp-pause-overlay',
      '.ytp-spinner', '.iv-branding', '.ytp-watermark', '.ytp-tooltip',
      '.ytp-bezel', '.ytp-popup', '.ytp-large-play-button',
      '.ytp-ce-element', '.ytp-endscreen-content', '.ytp-cards-teaser',
    ];
    for (const sel of HIDE_SELECTORS) {
      for (const el of document.querySelectorAll(sel)) {
        if (!el.dataset.fpHidden) {
          el.dataset.fpHidden = el.style.visibility || '__empty__';
          el.style.visibility = 'hidden';
        }
      }
    }

    // Force the player into autohide state so YouTube's own UI agrees.
    const player = document.querySelector('.html5-video-player');
    if (player) {
      player.classList.add('ytp-autohide', 'ytp-autohide-active');
    }

    v.style.cursor = 'none';
    v.pause();

    return new Promise((resolve, reject) => {
      const safeT = Math.min(Math.max(0.1, timestamp), v.duration - 0.5);
      const cleanup = () => {
        v.removeEventListener('seeked', onSeeked);
        v.removeEventListener('error', onError);
        clearTimeout(timer);
      };
      const timer = setTimeout(() => { cleanup(); reject(new Error(`Seek to ${timestamp}s timed out.`)); }, 10_000);
      const onSeeked = () => {
        cleanup();
        // Wait two animation frames for the actual frame to render
        requestAnimationFrame(() => requestAnimationFrame(() => {
          const r = v.getBoundingClientRect();
          resolve({
            x: Math.round(r.left), y: Math.round(r.top),
            w: Math.round(r.width), h: Math.round(r.height),
            dpr: window.devicePixelRatio || 1,
            currentTime: v.currentTime,
            visibility: { topInView: r.top >= 0, bottomInView: r.bottom <= window.innerHeight },
          });
        }));
      };
      const onError = () => { cleanup(); reject(new Error('Video errored during seek.')); };
      v.addEventListener('seeked', onSeeked, { once: true });
      v.addEventListener('error', onError, { once: true });
      try { v.currentTime = safeT; }
      catch (e) { cleanup(); reject(new Error('Seek call failed: ' + (e.message || e))); }
    });
  }, [t]);
}

/** Restore overlay visibility after a job completes (or fails). */
async function restoreUi(tabId) {
  await execInPage(tabId, () => {
    // Remove the injected !important stylesheet
    const s = document.getElementById('fp-hide-chrome');
    if (s) s.remove();
    // Restore per-element inline visibility
    for (const el of document.querySelectorAll('[data-fp-hidden]')) {
      const prev = el.dataset.fpHidden;
      el.style.visibility = (prev === '__empty__' ? '' : prev) || '';
      delete el.dataset.fpHidden;
    }
    // Drop the force-autohide classes so the user gets normal chrome back.
    // YouTube will re-add them naturally when the cursor goes idle.
    const player = document.querySelector('.html5-video-player');
    if (player) {
      player.classList.remove('ytp-autohide-active');
      // Leave .ytp-autohide alone — YouTube manages it via cursor events.
    }
    const v = document.querySelector('video.html5-main-video') || document.querySelector('video');
    if (v) v.style.cursor = '';
  }).catch(() => {});
}

// ============================================================================
//   Capture: visible-tab screenshot + crop to video bounds + verify
// ============================================================================

async function captureTab(windowId) {
  return new Promise((resolve, reject) => {
    chrome.tabs.captureVisibleTab(windowId, { format: 'jpeg', quality: 88 }, (img) => {
      const err = chrome.runtime.lastError;
      if (err) reject(new Error(err.message || 'captureVisibleTab failed'));
      else if (!img) reject(new Error('No image returned from captureVisibleTab.'));
      else resolve(img);
    });
  });
}

async function dataUrlToBitmap(dataUrl) {
  const blob = await (await fetch(dataUrl)).blob();
  return createImageBitmap(blob);
}

function bytesToBase64(bytes) {
  let bin = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    bin += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
  }
  return btoa(bin);
}

/** Crop the captured tab to the video bounds, return base64 JPEG. */
async function cropToBounds(dataUrl, bounds) {
  const bitmap = await dataUrlToBitmap(dataUrl);
  const dpr = bounds.dpr || 1;
  const sx = Math.max(0, Math.round(bounds.x * dpr));
  const sy = Math.max(0, Math.round(bounds.y * dpr));
  const sw = Math.min(bitmap.width - sx, Math.round(bounds.w * dpr));
  const sh = Math.min(bitmap.height - sy, Math.round(bounds.h * dpr));

  if (sw <= 0 || sh <= 0) {
    bitmap.close();
    throw new Error('Crop bounds are outside the captured image — keep the YouTube tab on screen.');
  }

  const canvas = new OffscreenCanvas(sw, sh);
  const ctx = canvas.getContext('2d');
  ctx.drawImage(bitmap, sx, sy, sw, sh, 0, 0, sw, sh);
  bitmap.close();

  // Quick brightness sample — detect mostly-black frames (DRM, transitions)
  const sampleW = Math.min(sw, 30), sampleH = Math.min(sh, 20);
  const sample = ctx.getImageData(0, 0, sw, sh, { willReadFrequently: false });
  let totalBrightness = 0, samples = 0;
  // Sample on a grid
  for (let y = 0; y < sampleH; y++) {
    for (let x = 0; x < sampleW; x++) {
      const px = ((Math.floor(sh * y / sampleH)) * sw + Math.floor(sw * x / sampleW)) * 4;
      totalBrightness += (sample.data[px] + sample.data[px + 1] + sample.data[px + 2]) / 3;
      samples++;
    }
  }
  const avgBrightness = totalBrightness / samples;

  const out = await canvas.convertToBlob({ type: 'image/jpeg', quality: 0.85 });
  const buf = await out.arrayBuffer();
  return {
    dataB64: bytesToBase64(new Uint8Array(buf)),
    avgBrightness,
    width: sw,
    height: sh,
  };
}

// ============================================================================
//   Job persistence + progress broadcasting
//   (No API key handling — requests are proxied through farzi.me which holds
//    the server-side Anthropic key.)
// ============================================================================

const _ports = new Set();
chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== 'progress') return;
  _ports.add(port);
  // Replay last known status to a freshly connected popup
  chrome.storage.local.get('__farzi_running').then(({ __farzi_running }) => {
    if (__farzi_running) port.postMessage({ type: 'replay', state: __farzi_running });
  });
  port.onDisconnect.addListener(() => _ports.delete(port));
});
function broadcast(event) {
  for (const p of _ports) { try { p.postMessage(event); } catch {} }
}

let _state = null; // mirrored to chrome.storage.local at __farzi_running
async function setState(patch) {
  _state = { ..._state, ...patch };
  await chrome.storage.local.set({ __farzi_running: _state });
}
async function clearState() {
  _state = null;
  await chrome.storage.local.remove('__farzi_running');
}

// ============================================================================
//   Heartbeat — keep service worker alive during long jobs
// ============================================================================

let _heartbeatInterval = null;
function startHeartbeat() {
  if (_heartbeatInterval) return;
  _heartbeatInterval = setInterval(async () => {
    // Any chrome.* call resets the SW idle timer
    try { await chrome.storage.session.set({ __hb: Date.now() }); }
    catch { try { await chrome.storage.local.set({ __hb: Date.now() }); } catch {} }
  }, 20_000);
}
function stopHeartbeat() {
  if (!_heartbeatInterval) return;
  clearInterval(_heartbeatInterval);
  _heartbeatInterval = null;
}

// ============================================================================
//   Job-storage hygiene — keep last 5 result jobs
// ============================================================================

async function trimOldJobs(keepCount = 5) {
  const all = await chrome.storage.local.get(null);
  const jobs = Object.entries(all).filter(([k]) => k.startsWith('job-'));
  if (jobs.length <= keepCount) return;
  jobs.sort((a, b) => (b[1]?.ts || 0) - (a[1]?.ts || 0));
  const toRemove = jobs.slice(keepCount).map(([k]) => k);
  if (toRemove.length) await chrome.storage.local.remove(toRemove);
}

// ============================================================================
//   The job
// ============================================================================

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

/** Wrap a phase so any thrown error includes which named step it came from. */
async function phase(name, fn) {
  try {
    return await fn();
  } catch (e) {
    const wrapped = new Error(`[${name}] ${e?.message || String(e)}`);
    wrapped.stack = (e?.stack || String(e));
    wrapped._stepName = name;
    wrapped._original = e;
    throw wrapped;
  }
}

async function runJob(tabId) {
  if (_state) {
    broadcast({ type: 'error', message: 'A job is already running. Wait for it to finish.' });
    return;
  }

  startHeartbeat();
  const t0 = Date.now();
  const elapsed = () => Math.round((Date.now() - t0) / 1000);

  await setState({
    status: 'running', message: 'starting…', frac: 0, elapsed: 0,
    warnings: [], tabId,
  });
  broadcast({ type: 'progress', message: 'starting…', frac: 0, elapsed: 0 });

  let tab;
  try { tab = await chrome.tabs.get(tabId); }
  catch { broadcast({ type: 'error', message: 'YouTube tab is gone.' }); await clearState(); stopHeartbeat(); return; }
  const windowId = tab.windowId;

  const update = async (message, frac) => {
    await setState({ message, frac, elapsed: elapsed() });
    broadcast({ type: 'progress', message, frac, elapsed: elapsed() });
  };
  const warn = async (message) => {
    const ws = (_state?.warnings || []).concat([message]).slice(-30);
    await setState({ warnings: ws });
    broadcast({ type: 'warning', message });
  };

  try {
    // ---------- 1. Player data ----------
    await update('reading video info', 0.06);
    const player = await phase('player-data', () => readPlayerData(tabId));
    if (!player) throw new Error('readPlayerData returned no data.');
    const vd = player.videoDetails || {};
    if (vd.isLive) throw new Error('FarziPedia doesn\'t support livestreams yet — try a finished video.');
    if (vd.isPrivate) throw new Error('This video is private.');

    const meta = {
      videoId: vd.videoId,
      title: vd.title || '',
      channel: vd.author || '',
      duration: parseFloat(vd.lengthSeconds || '0') || 0,
      shortDescription: vd.shortDescription || '',
    };
    await setState({ meta });
    broadcast({ type: 'meta', meta });

    if (meta.duration < 30) throw new Error('Video is too short (under 30s) to be worth blogging.');

    // ---------- 3. Transcript ----------
    await update('fetching transcript', 0.10);
    const transcriptResult = await phase('transcript', () => fetchTranscript(tabId, player));
    if (!transcriptResult || !Array.isArray(transcriptResult.snippets)) {
      throw new Error('Transcript fetch returned no snippets array.');
    }
    const { snippets, source: transcriptSource } = transcriptResult;
    console.log(`[FarziPedia] transcript via ${transcriptSource}: ${snippets.length} snippets`);
    if (snippets.length < 8) {
      throw new Error('This video\'s caption track has too few snippets to write from. Try a different video.');
    }

    // ---------- 4. Plan timestamps ----------
    await update('planning capture moments', 0.14);
    const maxFrames = Math.min(60, Math.max(20, Math.round(meta.duration / 60 * 3)));
    const timestamps = await phase('plan-timestamps', () =>
      Promise.resolve(planTimestamps(snippets, meta.duration, { maxTotal: maxFrames }))
    );
    if (!Array.isArray(timestamps) || !timestamps.length) {
      throw new Error('Timestamp planner returned no timestamps.');
    }

    // ---------- 5. Pre-flight + capture loop ----------
    await update('checking video player', 0.16);
    const pre = await phase('preflight', () => preflight(tabId));
    if (!pre || !pre.ok) throw new Error(pre?.reason || 'Pre-flight check returned no result.');

    const frames = [];
    for (let i = 0; i < timestamps.length; i++) {
      const t = timestamps[i];
      const m = Math.floor(t / 60), s = Math.floor(t % 60).toString().padStart(2, '0');
      const frac = 0.16 + 0.55 * ((i + 1) / timestamps.length);
      await update(`capturing frame ${i + 1}/${timestamps.length} (${m}:${s})`, frac);

      let captured = null;
      let lastErr = null;
      // up to 2 retries per frame: ad / black-frame / transient capture failure
      for (let attempt = 0; attempt < 3; attempt++) {
        try {
          // Verify tab still in valid state
          const cur = await chrome.tabs.get(tabId).catch(() => null);
          if (!cur) throw new Error('YouTube tab was closed.');

          // Re-check ad each attempt — they can start mid-loop
          const pre2 = await preflight(tabId);
          if (!pre2.ok) {
            lastErr = pre2.reason;
            await sleep(2000);
            continue;
          }

          const bounds = await seekAndPrepare(tabId, t);
          await sleep(120); // settle after seek

          const dataUrl = await captureTab(windowId);
          const cropped = await cropToBounds(dataUrl, bounds);

          // Black-frame guard — if the average brightness is super low, retry
          // (covers DRM-protected frames and transition cuts)
          if (cropped.avgBrightness < 12 && attempt < 2) {
            lastErr = `frame at ${m}:${s} came back nearly black (avg=${cropped.avgBrightness.toFixed(1)})`;
            // Nudge to a slightly different timestamp on retry
            await sleep(150);
            const nudged = t + (attempt === 0 ? 1.5 : -1.5);
            const newBounds = await seekAndPrepare(tabId, Math.max(0.5, nudged));
            await sleep(120);
            const altUrl = await captureTab(windowId);
            const altCrop = await cropToBounds(altUrl, newBounds);
            if (altCrop.avgBrightness >= 12) { captured = altCrop; break; }
            continue;
          }

          captured = cropped;
          break;
        } catch (e) {
          lastErr = String(e?.message || e);
          await sleep(400);
        }
      }

      if (captured) {
        frames.push({ timestamp: t, dataB64: captured.dataB64 });
      } else {
        await warn(`Skipped frame at ${m}:${s} — ${lastErr || 'unknown'}`);
      }
    }

    await restoreUi(tabId);

    if (frames.length === 0) {
      throw new Error('No frames could be captured. Make sure the YouTube tab is on screen and not blocked by an ad.');
    }
    if (frames.length < timestamps.length * 0.4) {
      await warn(`Only ${frames.length}/${timestamps.length} frames captured cleanly — the post may be sparse.`);
    }

    // ---------- 6. Claude (via farzi.me proxy) ----------
    await update(`asking Claude to write the post (${frames.length} frames)`, 0.78);
    const blog = await phase('claude', () => generateBlogWithRetry(snippets, frames, meta));
    if (!blog || typeof blog !== 'object') throw new Error('Claude returned no blog data.');

    blog.meta = {
      videoId: meta.videoId,
      url: `https://www.youtube.com/watch?v=${meta.videoId}`,
      title: meta.title,
      channel: meta.channel,
      durationSeconds: meta.duration,
      nFrames: frames.length,
      nFramesPlanned: timestamps.length,
      generatedAt: new Date().toISOString(),
    };

    // Stash for the result page
    const frameMap = {};
    for (const f of frames) frameMap[Math.round(f.timestamp)] = f.dataB64;

    const jobId = `job-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    await chrome.storage.local.set({ [jobId]: { blog, frames: frameMap, ts: Date.now() } });
    await trimOldJobs();

    // ---------- 7. Upload to farzi.me so the folio appears in the public library
    // Non-fatal: if the upload fails (network blip, server down), the local
    // result page still works. We surface it as a warning, not an error.
    await update('publishing to farzi.me', 0.96);
    try {
      const { url } = await phase('publish', () => uploadFolio(blog, frames, jobId));
      blog.meta.publicUrl = url;
      await chrome.storage.local.set({ [jobId]: { blog, frames: frameMap, ts: Date.now() } });
    } catch (e) {
      console.warn('[FarziPedia] publish to farzi.me failed:', e?.message || e);
      await warn(`Couldn't publish to farzi.me (${String(e?.message || e).slice(0, 120)}). The post is still saved locally.`);
    }

    await update('done', 1);
    broadcast({ type: 'done', jobId });
    chrome.tabs.create({ url: chrome.runtime.getURL(`result/result.html?job=${jobId}`) });
  } catch (e) {
    console.error('[FarziPedia] job failed:', e?.message || e);
    if (e?._stepName) console.error('  in step:', e._stepName);
    if (e?.stack) console.error('  stack:', e.stack);
    if (e?._original) console.error('  original error:', e._original);
    try { await restoreUi(tabId); } catch {}
    const stepHint = e?._stepName ? ` (during "${e._stepName}")` : '';
    broadcast({ type: 'error', message: friendlyError(e) + stepHint });
  } finally {
    await clearState();
    stopHeartbeat();
  }
}

// ---------- Claude with retry ----------
async function generateBlogWithRetry(snippets, frames, meta) {
  let last;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      return await generateBlog(snippets, frames, meta);
    } catch (e) {
      last = e;
      const msg = String(e?.message || e).toLowerCase();
      const transient = msg.includes('429') || msg.includes('5') && msg.includes('overloaded')
                     || msg.includes('timeout') || msg.includes('network');
      if (!transient || attempt === 2) throw e;
      await sleep(1500 * (attempt + 1));
    }
  }
  throw last;
}

// ---------- Friendly errors ----------
function friendlyError(e) {
  const raw = String(e?.message || e);
  const lower = raw.toLowerCase();
  if (lower.includes('401') || lower.includes('authentication') || lower.includes('503')) {
    return 'farzi.me proxy is misconfigured (no server-side API key). Try again later.';
  }
  if (lower.includes('429') || lower.includes('rate')) {
    return 'Too many requests in a short window. Wait a minute and try again.';
  }
  if (lower.includes('overload') || lower.includes('529')) {
    return 'Anthropic is overloaded right now. Try again in a couple of minutes.';
  }
  if (lower.includes('quota') || lower.includes('credit') || lower.includes('billing')) {
    return "farzi.me's Anthropic account is out of credit. The maintainer has been notified.";
  }
  if (lower.includes('captures') && lower.includes('chrome')) {
    return 'Chrome blocked the screenshot — make sure the YouTube tab is on screen and not minimized.';
  }
  if (raw.length > 400) return raw.slice(0, 400) + '…';
  return raw;
}

// ============================================================================
//   Entry points (popup → SW)
// ============================================================================

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  (async () => {
    try {
      switch (msg.type) {
        case 'START_JOB': {
          if (!msg.tabId) throw new Error('Missing tabId');
          // fire-and-forget so popup gets immediate ack
          runJob(msg.tabId);
          sendResponse({ ok: true });
          return;
        }
        case 'GET_VIDEO_INFO': {
          // Used by popup to populate the idle-state preview
          if (!msg.tabId) throw new Error('Missing tabId');
          const player = await readPlayerData(msg.tabId);
          const vd = player.videoDetails || {};
          sendResponse({ ok: true, data: {
            videoId: vd.videoId, title: vd.title || '',
            channel: vd.author || '',
            duration: parseFloat(vd.lengthSeconds || '0') || 0,
            isLive: !!vd.isLive,
            hasCaptions: !!player?.captions?.playerCaptionsTracklistRenderer?.captionTracks?.length,
          }});
          return;
        }
        case 'IS_RUNNING':
          sendResponse({ ok: true, data: !!_state });
          return;
        default:
          sendResponse({ ok: false, error: `Unknown message type: ${msg.type}` });
      }
    } catch (e) {
      sendResponse({ ok: false, error: String(e?.message || e) });
    }
  })();
  return true;
});

// On extension install / update, wipe any stale running state
chrome.runtime.onInstalled.addListener(() => clearState());
chrome.runtime.onStartup.addListener(() => clearState());
