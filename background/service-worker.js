// FarziPedia background service worker — the entire pipeline.
// Page interaction goes through chrome.scripting.executeScript({world: 'MAIN'})
// so we read YouTube's real globals, not the isolated-world view.

import { planTimestamps } from '../lib/planner.js';
import { generateBlog, uploadFolio, resolveFarziBase, MODEL } from '../lib/analyzer.js';
import { BUILTIN_API_KEY } from '../lib/config.js';

console.log(`[FarziPedia] service worker v${chrome.runtime.getManifest().version} · model ${MODEL}`);

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

/** Set (or, for null/'', delete) query params on a URL. */
function withQuery(baseUrl, params) {
  const u = new URL(baseUrl, 'https://www.youtube.com');
  for (const [k, v] of Object.entries(params)) {
    if (v == null || v === '') u.searchParams.delete(k);
    else u.searchParams.set(k, v);
  }
  return u.toString();
}

/** Decode the HTML entities YouTube uses in caption XML and page titles.
 * One pass, so "&amp;lt;" stays "&lt;" instead of being decoded twice. */
function decodeHtmlEntities(s) {
  const named = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };
  return (s || '').replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, ent) => {
    if (ent[0] === '#') {
      const hex = ent[1] === 'x' || ent[1] === 'X';
      const cp = parseInt(ent.slice(hex ? 2 : 1), hex ? 16 : 10);
      return cp >= 0 && cp <= 0x10ffff ? String.fromCodePoint(cp) : m;
    }
    return named[ent.toLowerCase()] ?? m;
  });
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
    const url = withQuery(baseUrl, { fmt, ...(useTlang ? { tlang: 'en' } : {}) });
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
    // Return the failure: a page-side throw reaches us as a bare null.
    if (!r.ok) return { __error: `InnerTube HTTP ${r.status}` };
    return r.json();
  }, [url, { context: cfg.ctx, params }]);
  if (data?.__error) throw new Error(data.__error);

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
//   Transcript layer 0: the player's own caption machinery (pot-aware)
// ============================================================================

/**
 * YouTube's /api/timedtext now demands a proof-of-origin ("pot") token that
 * only the page's own player can mint — raw caption baseUrls come back empty
 * or 5xx without it. So: quietly load the player's captions module, let the
 * player fire its own timedtext request, steal that URL (pot included),
 * refetch it as json3, and parse the events. Afterwards the captions module
 * is put back the way the viewer had it (the capture stylesheet hides the
 * caption window, so no subtitles burn into the screenshots).
 */
