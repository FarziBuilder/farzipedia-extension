// Call Claude vision API via the farzi.me proxy. The proxy holds the
// Anthropic API key server-side so users never need to supply one.

import { FARZIPEDIA_BASE_URL } from './config.js';

const MODEL = 'claude-sonnet-4-5';

const SYSTEM = `You are a careful, visually-literate technical writer.

You receive a YouTube video as: (1) a timestamped transcript and (2) screenshots
sampled at specific timestamps. Your job is to write a detailed, beautifully
structured blog post about what was actually taught in the video.

Hard constraints:
- Only use information present in the transcript or visible in the provided
  screenshots. Do NOT add outside facts or context.
- Every image you reference must be one of the provided screenshot timestamps.
  Pick the timestamp that best matches what the surrounding text describes.
- If two adjacent screenshots show the same thing, pick the clearer one and
  skip the duplicate.
- If a screenshot is a black frame, transition, or otherwise unhelpful, do not
  reference it.
- Transcribe any equations, code, or important on-screen text into the body so
  the post stands alone without the images.
- Lightly clean transcript captions for readability (punctuation, casing,
  remove "um/uh"). Preserve the speaker's meaning. Do not paraphrase to the
  point of changing claims.

Output a single JSON object — no commentary, no markdown fence — with this shape:

{
  "title": "string (compelling, under 80 chars)",
  "subtitle": "string (one sentence, sets the stage)",
  "hero_timestamp": number (seconds; one of the provided screenshots),
  "estimated_read_minutes": number,
  "sections": [
    {
      "heading": "string (H2 section title)",
      "blocks": [
        {"type": "paragraph", "text": "..."},
        {"type": "image", "timestamp": number, "caption": "string (1 short line, original wording)"},
        {"type": "callout", "kind": "key|warning|aside", "text": "..."},
        {"type": "code", "language": "string", "text": "..."},
        {"type": "quote", "text": "...", "timestamp": number}
      ]
    }
  ],
  "key_takeaways": ["bullet 1", "bullet 2", ...]
}

Aim for 5-12 sections. Use images liberally — at least one image per section
when relevant material was on screen. Captions describe what's actually shown
(original phrasing, not a transcript quote).`;

/**
 * @param {Array<{start:number, duration:number, text:string}>} transcript
 * @param {Array<{timestamp:number, dataB64:string, mediaType:string}>} frames
 * @param {{title?:string, channel?:string}} meta
 * @returns {Promise<object>} the parsed blog dict
 */
