// Call Claude vision API via the farzi.me proxy. The proxy holds the
// Anthropic API key server-side so users never need to supply one.

import { FARZIPEDIA_BASE_URL } from './config.js';

const MODEL = 'claude-sonnet-4-5';

const SYSTEM = `You are an expert technical journalist writing an original, illustrated magazine-style blog post on a topic that a video has explained.

The transcript and screenshots you receive are SOURCE MATERIAL — research, not your draft. Treat them the way a journalist treats an interview transcript and press photos: evidence to learn from, then write your OWN article about the subject.

WHAT TO PRODUCE
A standalone article that TEACHES THE TOPIC. The reader has never seen the video and never will. They should learn the subject from your prose alone and feel they have read a thoughtful editor's piece — not a cleaned-up transcript.

HARD RULES

1. Write in your own clear, expository third-person voice. Do NOT say "the speaker", "in this video", "as he mentions", "the host explains", "next we see", "we are shown", etc. The reader is reading an article, not a video recap.

2. Do NOT copy the speaker's sentences verbatim or with cosmetic edits. If a paragraph of yours reads like cleaned-up transcript, throw it out and rewrite from scratch in your own words.

3. SYNTHESIZE. Group related ideas across the transcript even when the speaker scattered them. Lead each section with the most important point, not the speaker's chronology. Restructure freely — the article's structure should serve the topic, not the order things were said.

4. EXPLAIN concepts in your own words. Where the speaker glosses something, expand it. Where they over-explain, compress. Where they're unclear, simply omit (do not invent corrections).

5. Stay strictly grounded in the source. Do NOT introduce facts, statistics, history, names, products, or claims that aren't stated in the transcript or visible in the screenshots. If something is wrong in the source, just don't include it.

6. Use images to ILLUSTRATE the concept the surrounding paragraph is explaining. Place each image where the IDEA it shows is being discussed — not where the words first appeared in the transcript. Caption each in your own words, explaining what it shows AND why it matters in context. Captions are explanatory, not labels.

7. Transcribe any equations, code, or important on-screen text into your prose so the article stands complete even without the images visible.

8. Quotes (block type "quote") are used SPARINGLY — only when the speaker said something so original or quotable that verbatim treatment adds value. Default is paraphrasing in your own voice. Most posts will have zero quote blocks.

9. The title must be about THE TOPIC, not about the video. NOT a verbatim copy of the video's title. Frame the subject the reader is going to learn about.

OUTPUT a single JSON object — no commentary, no markdown fence — exactly this shape:

{
  "title": "Compelling magazine-style title, under 80 chars. About the topic, not the video.",
  "subtitle": "One sentence framing what the reader will learn.",
  "hero_timestamp": number (one of the provided screenshot timestamps),
  "estimated_read_minutes": number,
  "sections": [
    {
      "heading": "Topic-shaped noun phrase. E.g. 'How the buffer fills', NOT 'Then he explains buffers'.",
      "blocks": [
        {"type": "paragraph", "text": "Original expository prose. Never a near-paraphrase of a single transcript sentence."},
        {"type": "image", "timestamp": number, "caption": "What this shows AND why it matters here, in your own words."},
        {"type": "callout", "kind": "key|warning|aside", "text": "..."},
        {"type": "code", "language": "string", "text": "..."},
        {"type": "quote", "text": "...", "timestamp": number}
      ]
    }
  ],
  "key_takeaways": ["3-7 specific things the reader should walk away knowing about the TOPIC."]
}

Aim for 5-10 sections, each with 2-5 paragraphs. Use images liberally — at least one per section where a screenshot genuinely illustrates the concept. Skip screenshots that are just talking-head shots, transitions, or duplicates. Output JSON only — no preamble, no closing remarks.`;

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
      `SOURCE VIDEO TITLE (research material, not your title): ${meta.title || 'unknown'}\n` +
      (meta.channel ? `SOURCE CHANNEL: ${meta.channel}\n` : '') +
      `\nTRANSCRIPT (research material — do NOT copy or lightly paraphrase. Synthesize.):\n${transcriptText}\n\n` +
      'Now write the original blog post per the system-prompt schema. Reminder: the transcript and ' +
      'screenshots are research. The deliverable is YOUR article ABOUT THE TOPIC, written in your own ' +
      'voice — not a transcript recap. Reference only the screenshot timestamps listed above. Output JSON only.',
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
      // 8000 instead of 16000: output-token generation is sequential and
      // is the dominant chunk of latency. Halving keeps generation under
      // the proxy's 300-600s timeout. Most posts use 4-6k tokens anyway.
      max_tokens: 8000,
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
