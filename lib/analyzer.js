// Call Claude vision API directly from the browser to turn
// transcript + frames into a structured blog post.

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
 * @param {string} apiKey  Anthropic API key
 * @param {Array<{start:number, duration:number, text:string}>} transcript
 * @param {Array<{timestamp:number, dataB64:string, mediaType:string}>} frames
 * @param {{title?:string, channel?:string}} meta
 * @returns {Promise<object>} the parsed blog dict
 */
export async function generateBlog(apiKey, transcript, frames, meta = {}) {
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

  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
      'anthropic-dangerous-direct-browser-access': 'true',
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
    let errBody = await res.text();
    try { errBody = JSON.stringify(JSON.parse(errBody)); } catch {}
    throw new Error(`Claude API error ${res.status}: ${errBody.slice(0, 500)}`);
  }
  const json = await res.json();
  let raw = json.content?.[0]?.text || '';
  raw = raw.trim();
  if (raw.startsWith('```')) {
    raw = raw.replace(/^```(?:json)?\n/, '').replace(/\n```$/, '');
  }
  return JSON.parse(raw);
}
