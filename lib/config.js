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

// Point at the canonical host (www.farzi.me) to avoid the apex→www 301
// redirect — Chrome will not follow a cross-origin redirect to a host
// that isn't in manifest.json's host_permissions.
export const FARZIPEDIA_BASE_URL = "https://www.farzi.me";
