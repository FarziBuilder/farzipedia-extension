// ─────────────────────────────────────────────────────────────────────────────
// FarziPedia local configuration.
//
// Leave BUILTIN_API_KEY empty. Without a key, the extension sends generation
// through farzipedia.com, whose server holds FarziPedia's key, so the key
// never ships in the extension. A user's own key from the popup goes
// straight to Anthropic instead.
//
// Only for a private, local build: a key put here is readable by anyone who
// has the extension's files, which for a Web Store build is everyone.
// scripts/publish.mjs refuses to publish a build with one.
// ─────────────────────────────────────────────────────────────────────────────

export const BUILTIN_API_KEY = "";

// Where generated folios are published so they appear in the public library.
// The primary host is tried first; if it isn't serving the API directly yet
// (e.g. DNS still propagating), the extension falls back automatically.
// The onrender.com address is Render's always-on service URL — the safety net.
export const FARZIPEDIA_BASE_URL = "https://farzipedia.com";
export const FARZIPEDIA_FALLBACK_URLS = [
  "https://www.farzipedia.com",
  "https://farzipedia.onrender.com",
];
