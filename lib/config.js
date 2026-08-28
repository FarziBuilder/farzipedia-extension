// ─────────────────────────────────────────────────────────────────────────────
// FarziPedia local configuration.
//
// ⚠️ Replace the empty string below with your Anthropic API key.
//    The extension uses this as the default for everyone who installs it.
//
// SECURITY WARNINGS:
//   • This key will be visible to ANYONE who can read your extension's
//     source folder or watch network calls in DevTools.
//   • Set a strict spend limit on it:
//     https://console.anthropic.com/settings/limits
//     ($5-10/mo is plenty for hundreds of videos.)
//   • If you push this folder to a public GitHub repo, ADD THIS FILE TO
//     .gitignore first. (See lib/config.example.js for the template.)
//   • A user can override the built-in key with their own via the popup
//     — their key takes precedence over this one.
//
// To use the popup-only flow (no built-in key), leave this empty.
// ─────────────────────────────────────────────────────────────────────────────

export const BUILTIN_API_KEY = "";

// Where generated folios are published so they appear in the public library.
// The primary host is tried first; if it isn't serving the API directly yet
// (e.g. DNS still redirecting), the extension falls back automatically.
export const FARZIPEDIA_BASE_URL = "https://www.farzipedia.com";
export const FARZIPEDIA_FALLBACK_URL = "https://www.farzi.me";