async function fetchTranscriptViaPlayer(tabId) {
  const result = await execInPage(tabId, async () => {
    const sleep = (ms) => new Promise(r => setTimeout(r, ms));
    const player = document.querySelector('#movie_player');
    if (!player || typeof player.loadModule !== 'function') {
      return { ok: false, error: 'No #movie_player with a loadModule API.' };
    }
    const vid = new URLSearchParams(location.search).get('v') || '';
    const vidRe = new RegExp(`[?&]v=${vid}(?:&|$)`);
    const isOurs = (name) => name.includes('/api/timedtext') && (!vid || vidRe.test(name));
    // Requests the player made before we started (the viewer had CC on)
    // carry a valid pot too. Picking the track that's already showing
    // doesn't refetch, so keep these as a fallback.
    const earlier = performance.getEntriesByType('resource').map(e => e.name).filter(isOurs);
    // Watch for new requests with an observer: getEntriesByType() stops
    // seeing new entries once the page's 250-entry timing buffer is full,
    // which a long-lived YouTube tab reaches easily.
    const fresh = [];
    let observer = null;
    try {
      observer = new PerformanceObserver((list) => {
        for (const e of list.getEntries()) if (isOurs(e.name)) fresh.push(e.name);
      });
      observer.observe({ type: 'resource' });
    } catch {}

    // Leave the viewer's own subtitles the way we found them.
    let trackBefore = null;
    try { trackBefore = player.getOption('captions', 'track'); } catch {}
    const ccWasOn = document.querySelector('.ytp-subtitles-button')?.getAttribute('aria-pressed') === 'true'
      || !!trackBefore?.languageCode;
    try {
      player.loadModule('captions');
      let tracklist = [];
      for (let i = 0; i < 12 && !tracklist.length; i++) {
        try { tracklist = player.getOption('captions', 'tracklist', { includeAsr: true }) || []; } catch {}
        if (!tracklist.length) tracklist = player.getOption('captions', 'tracklist') || [];
        if (!tracklist.length) await sleep(250);
      }
      // An empty tracklist doesn't mean "no captions": the player can still
      // fetch its default track, so wait for a request either way.
      const score = (t) => (t.languageCode === 'en' ? 100 : 0) + (t.kind !== 'asr' ? 30 : 0);
      const track = tracklist.length ? [...tracklist].sort((a, b) => score(b) - score(a))[0] : null;
      if (track) player.setOption('captions', 'track', track);

      // Wait for the player's own timedtext request; if none comes, fall
      // back to ones it made before we started.
      const t0 = Date.now();
      while (Date.now() - t0 < 8000 && !fresh.length) {
        if (earlier.length && Date.now() - t0 > 2000) break;
        await sleep(250);
      }
      // Newest first. A request made around an ad can come back empty, so
      // try a few before giving up.
      const urls = [...new Set([...fresh].reverse().concat([...earlier].reverse()))].slice(0, 4);
      if (!urls.length) {
        return { ok: false, error: track
          ? 'Player never fetched timedtext (captions module stayed idle).'
          : 'Player captions module lists no tracks.' };
      }

      let lastError = '';
      for (const url of urls) {
        const u = new URL(url, location.href);
        u.searchParams.set('fmt', 'json3');
        const lang = u.searchParams.get('lang') || track?.languageCode || '';
        if (lang && !/^en\b/i.test(lang)) u.searchParams.set('tlang', 'en');
        else u.searchParams.delete('tlang');
        const r = await fetch(u.toString(), { credentials: 'include' });
        if (!r.ok) { lastError = `timedtext(pot) HTTP ${r.status}`; continue; }
        const text = await r.text();
        if (!text.trim()) { lastError = 'timedtext(pot) returned an empty body.'; continue; }
        let events;
        try { events = JSON.parse(text).events || []; }
        catch { lastError = 'timedtext(pot) response was not json3.'; continue; }
        const snippets = [];
        for (const ev of events) {
          if (!ev.segs) continue;
          const t = ev.segs.map(s => s.utf8 || '').join('').replace(/\s+/g, ' ').trim();
          if (!t) continue;
          snippets.push({ start: (ev.tStartMs || 0) / 1000, duration: (ev.dDurationMs || 0) / 1000, text: t });
        }
        if (snippets.length) return { ok: true, snippets };
        lastError = 'timedtext(pot) parsed to 0 snippets.';
      }
      return { ok: false, error: `${lastError} (tried ${urls.length} request${urls.length > 1 ? 's' : ''})` };
    } catch (e) {
      return { ok: false, error: 'player-captions threw: ' + (e?.message || String(e)) };
    } finally {
      try { observer?.disconnect(); } catch {}
      try {
        if (!ccWasOn) player.unloadModule('captions');
        else if (trackBefore?.languageCode) player.setOption('captions', 'track', trackBefore);
      } catch {}
    }
  });
  if (!result) throw new Error('player-captions returned no result (injection refused?).');
  if (!result.ok) throw new Error(result.error);
  return result.snippets;
}

// ============================================================================
//   Transcript orchestrator — four layers
// ============================================================================

/** Try layer 0 (player pot fetch), 1 (timedtext), 2 (InnerTube), 3 (DOM scrape) — first success wins. */
async function fetchTranscript(tabId, playerData) {
  const errors = [];

  // ---------- Layer 0: the player's own caption fetch (carries the pot) ----------
  try {
    const snippets = await fetchTranscriptViaPlayer(tabId);
    if (Array.isArray(snippets) && snippets.length) {
      return { snippets, source: 'player-pot' };
    }
    errors.push('player: empty result');
  } catch (e) {
    errors.push('player: ' + (e?.message || e));
  }

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
    `All four transcript methods failed: ${errors.join(' | ')}. ` +
    `Try refreshing the YouTube tab (Ctrl+R), then retry.`
  );
}

