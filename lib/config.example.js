// Template for lib/config.js — copy this file to lib/config.js and fill in
// your real key locally.  Never commit a real key.

export const BUILTIN_API_KEY = "";  // e.g. "sk-ant-api03-..."

// Where generated folios are published (public library). Primary is tried
// first; the fallbacks cover DNS transitions (onrender is Render's always-on
// service URL).
export const FARZIPEDIA_BASE_URL = "https://farzipedia.com";
export const FARZIPEDIA_FALLBACK_URLS = [
  "https://www.farzipedia.com",
  "https://farzipedia.onrender.com",
];
