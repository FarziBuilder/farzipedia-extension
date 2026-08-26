// Call Claude vision API directly from the browser to turn
// transcript + frames into a structured blog post.

import { FARZIPEDIA_BASE_URL } from './config.js';

export const MODEL = 'claude-opus-4-8';

const SYSTEM = `You are an expert essayist and teacher. You turn YouTube videos into
original, beautifully written blog posts about the TOPIC the video teaches.

You receive a video as: (1) a timestamped transcript and (2) screenshots sampled
at specific timestamps. Study them deeply, work out what is actually being
taught — the core ideas, the intuitions, the connections between them — and then
write the post a thoughtful human expert would write about that topic.

What a great post looks like:
- It is written entirely in your own prose. It reads like a polished essay or a
  high-quality technical blog, never like captions or a lecture transcript.
- It is organized by IDEAS, not by video chronology. Reorder, merge, and
  restructure the material so each section develops one idea cleanly.
- It explains: define terms the first time they appear, give the intuition
  behind each claim, and spell out why each step or fact matters.
- It cuts everything that only makes sense as speech: filler, verbal asides,
  channel housekeeping ("like and subscribe"), sponsor reads, "as I said
  earlier", and repeated points.

Hard constraints:
- NEVER copy or lightly reword transcript sentences into body text. If a
  sentence in your draft could be matched back to a transcript line, rewrite it
  from scratch. The ONLY place the speaker's own words may appear is a "quote"
  block, used sparingly (at most one per section) for a genuinely striking line.
- Stay faithful to the video: every claim, number, and attribution must be
  supported by the transcript or visible in the screenshots. You may add brief
  standard background to make an explanation land, but never invent facts the
  video doesn't support.
- Every image you reference must be one of the provided screenshot timestamps.
  Pick the timestamp that best matches what the surrounding text explains. If
  two adjacent screenshots show the same thing, pick the clearer one and skip
  the duplicate. Ignore black frames, transitions, and unhelpful shots.
- Transcribe any equations, code, or important on-screen text into the body so
  the post stands alone without the images.

Output a single JSON object with this shape:

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

// Enforced response schema — same shape result.js already renders.
const BLOG_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['title', 'subtitle', 'hero_timestamp', 'estimated_read_minutes', 'sections', 'key_takeaways'],
  properties: {
    title: { type: 'string' },
    subtitle: { type: 'string' },
    hero_timestamp: { type: 'number' },
    estimated_read_minutes: { type: 'number' },
    sections: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['heading', 'blocks'],
        properties: {
          heading: { type: 'string' },
          blocks: {
            type: 'array',
            items: {
              anyOf: [
                {
                  type: 'object',
                  additionalProperties: false,
                  required: ['type', 'text'],
                  properties: { type: { const: 'paragraph' }, text: { type: 'string' } },
                },
                {
                  type: 'object',
                  additionalProperties: false,
                  required: ['type', 'timestamp', 'caption'],
                  properties: { type: { const: 'image' }, timestamp: { type: 'number' }, caption: { type: 'string' } },
                },
                {
                  type: 'object',
                  additionalProperties: false,
                  required: ['type', 'kind', 'text'],
                  properties: {
                    type: { const: 'callout' },
                    kind: { type: 'string', enum: ['key', 'warning', 'aside'] },
                    text: { type: 'string' },
                  },
                },
                {
                  type: 'object',
                  additionalProperties: false,
                  required: ['type', 'language', 'text'],
                  properties: { type: { const: 'code' }, language: { type: 'string' }, text: { type: 'string' } },
                },
                {
                  type: 'object',
                  additionalProperties: false,
                  required: ['type', 'text', 'timestamp'],
                  properties: { type: { const: 'quote' }, text: { type: 'string' }, timestamp: { type: 'number' } },
                },
              ],
            },
          },
        },
      },
    },
    key_takeaways: { type: 'array', items: { type: 'string' } },
  },
};

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
      'Think deeply about what this video is really teaching, then write the blog post ' +
      'as a single JSON object per the schema in the system prompt. Write it in your own ' +
      'prose — do not echo the transcript. Reference only the screenshot timestamps shown above.',
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
      // Thinking tokens count against max_tokens, so leave generous headroom.
      max_tokens: 32000,
      thinking: { type: 'adaptive' },
      output_config: {
        effort: 'high',
        format: { type: 'json_schema', schema: BLOG_SCHEMA },
      },
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
  if (json.stop_reason === 'max_tokens') {
    throw new Error('Claude ran out of output tokens before finishing the post (max_tokens hit).');
  }
  if (json.stop_reason === 'refusal') {
    throw new Error('Claude declined to process this video (refusal).');
  }
  // With thinking enabled, thinking blocks precede the text block — find it.
  let raw = (json.content || []).find(b => b.type === 'text')?.text || '';
  raw = raw.trim();
  if (raw.startsWith('```')) {
    raw = raw.replace(/^```(?:json)?\n/, '').replace(/\n```$/, '');
  }
  const blog = JSON.parse(raw);
  // Stamp which build produced this post, so stale output is identifiable.
  blog.generator = {
    model: MODEL,
    version: globalThis.chrome?.runtime?.getManifest?.().version || 'dev',
  };
  return blog;
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
 * @param {string} [repoName]    optional repo to file the folio into (created
 *                               on the server if it doesn't exist yet)
 */
export async function uploadFolio(blog, frames, jobId, repoName) {
  const base = FARZIPEDIA_BASE_URL.replace(/\/+$/, '');
  const res = await fetch(`${base}/v1/folios`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      job_id: jobId || undefined,
      repo_name: repoName || undefined,
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