/** Pre-flight: video element exists, ready to play, no ad showing, sane bounds. */
async function preflight(tabId) {
  return execInPage(tabId, async () => {
    // Screenshots come from the visible tab, and requestAnimationFrame is
    // paused in hidden tabs — a backgrounded tab can only produce timeouts.
    // Fail fast with the real reason instead.
    if (document.visibilityState !== 'visible') {
      return { ok: false, reason: 'The YouTube tab is hidden — switch back to it and keep it on screen while the codex renders.' };
    }
    const v = document.querySelector('video.html5-main-video') || document.querySelector('video');
    if (!v) return { ok: false, reason: 'No <video> element on the page.' };

    // Detect ads
    const adShowing =
      document.querySelector('.ad-showing') ||
      document.querySelector('.ytp-ad-player-overlay') ||
      document.querySelector('.ytp-ad-skip-button') ||
      document.querySelector('.ytp-ad-text');
    if (adShowing) return { ok: false, reason: 'An ad is currently playing. Skip the ad in the player, then click Render again.' };

    // YouTube's caption + pot machinery only wakes up once playback has
    // started (-1 = unstarted, 5 = cued), and frames need decoded video.
    const state = document.querySelector('#movie_player')?.getPlayerState?.();
    if (state === -1 || state === 5) return { ok: false, reason: 'Press play on the video for a moment (skip any ad), then click Render again.' };

    // readyState >= 2 (HAVE_CURRENT_DATA)
    if (v.readyState < 2) return { ok: false, reason: 'Video isn\'t ready yet — let it buffer for a few seconds and retry.' };

    let r = v.getBoundingClientRect();
    if (r.width < 100 || r.height < 60) return { ok: false, reason: 'Video player is hidden or too small. Make sure the YouTube tab is on screen.' };
    // Frames are cropped out of a screenshot of the viewport, so the whole
    // player has to be on screen — scroll it back if the viewer moved away.
    if (r.top < 0 || r.left < 0 || r.bottom > window.innerHeight || r.right > window.innerWidth) {
      try { v.scrollIntoView({ block: 'center', inline: 'nearest', behavior: 'instant' }); }
      catch { v.scrollIntoView({ block: 'center', inline: 'nearest' }); }
      await new Promise(res => setTimeout(res, 300)); // let any smooth scroll settle
      r = v.getBoundingClientRect();
    }
    if (r.bottom <= 0 || r.top >= window.innerHeight) return { ok: false, reason: 'Video element is scrolled off-screen. Scroll it into view and retry.' };

    return { ok: true, duration: v.duration };
  });
}

