// ─────────────────────────────────────────────────────────────────────────────
// FarziPedia configuration.
//
// All Claude requests are routed through farzi.me's server-side proxy, which
// holds the Anthropic API key. End-users never need to supply one of their
// own — they install the extension and it just works.
//
// If you're running this against a local dev backend, point this constant
// at it (e.g. "http://localhost:8000"). For production it should remain
// "https://farzi.me" and the matching host permission in manifest.json
// must agree.
// ─────────────────────────────────────────────────────────────────────────────

export const FARZIPEDIA_BASE_URL = "https://farzi.me";
