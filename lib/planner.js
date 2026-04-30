// Pick capture timestamps from a transcript.
// Mirrors the Python `planner.py` from the FastAPI version.

const CUE_PATTERNS = [
  /\bas you can see\b/i,
  /\blook at (this|that|the)\b/i,
  /\bhere we have\b/i,
  /\bon (the )?screen\b/i,
  /\bin this (diagram|figure|chart|graph|plot|image|picture)\b/i,
  /\blet me show you\b/i,
  /\bif you look at\b/i,
  /\bnotice (the|how|that)\b/i,
  /\bsee (the|this|that|how)\b/i,
  /\bthis is (a|an|the)\b/i,
  /\bwatch (what|this|the)\b/i,
  /\b(let'?s|i'?ll) (write|draw|sketch|plot|build)\b/i,
  /\bon the (left|right|top|bottom)\b/i,
  /\bthe (red|blue|green|yellow|orange|purple) (line|arrow|box|circle|dot|curve)\b/i,
  /\b(this|that) (function|equation|formula|line|column|row|graph|diagram|chart)\b/i,
  /\b(line|equation) \d+\b/i,
  /\blet (x|y|n|t|f) (equal|be)\b/i,
  /\bwatch the (output|result|screen)\b/i,
  /\b(diagram|schematic|figure)\b/i,
  /\b(tier list|tier|s tier|a tier|b tier|c tier|d tier|f tier)\b/i,
];

function hasCue(text) {
  for (const re of CUE_PATTERNS) if (re.test(text)) return true;
  return false;
}

/**
 * @param {Array<{start:number, duration:number, text:string}>} snippets
 * @param {number} videoDuration  in seconds
 * @param {{baselineInterval?:number, cueOffset?:number, maxTotal?:number}} opts
 * @returns {number[]}
 */
export function planTimestamps(snippets, videoDuration, opts = {}) {
  const baseline = opts.baselineInterval ?? 30;
  const cueOffset = opts.cueOffset ?? 1.5;
  const maxTotal = opts.maxTotal ?? 40;

  const candidates = [];

  // 1. Mandatory: a few seconds in.
  candidates.push(Math.min(5.0, videoDuration / 4));

  // 2. Cue-driven captures.
  for (const s of snippets) {
    if (hasCue(s.text)) {
      const t = s.start + cueOffset;
      if (t < videoDuration - 2) candidates.push(t);
    }
  }

  // 3. Periodic baseline.
  for (let t = baseline; t < videoDuration - 5; t += baseline) {
    candidates.push(t);
  }

  // 4. Long-silence fillers.
  for (let i = 1; i < snippets.length; i++) {
    const gap = snippets[i].start - (snippets[i - 1].start + snippets[i - 1].duration);
    if (gap > 8) candidates.push(snippets[i - 1].start + snippets[i - 1].duration + 1);
  }

  // 5. End-of-video frame for any recap content.
  if (videoDuration > 30) candidates.push(Math.max(0, videoDuration - 8));

  // Dedupe within 6s, sort.
  candidates.sort((a, b) => a - b);
  const deduped = [];
  for (const t of candidates) {
    if (!deduped.length || t - deduped[deduped.length - 1] > 6) {
      deduped.push(Math.round(t * 10) / 10);
    }
  }

  // Cap if too many.
  if (deduped.length > maxTotal) {
    const step = deduped.length / maxTotal;
    return Array.from({ length: maxTotal }, (_, i) => deduped[Math.floor(i * step)]);
  }
  return deduped;
}