/** Seek video to `t` seconds, hide overlays, return bounds for cropping. */
async function seekAndPrepare(tabId, t) {
  // chrome.scripting turns a page-side throw or rejection into a bare null,
  // so the page code reports failures as { error } instead.
  const res = await execInPage(tabId, async (timestamp) => {
    const v = document.querySelector('video.html5-main-video') || document.querySelector('video');
    if (!v) return { error: 'Video element disappeared.' };

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
        /* === YouTube site-level chrome (ytd-* custom elements) ===
           These are position:fixed at the top of the viewport and visually
           overlap the top of the <video> element, so they leak into a
           captureVisibleTab crop of the video bounds. Use display:none
           so they're removed from the paint tree entirely. */
        ytd-masthead,
        #masthead-container,
        #masthead,
        tp-yt-app-header,
        tp-yt-iron-overlay-backdrop,
        ytd-popup-container,
        ytd-mealbar-promo-renderer,
        ytd-button-renderer.style-scope.ytd-masthead,
        #consent-bump-v2-lightbox,
        ytd-consent-bump-v2-lightbox,
        ytd-engagement-panel-section-list-renderer[modern-panels] {
          display: none !important;
        }

        /* === In-player chrome === Hidden via visibility so the player
           keeps its layout (some code reads the player rect). */
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
        .ytp-caption-window-container,
        .caption-window,
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
      '.ytp-gradient-bottom', '.ytp-cc-window-container', '.ytp-caption-window-container', '.ytp-pause-overlay',
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

    return new Promise((resolve) => {
      const safeT = Math.min(Math.max(0.1, timestamp), v.duration - 0.5);
      const cleanup = () => {
        v.removeEventListener('seeked', onSeeked);
        v.removeEventListener('error', onError);
        clearTimeout(timer);
      };
      const fail = (error) => { cleanup(); resolve({ error }); };
      const timer = setTimeout(() => fail(`Seek to ${timestamp}s timed out.`), 10_000);
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
      const onError = () => fail('Video errored during seek.');
      v.addEventListener('seeked', onSeeked, { once: true });
      v.addEventListener('error', onError, { once: true });
      try { v.currentTime = safeT; }
      catch (e) { fail('Seek call failed: ' + (e.message || e)); }
    });
  }, [t]);
  if (!res) throw new Error('Seek returned nothing — the YouTube page refused the script.');
  if (res.error) throw new Error(res.error);
  return res;
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
    // Drop the force-autohide class so the user gets normal chrome back.
    // YouTube re-adds .ytp-autohide itself when the cursor goes idle.
    const player = document.querySelector('.html5-video-player');
    if (player) player.classList.remove('ytp-autohide-active');
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

// Long-edge cap for frames. HiDPI screens otherwise produce 2000–3000px
// crops, and the Claude API rejects images over 2000px in any request with
// more than 20 images (and caps the whole request at 32 MB).
const MAX_FRAME_EDGE = 1600;

/** Crop the captured tab to the video bounds, return base64 JPEG. */
async function cropToBounds(dataUrl, bounds) {
  const bitmap = await dataUrlToBitmap(dataUrl);
  const dpr = bounds.dpr || 1;
  // Intersect the player with the captured viewport. Clamping only the
  // origin would pull page content into the frame whenever the player
  // sticks out past an edge.
  const sx = Math.max(0, Math.round(bounds.x * dpr));
  const sy = Math.max(0, Math.round(bounds.y * dpr));
  const sw = Math.min(bitmap.width, Math.round((bounds.x + bounds.w) * dpr)) - sx;
  const sh = Math.min(bitmap.height, Math.round((bounds.y + bounds.h) * dpr)) - sy;

  if (sw <= 0 || sh <= 0) {
    bitmap.close();
    throw new Error('Crop bounds are outside the captured image — keep the YouTube tab on screen.');
  }

  const scale = Math.min(1, MAX_FRAME_EDGE / Math.max(sw, sh));
  const ow = Math.max(1, Math.round(sw * scale));
  const oh = Math.max(1, Math.round(sh * scale));
  const canvas = new OffscreenCanvas(ow, oh);
  const ctx = canvas.getContext('2d');
  ctx.imageSmoothingQuality = 'high'; // keep on-screen text legible when shrinking
  ctx.drawImage(bitmap, sx, sy, sw, sh, 0, 0, ow, oh);
  bitmap.close();

  // Quick brightness sample — detect mostly-black frames (DRM, transitions)
  const sampleW = Math.min(ow, 30), sampleH = Math.min(oh, 20);
  const sample = ctx.getImageData(0, 0, ow, oh, { willReadFrequently: false });
  let totalBrightness = 0, samples = 0;
  // Sample on a grid
  for (let y = 0; y < sampleH; y++) {
    for (let x = 0; x < sampleW; x++) {
      const px = ((Math.floor(oh * y / sampleH)) * ow + Math.floor(ow * x / sampleW)) * 4;
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
    width: ow,
    height: oh,
  };
}

// ============================================================================
//   API key
// ============================================================================

async function getApiKey() {
  const { anthropicApiKey } = await chrome.storage.sync.get('anthropicApiKey');
  const key = (anthropicApiKey || '').trim() || (BUILTIN_API_KEY || '').trim();
  if (!key) {
    throw new Error('No Claude API key configured. Either fill in lib/config.js or paste one in the popup.');
  }
  return key;
}

// ============================================================================
//   Job persistence + progress broadcasting
// ============================================================================

const _ports = new Set();
chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== 'progress') return;
  _ports.add(port);
  // Replay last known status to a freshly connected popup
  if (_state) port.postMessage({ type: 'replay', state: _state });
  port.onDisconnect.addListener(() => _ports.delete(port));
});
function broadcast(event) {
  for (const p of _ports) { try { p.postMessage(event); } catch {} }
}

let _state = null; // mirrored to chrome.storage.local at __farzi_running

// A job only lives in this worker's memory, so a __farzi_running left in
// storage when the worker starts is from a worker that died mid-run. Record
// it as interrupted and clear it — otherwise the popup shows a frozen
// progress bar forever.
const _staleStateCleanup = (async () => {
  try {
    const { __farzi_running: ghost } = await chrome.storage.local.get('__farzi_running');
    if (!ghost || _state) return;
    await chrome.storage.local.set({
      __farzi_lastrun: {
        ok: false,
        kind: ghost.playlist ? 'playlist' : 'video',
        finishedAt: Date.now(),
        warnings: (ghost.warnings || []).slice(-30),
        error: `Interrupted at "${ghost.message || 'unknown step'}" — the extension restarted mid-run. Start it again.`,
      },
    });
    await chrome.storage.local.remove('__farzi_running');
  } catch {}
})();
async function setState(patch) {
  _state = { ..._state, ...patch };
  await chrome.storage.local.set({ __farzi_running: _state });
}
async function clearState() {
  _state = null;
  await chrome.storage.local.remove('__farzi_running');
}

/**
 * Persist a post-mortem of the run BEFORE clearState wipes the live state,
 * so the popup can show what actually happened after a failed run — the
 * per-video warnings are otherwise unrecoverable once the popup closes.
 */