export async function generateBlog(transcript, frames, meta = {}) {
  const content = [];
  for (const f of frames) {
    content.push({
      type: 'image',
      source: { type: 'base64', media_type: f.mediaType || 'image/jpeg', data: f.dataB64 },
    });
    const m = Math.floor(f.timestamp / 60);
    const s = Math.floor(f.timestamp % 60).toString().padStart(2, '0');
    content.push({ type: 'text', text: `^^ screenshot at ${f.timestamp.toFixed(1)}s (${m}:${s})` });
  }

  const transcriptText = transcript
    .map(s => `[${s.start.toFixed(2)}s] ${s.text}`)
    .join('\n');

  content.push({
    type: 'text',
    text:
      `VIDEO TITLE (best guess): ${meta.title || 'unknown'}\n` +
      (meta.channel ? `CHANNEL: ${meta.channel}\n` : '') +
      `\nTIMESTAMPED TRANSCRIPT:\n${transcriptText}\n\n` +
      'Now write the blog post as a single JSON object per the schema in the system prompt. ' +
      'Reference only the screenshot timestamps shown above. Output JSON only.',
  });

  const proxyUrl = `${FARZIPEDIA_BASE_URL.replace(/\/+$/, '')}/v1/proxy/messages`;
  const res = await fetch(proxyUrl, {
    method: 'POST',
    headers: {
      'anthropic-version': '2023-06-01',
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      model: MODEL,
      max_tokens: 16000,
      system: SYSTEM,
      messages: [{ role: 'user', content }],
    }),
  });

  if (!res.ok) {
    let errBody = '';
    try { errBody = await res.text(); } catch {}
    throw new Error(`Claude API error ${res.status}: ${errBody.slice(0, 500)}`);
  }

  // The proxy forces stream:true on every request and pipes Anthropic's
  // SSE response through to us. Read the stream, accumulate text deltas,
  // surface any error event. (Why streaming: a non-streaming call with
  // vision + many frames can easily exceed Cloudflare's idle timeout in
  // front of farzi.me, returning a 504. With SSE there's continuous data
  // flow in both directions, so no intermediary treats the connection
  // as idle.)
  if (!res.body) {
    throw new Error('Claude API: response has no body to stream.');
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder('utf-8');
  let buffer = '';
  let accumText = '';
  let errorPayload = null;

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });

    // Each SSE event is a block separated by a blank line ("\n\n").
    let sep;
    while ((sep = buffer.indexOf('\n\n')) >= 0) {
      const block = buffer.slice(0, sep);
      buffer = buffer.slice(sep + 2);

      let evtName = null;
      let dataStr = null;
      for (const line of block.split('\n')) {
        if (line.startsWith('event:')) {
          evtName = line.slice(6).trim();
        } else if (line.startsWith('data:')) {
          // Multi-line data is concatenated with newlines per SSE spec.
          const piece = line.slice(5).replace(/^ /, '');
          dataStr = dataStr === null ? piece : `${dataStr}\n${piece}`;
        }
      }
      if (dataStr === null) continue;

      if (evtName === 'error') {
        try { errorPayload = JSON.parse(dataStr); }
        catch { errorPayload = { message: dataStr }; }
        continue;
      }

      // Normal Anthropic event — parse and pluck text deltas.
      let parsed;
      try { parsed = JSON.parse(dataStr); } catch { continue; }
      if (
        parsed.type === 'content_block_delta' &&
        parsed.delta?.type === 'text_delta' &&
        typeof parsed.delta.text === 'string'
      ) {
        accumText += parsed.delta.text;
      } else if (parsed.type === 'message_delta' && parsed.delta?.stop_reason) {
        // Generation finished cleanly — message_stop will follow.
      } else if (parsed.type === 'error') {
        // Anthropic occasionally emits an inline error event without an
        // SSE event: name.
        errorPayload = parsed.error || parsed;
      }
    }
  }

  if (errorPayload) {
    const msg = errorPayload.message
      || errorPayload.error?.message
      || JSON.stringify(errorPayload).slice(0, 300);
    throw new Error(`Claude API error: ${msg}`);
  }

  let raw = accumText.trim();
  if (raw.startsWith('```')) {
    raw = raw.replace(/^```(?:json)?\n/, '').replace(/\n```$/, '');
  }
  if (!raw) {
    throw new Error('Claude API: stream ended with no text content.');
  }
  return JSON.parse(raw);
}

/**
 * Upload a generated folio (blog + frames) to farzi.me so it shows on the
 * homepage. Returns the public URL ({base}/blog/{job_id}) on success.
 * Throws on failure — callers should catch and log without breaking the
 * user's local result view.
 *
 * @param {object} blog          the parsed blog dict from generateBlog()
 * @param {Array<{timestamp:number, dataB64:string, mediaType?:string}>} frames
 * @param {string} [jobId]       optional suggested id (server may override)
 */
export async function uploadFolio(blog, frames, jobId) {
  const base = FARZIPEDIA_BASE_URL.replace(/\/+$/, '');
  const res = await fetch(`${base}/v1/folios`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      job_id: jobId || undefined,
      blog,
      frames: frames.map(f => ({
        timestamp: f.timestamp,
        dataB64: f.dataB64,
        mediaType: f.mediaType || 'image/jpeg',
      })),
    }),
  });
  if (!res.ok) {
    let errBody = '';
    try { errBody = await res.text(); } catch {}
    throw new Error(`Folio upload failed ${res.status}: ${errBody.slice(0, 300)}`);
  }
  const j = await res.json();
  return {
    jobId: j.job_id,
    url: j.url?.startsWith('http') ? j.url : `${base}${j.url || ''}`,
  };
}