async function saveLastRun(record) {
  try {
    await chrome.storage.local.set({
      __farzi_lastrun: {
        finishedAt: Date.now(),
        warnings: (_state?.warnings || []).slice(-30),
        ...record,
      },
    });
  } catch {}
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
  // Job keys are `job-<Date.now()>-<rand>`, so sort by key — loading every
  // job's frames just to read `ts` would pull hundreds of MB after a playlist.
  const keys = chrome.storage.local.getKeys
    ? await chrome.storage.local.getKeys()
    : Object.keys(await chrome.storage.local.get(null));
  const jobKeys = keys.filter(k => k.startsWith('job-'));
  if (jobKeys.length <= keepCount) return;
  const created = (k) => parseInt(k.split('-')[1], 10) || 0;
  jobKeys.sort((a, b) => created(b) - created(a));
  await chrome.storage.local.remove(jobKeys.slice(keepCount));
}

// ============================================================================
//   The job
// ============================================================================

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

/** Race a promise against a timeout. Guards against page-side waits that can
 * never settle (e.g. requestAnimationFrame is paused in a hidden tab). */
function withTimeout(promise, ms, label) {
  return Promise.race([
    promise,
    new Promise((_, rej) => setTimeout(() => rej(new Error(label)), ms)),
  ]);
}

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

/**
 * Process the video currently loaded in `tabId`: read → transcript → frames →
 * Claude → publish. Throws on failure. Progress flows through the provided
 * `update`/`warn` callbacks so single-video and playlist runs can scale it.
 * Returns { jobId, publicUrl, title }.
 */
async function processVideo(tabId, windowId, { apiKey, update, warn, repoName = null, trimKeep = 5 }) {
    // ---------- 2. Player data ----------
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

    // Fail fast on a player we can't use (not started, ad, hidden tab)
    // before the transcript fallbacks spend a minute failing for that reason.
    await update('checking video player', 0.08);
    const pre0 = await phase('preflight', () => preflight(tabId));
    if (!pre0 || !pre0.ok) throw new Error(pre0?.reason || 'Pre-flight check returned no result.');

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
    let consecutiveSkips = 0;
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

          const bounds = await withTimeout(seekAndPrepare(tabId, t), 20_000,
            'seek+render timed out — keep the YouTube tab visible');
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
            const newBounds = await withTimeout(seekAndPrepare(tabId, Math.max(0.5, nudged)), 20_000,
              'seek+render timed out — keep the YouTube tab visible');
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
        consecutiveSkips = 0;
      } else {
        await warn(`Skipped frame at ${m}:${s} — ${lastErr || 'unknown'}`);
        consecutiveSkips++;
        // Nothing has worked yet and five frames in a row just failed the
        // same way — this video isn't capturable right now. Bail with the
        // real reason instead of grinding through every remaining timestamp.
        if (consecutiveSkips >= 5 && frames.length === 0) {
          throw new Error(`Capture is failing repeatedly — ${lastErr || 'unknown reason'}`);
        }
      }
    }

    await restoreUi(tabId);

    if (frames.length === 0) {
      throw new Error('No frames could be captured. Make sure the YouTube tab is on screen and not blocked by an ad.');
    }
    if (frames.length < timestamps.length * 0.4) {
      await warn(`Only ${frames.length}/${timestamps.length} frames captured cleanly — the post may be sparse.`);
    }

    // ---------- 6. Claude ----------
    await update(`asking Claude to write the post (${frames.length} frames)`, 0.78);
    const blog = await phase('claude', () => generateBlogWithRetry(apiKey, snippets, frames, meta));
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
    await trimOldJobs(trimKeep);

    // ---------- 7. Upload to farzipedia.com so the folio appears in the public library
    // Non-fatal: if the upload fails (network blip, server down), the local
    // result page still works. We surface it as a warning, not an error.
    await update('publishing to farzipedia.com', 0.96);
    try {
      const { url } = await phase('publish', () => uploadFolio(blog, frames, jobId, repoName));
      blog.meta.publicUrl = url;
      await chrome.storage.local.set({ [jobId]: { blog, frames: frameMap, ts: Date.now() } });
    } catch (e) {
      console.warn('[FarziPedia] publish to farzipedia.com failed:', e?.message || e);
      await warn(`Couldn't publish to farzipedia.com (${String(e?.message || e).slice(0, 120)}). The post is still saved locally.`);
    }

    return { jobId, publicUrl: blog.meta.publicUrl || null, title: meta.title };
}

// ---------- Single-video job ----------

async function runJob(tabId) {
  await _staleStateCleanup;
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
    await update('reading API key', 0.02);
    const apiKey = await phase('api-key', () => getApiKey());

    const res = await processVideo(tabId, windowId, { apiKey, update, warn });

    await update('done', 1);
    await saveLastRun({ ok: true, kind: 'video', published: res.publicUrl ? 1 : 0, total: 1 });
    broadcast({ type: 'done', jobId: res.jobId });
    // Send the reader to the folio's public farzi.me page; the local result
    // page is only the fallback for when publishing failed.
    chrome.tabs.create({
      url: res.publicUrl || chrome.runtime.getURL(`result/result.html?job=${res.jobId}`),
    });
  } catch (e) {
    console.error('[FarziPedia] job failed:', e?.message || e);
    if (e?._stepName) console.error('  in step:', e._stepName);
    if (e?.stack) console.error('  stack:', e.stack);
    if (e?._original) console.error('  original error:', e._original);
    try { await restoreUi(tabId); } catch {}
    const stepHint = e?._stepName ? ` (during "${e._stepName}")` : '';
    await saveLastRun({ ok: false, kind: 'video', error: friendlyError(e) + stepHint });
    broadcast({ type: 'error', message: friendlyError(e) + stepHint });
  } finally {
    await clearState();
    stopHeartbeat();
  }
}

// ============================================================================
//   Playlist job — walk every video in a playlist through the same pipeline
// ============================================================================

/** Extract a playlist id from any YouTube URL. Rejects mixes/radio (RD…). */
function parsePlaylistId(url) {
  const m = /[?&]list=([A-Za-z0-9_-]{10,})/.exec(url || '');
  if (!m) return null;
  if (/^(RD|UL)/.test(m[1])) return null; // auto-generated mixes can't be listed
  return m[1];
}

/** Fetch the playlist page and pull ordered video ids + the playlist title. */
async function fetchPlaylistVideos(listId) {
  const res = await fetch(`https://www.youtube.com/playlist?list=${listId}&hl=en`, {
    credentials: 'omit',
  });
  if (!res.ok) throw new Error(`Could not load the playlist page (HTTP ${res.status}).`);
  const html = await res.text();

  // YouTube has shipped several playlist markups; try them newest-first and
  // keep the first pattern that yields anything. All preserve playlist order.
  // No looser fallback on purpose: a bare "videoId" scan can pull unrelated
  // ids from the page and burn API credits on videos that aren't in the list.
  const patterns = [
    /"playlistVideoRenderer":\{"videoId":"([A-Za-z0-9_-]{11})"/g, // classic markup
    /"contentId":"([A-Za-z0-9_-]{11})"/g,                         // 2026 lockupViewModel markup
  ];
  let ids = [];
  for (const re of patterns) {
    const seen = new Set();
    const found = [];
    let m;
    while ((m = re.exec(html)) !== null) {
      if (!seen.has(m[1])) { seen.add(m[1]); found.push(m[1]); }
    }
    if (found.length) { ids = found; break; }
  }

  let title = '';
  const tm = /<title>([^<]*)<\/title>/.exec(html);
  if (tm) title = decodeHtmlEntities(tm[1]).replace(/\s*-\s*YouTube\s*$/, '').trim();

  return { ids, title };
}

/** After navigating, wait until the watch page + player are actually ready. */
async function waitForWatchPage(tabId, videoId, timeoutMs = 60_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const tab = await chrome.tabs.get(tabId).catch(() => null);
    if (!tab) throw new Error('YouTube tab was closed.');
    if (tab.status === 'complete' && (tab.url || '').includes(videoId)) {
      const ready = await execInPage(tabId, () => {
        // Start the player if autoplay didn't (the run mutes the tab):
        // captions and capture both need a started video.
        const p = document.querySelector('#movie_player');
        const state = p?.getPlayerState?.();
        if (state === -1 || state === 5) { try { p.playVideo(); } catch {} }
        const v = document.querySelector('video.html5-main-video') || document.querySelector('video');
        return !!(v && v.readyState >= 2 && v.duration > 0);
      }).catch(() => false);
      if (ready) {
        const pd = await readPlayerData(tabId).catch(() => null);
        if (pd?.videoDetails?.videoId === videoId) return;
      }
    }
    await sleep(1000);
  }
  throw new Error('Timed out waiting for the video page to load.');
}

const PLAYLIST_MAX_VIDEOS = 50;
const YOUTUBE_URL_RE = /^https:\/\/([a-z0-9-]+\.)?youtube\.com\//i;

async function runPlaylistJob(tabId, playlistUrl) {
  await _staleStateCleanup;
  if (_state) {
    broadcast({ type: 'error', message: 'A job is already running. Wait for it to finish.' });
    return;
  }
  const listId = parsePlaylistId(playlistUrl);
  if (!listId) {
    broadcast({ type: 'error', message: 'That link has no usable playlist id (auto-generated mixes aren\'t supported).' });
    return;
  }
  // The run navigates this tab from video to video. Only take over a YouTube
  // tab: any other page would lose whatever the user had open, and the
  // cross-origin hop drops the activeTab grant that screenshots need.
  const startTab = await chrome.tabs.get(tabId).catch(() => null);
  if (!YOUTUBE_URL_RE.test(startTab?.url || '')) {
    broadcast({ type: 'error', message: 'Start a playlist from a YouTube tab — FarziPedia plays the videos in that tab.' });
    return;
  }

  startHeartbeat();
  const t0 = Date.now();
  const elapsed = () => Math.round((Date.now() - t0) / 1000);

  await setState({
    status: 'running', message: 'reading playlist…', frac: 0, elapsed: 0,
    warnings: [], tabId, playlist: listId,
  });
  broadcast({ type: 'progress', message: 'reading playlist…', frac: 0, elapsed: 0 });

  const update = async (message, frac) => {
    await setState({ message, frac, elapsed: elapsed() });
    broadcast({ type: 'progress', message, frac, elapsed: elapsed() });
  };
  const warn = async (message) => {
    const ws = (_state?.warnings || []).concat([message]).slice(-30);
    await setState({ warnings: ws });
    broadcast({ type: 'warning', message });
  };

  let muted = false;
  try {
    const apiKey = await phase('api-key', () => getApiKey());

    const { ids, title } = await phase('playlist', () => fetchPlaylistVideos(listId));
    if (!ids.length) throw new Error('No videos found in that playlist — it may be private, empty, or deleted (YouTube serves a normal-looking page for dead playlists).');
    const videos = ids.slice(0, PLAYLIST_MAX_VIDEOS);
    if (ids.length > videos.length) {
      await warn(`Playlist has ${ids.length} videos — processing the first ${videos.length}.`);
    }
    const repoName = (title || `Playlist ${listId}`).slice(0, 120);
    await update(`playlist "${repoName}" — ${videos.length} videos`, 0.01);

    // Spare the user's ears while the tab hops from video to video.
    try { await chrome.tabs.update(tabId, { muted: true }); muted = true; } catch {}

    const published = [];
    const failures = [];
    for (let i = 0; i < videos.length; i++) {
      const vid = videos[i];
      const base = i / videos.length;
      const span = 1 / videos.length;
      const scopedUpdate = (message, frac) =>
        update(`[video ${i + 1}/${videos.length}] ${message}`, base + span * Math.min(0.99, frac || 0));
      try {
        await scopedUpdate('loading video page', 0);
        // Screenshots need the tab visible: bring it back to the front in
        // case the user wandered off to another tab, and un-minimize the
        // window if needed. (Without this, every capture times out.)
        try { await chrome.tabs.update(tabId, { active: true }); } catch {}
        try {
          const t = await chrome.tabs.get(tabId);
          const win = await chrome.windows.get(t.windowId);
          if (win.state === 'minimized') await chrome.windows.update(win.id, { state: 'normal' });
        } catch {}
        await chrome.tabs.update(tabId, { url: `https://www.youtube.com/watch?v=${vid}` });
        await waitForWatchPage(tabId, vid);
        await sleep(1500); // let the player settle

        const tab = await chrome.tabs.get(tabId);
        const res = await processVideo(tabId, tab.windowId, {
          apiKey, update: scopedUpdate, warn, repoName,
          trimKeep: videos.length + 5, // don't evict earlier videos of this run
        });
        published.push(res);
      } catch (e) {
        // If the tab itself is gone, the user killed the run — stop cleanly
        // instead of grinding through every remaining video.
        const stillThere = await chrome.tabs.get(tabId).catch(() => null);
        if (!stillThere) {
          await warn(`Stopped at video ${i + 1}/${videos.length} — the YouTube tab was closed.`);
          break;
        }
        const reason = friendlyError(e);
        failures.push(reason);
        // console.error (not warn) so chrome://extensions "Errors" keeps it.
        console.error(`[FarziPedia] playlist video ${i + 1}/${videos.length} (${vid}) failed:`, e?.message || e);
        await warn(`Video ${i + 1}/${videos.length} failed — ${reason.slice(0, 140)}`);
        try { await restoreUi(tabId); } catch {}

        // A bad/broke API key fails every video identically — and only after
        // each one has burned minutes on captures. Stop the whole run now.
        if (/rejected your key|out of credit|spend limit|no claude api key/i.test(reason)) {
          throw new Error(`Stopping the playlist — this will fail for every video: ${reason}`);
        }
        // Three failures before any success = something systematic. Abort
        // with the actual reasons instead of grinding through the rest.
        if (!published.length && failures.length >= 3) {
          throw new Error(`The first ${failures.length} videos all failed — stopping. First failure: ${failures[0]}`);
        }
      }
    }

    if (!published.length) {
      const patterns = [...new Set(failures.map(f => f.slice(0, 100)))].slice(0, 2);
      throw new Error(`Every video in the playlist failed. ${patterns.length ? `Reason(s): ${patterns.join(' | ')}` : 'No diagnostics were recorded.'}`);
    }
    const uploaded = published.filter(r => r.publicUrl);
    if (uploaded.length < published.length) {
      await warn(`${published.length - uploaded.length} folio(s) were generated but couldn't be published — they're in the extension's local library.`);
    }
    await update(`done — ${uploaded.length}/${videos.length} folios bound into the "${repoName}" tome`, 1);
    await saveLastRun({ ok: true, kind: 'playlist', published: uploaded.length, total: videos.length });
    broadcast({ type: 'done', jobId: published[published.length - 1].jobId });
    // Every folio reached the site: show it there. Otherwise open the local
    // library, which lists every post from this run.
    chrome.tabs.create({
      url: uploaded.length === published.length
        ? `${await resolveFarziBase()}/`
        : chrome.runtime.getURL('result/result.html'),
    });
  } catch (e) {
    console.error('[FarziPedia] playlist job failed:', e?.message || e);
    await saveLastRun({ ok: false, kind: 'playlist', error: friendlyError(e) });
    broadcast({ type: 'error', message: friendlyError(e) });
  } finally {
    if (muted) { try { await chrome.tabs.update(tabId, { muted: false }); } catch {} }
    await clearState();
    stopHeartbeat();
  }
}

// ---------- Claude with retry ----------
async function generateBlogWithRetry(apiKey, snippets, frames, meta) {
  let last;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      return await generateBlog(apiKey, snippets, frames, meta);
    } catch (e) {
      last = e;
      const msg = String(e?.message || e).toLowerCase();
      // Retry what the Anthropic SDKs retry: 408/409/429/5xx and dropped
      // connections (Chrome's fetch reports those as "Failed to fetch").
      const transient = /claude api error (408|409|429|5\d\d)\b/.test(msg)
                     || /overloaded|timed? ?out|network|failed to fetch/.test(msg);
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
  // Classify Claude failures by status code / error type only: bare
  // substrings like "rate" or "401" also match "generate", request ids and
  // YouTube errors (and a misread "bad key" aborts a whole playlist).
  const status = /claude api error (\d{3})/.exec(lower)?.[1];
  if (status === '401' || lower.includes('authentication_error')) {
    return 'Claude API rejected your key (401). Open the popup and paste a fresh key.';
  }
  if (status === '429' || lower.includes('rate_limit_error')) {
    return 'Anthropic rate-limited the request. Wait a minute and try again.';
  }
  if (status === '529' || lower.includes('overloaded_error')) {
    return 'Anthropic is overloaded right now. Try again in a couple of minutes.';
  }
  if (status && /credit balance|billing|quota|usage limit|spend limit/.test(lower)) {
    return 'Your Anthropic account is out of credit or hit its spend limit.';
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
        case 'START_PLAYLIST_JOB': {
          if (!msg.tabId) throw new Error('Missing tabId');
          if (!msg.playlistUrl) throw new Error('Missing playlistUrl');
          runPlaylistJob(msg.tabId, msg.playlistUrl);
          sendResponse({ ok: true });
          return;
        }
        case 'GET_PLAYLIST_INFO': {
          const listId = parsePlaylistId(msg.playlistUrl);
          if (!listId) throw new Error('No playlist id in that link (mixes/radios aren\'t supported).');
          const { ids, title } = await fetchPlaylistVideos(listId);
          sendResponse({ ok: true, data: { count: ids.length, title, listId } });
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
          // Settle any ghost state first, so the popup's next read of
          // storage already shows the interrupted run.
          await _staleStateCleanup;
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
