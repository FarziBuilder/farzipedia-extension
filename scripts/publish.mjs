#!/usr/bin/env node
// Package FarziPedia and push it to the Chrome Web Store (API v2).
//
//   node scripts/publish.mjs check     local checks + build dist/farzipedia-<version>.zip
//   node scripts/publish.mjs status    show what the store has (read-only)
//   node scripts/publish.mjs upload    check + upload the zip as a draft (not submitted)
//   node scripts/publish.mjs publish   check + upload + submit for review (goes live when approved)
//   node scripts/publish.mjs submit    submit the already-uploaded draft (e.g. after fixing the listing)
//
// Flags: --staged       publish: hold the approved version until you release it in the dashboard
//        --allow-dirty  skip the "everything committed and pushed" check
//
// Credentials never live in this repo. Put them in ~/.config/farzipedia/cws.json:
//   { "publisherId": "...", "serviceAccountKeyFile": "/abs/path/key.json" }
// or set CWS_PUBLISHER_ID + CWS_SERVICE_ACCOUNT_KEY (or CWS_ACCESS_TOKEN from
// `gcloud auth print-access-token --impersonate-service-account=...`).
// CWS_ITEM_ID overrides the extension id. Setup steps: README → Publishing.
//
// No dependencies; runs on Node 16+.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import https from 'node:https';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DEFAULT_ITEM_ID = 'dbgbnmbjkgaogoemdaldnmgidkaialll';
const SCOPE = 'https://www.googleapis.com/auth/chromewebstore';
const API = 'https://chromewebstore.googleapis.com';
// What ships. Everything else (README, scripts, .git, dist, config templates) stays out.
const SHIP = ['manifest.json', 'background', 'lib', 'popup', 'result', 'icons'];
const NEVER_SHIP = ['lib/config.local.js', 'lib/config.example.js', '*.DS_Store'];

const [cmd = 'check', ...rest] = process.argv.slice(2);
const flags = new Set(rest);

function die(msg) { console.error(`\n✗ ${msg}`); process.exit(1); }
function git(...args) { return execFileSync('git', args, { cwd: ROOT, encoding: 'utf8' }).trim(); }
const newer = (a, b) => {
  const pa = a.split('.').map(Number), pb = b.split('.').map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) > (pb[i] || 0);
  }
  return false;
};

// ---------- local checks + zip ----------

function localChecks() {
  const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'manifest.json'), 'utf8'));
  if (!/^\d+(\.\d+){0,3}$/.test(manifest.version)) die(`manifest version "${manifest.version}" isn't a valid Chrome version.`);

  // A key baked into lib/config.js would ship to every user and be readable by anyone.
  const config = fs.readFileSync(path.join(ROOT, 'lib/config.js'), 'utf8');
  const key = /BUILTIN_API_KEY\s*=\s*["'`]([^"'`]*)["'`]/.exec(config)?.[1] ?? '';
  if (key.trim()) die('lib/config.js has a BUILTIN_API_KEY. Empty it before publishing — a shipped key is public.');

  // Ship only what's on GitHub, so the store and the repo can't drift apart again.
  if (!flags.has('--allow-dirty')) {
    const dirty = git('status', '--porcelain', '--', ...SHIP);
    if (dirty) die(`Uncommitted changes in shipped files:\n${dirty}\nCommit them (or pass --allow-dirty).`);
    try {
      git('fetch', '--quiet', 'origin');
      const ahead = git('rev-list', '--count', '@{upstream}..HEAD');
      if (ahead !== '0') die(`${ahead} local commit(s) aren't on GitHub yet. Push first (or pass --allow-dirty).`);
    } catch (e) {
      if (e.status) die(`Couldn't compare with GitHub: ${String(e.message).split('\n')[0]}`);
      throw e;
    }
  }
  return manifest;
}

function buildZip(version) {
  const dist = path.join(ROOT, 'dist');
  fs.mkdirSync(dist, { recursive: true });
  const out = path.join(dist, `farzipedia-${version}.zip`);
  fs.rmSync(out, { force: true });
  execFileSync('zip', ['-r', '-X', '-q', out, ...SHIP, '-x', ...NEVER_SHIP], { cwd: ROOT });
  const listing = execFileSync('unzip', ['-Z1', out], { encoding: 'utf8' }).trim().split('\n');
  if (!listing.includes('manifest.json')) die('zip has no manifest.json at its root.');
  console.log(`✓ built ${path.relative(ROOT, out)} — ${listing.filter(f => !f.endsWith('/')).length} files, ${(fs.statSync(out).size / 1024).toFixed(0)} KB`);
  return out;
}

// ---------- credentials ----------

function loadConfig() {
  const file = path.join(os.homedir(), '.config/farzipedia/cws.json');
  const fromFile = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : {};
  const cfg = {
    publisherId: process.env.CWS_PUBLISHER_ID || fromFile.publisherId,
    itemId: process.env.CWS_ITEM_ID || fromFile.itemId || DEFAULT_ITEM_ID,
    keyFile: process.env.CWS_SERVICE_ACCOUNT_KEY || fromFile.serviceAccountKeyFile,
    accessToken: process.env.CWS_ACCESS_TOKEN,
  };
  if (!cfg.publisherId) die(`No publisher id. Add "publisherId" to ${file} (Developer Dashboard → Publisher → Settings).`);
  if (!cfg.accessToken && !cfg.keyFile) die(`No credentials. Add "serviceAccountKeyFile" to ${file}, or set CWS_ACCESS_TOKEN.`);
  return cfg;
}

function request(method, url, { headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const req = https.request(url, { method, headers: { ...headers, ...(body ? { 'content-length': Buffer.byteLength(body) } : {}) } }, (res) => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let json = null; try { json = JSON.parse(text); } catch {}
        resolve({ status: res.statusCode, json, text });
      });
    });
    req.on('error', reject);
    req.setTimeout(300_000, () => req.destroy(new Error(`${method} ${url} timed out`)));
    if (body) req.write(body);
    req.end();
  });
}

async function accessToken(cfg) {
  if (cfg.accessToken) return cfg.accessToken;
  const sa = JSON.parse(fs.readFileSync(cfg.keyFile, 'utf8'));
  const b64url = (b) => Buffer.from(b).toString('base64').replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_');
  const now = Math.floor(Date.now() / 1000);
  const unsigned = `${b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }))}.${b64url(JSON.stringify({
    iss: sa.client_email, scope: SCOPE, aud: sa.token_uri || 'https://oauth2.googleapis.com/token', iat: now, exp: now + 3600,
  }))}`;
  const signature = b64url(crypto.createSign('RSA-SHA256').update(unsigned).sign(sa.private_key));
  const res = await request('POST', sa.token_uri || 'https://oauth2.googleapis.com/token', {
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: `grant_type=${encodeURIComponent('urn:ietf:params:oauth:grant-type:jwt-bearer')}&assertion=${unsigned}.${signature}`,
  });
  if (res.status !== 200 || !res.json?.access_token) die(`Google refused the service account (${res.status}): ${res.text.slice(0, 300)}`);
  return res.json.access_token;
}

// ---------- store API ----------

async function store(cfg, token) {
  const item = `${API}/v2/publishers/${cfg.publisherId}/items/${cfg.itemId}`;
  const auth = { authorization: `Bearer ${token}` };
  const call = async (method, url, opts = {}) => {
    const res = await request(method, url, { ...opts, headers: { ...auth, ...opts.headers } });
    if (res.status >= 300) {
      const hint = res.status === 403
        ? ' — is the service account added under Account in the Developer Dashboard, and the Chrome Web Store API enabled in its Cloud project?'
        : '';
      // Spell out what the store objected to: the reasons live in error.details.
      const details = (res.json?.error?.details || [])
        .map(d => d.reason || d.message || (d.violations || d.fieldViolations || []).map(v => v.description).join('; '))
        .filter(Boolean);
      die(`${method} ${url.replace(API, '')} → HTTP ${res.status}${hint}\n` +
        `${res.json?.error?.message || res.text.slice(0, 800)}` +
        (details.length ? `\n  - ${[...new Set(details)].join('\n  - ')}` : ''));
    }
    return res.json || {};
  };
  return {
    status: () => call('GET', `${item}:fetchStatus`),
    upload: (zip) => call('POST', `${API}/upload/v2/publishers/${cfg.publisherId}/items/${cfg.itemId}:upload`, { body: fs.readFileSync(zip) }),
    publish: (staged) => call('POST', `${item}:publish`, {
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(staged ? { publishType: 'STAGED_PUBLISH' } : {}),
    }),
  };
}

const versions = (s) => ({
  published: s.publishedItemRevisionStatus?.distributionChannels?.map(c => c.crxVersion).filter(Boolean) || [],
  submitted: s.submittedItemRevisionStatus?.distributionChannels?.map(c => c.crxVersion).filter(Boolean) || [],
});

function printStatus(s) {
  const v = versions(s);
  console.log(`  published: ${v.published.join(', ') || '—'} (${s.publishedItemRevisionStatus?.state || 'not published'})`);
  console.log(`  in review: ${v.submitted.join(', ') || '—'}${s.submittedItemRevisionStatus ? ` (${s.submittedItemRevisionStatus.state})` : ''}`);
  if (s.lastAsyncUploadState) console.log(`  last upload: ${s.lastAsyncUploadState}`);
  if (s.takenDown) console.log('  ⚠ the item is TAKEN DOWN');
  if (s.warned) console.log('  ⚠ the item has a policy warning — check the Developer Dashboard');
}

// ---------- main ----------

async function main() {
  if (!['check', 'status', 'upload', 'publish', 'submit'].includes(cmd)) die(`Unknown command "${cmd}". Use check | status | upload | publish | submit.`);

  if (cmd === 'status' || cmd === 'submit') {
    const cfg = loadConfig();
    const api = await store(cfg, await accessToken(cfg));
    console.log(`Chrome Web Store item ${cfg.itemId}:`);
    printStatus(await api.status());
    if (cmd === 'submit') await submit(api, cfg);
    return;
  }

  const manifest = localChecks();
  console.log(`✓ FarziPedia v${manifest.version}: no built-in key${flags.has('--allow-dirty') ? '' : ', committed and pushed'}`);
  const zip = buildZip(manifest.version);
  if (cmd === 'check') return;

  const cfg = loadConfig();
  const api = await store(cfg, await accessToken(cfg));
  const before = await api.status();
  console.log('Store right now:'); printStatus(before);
  const known = [...versions(before).published, ...versions(before).submitted];
  const highest = known.reduce((a, b) => (newer(b, a) ? b : a), '0');
  if (!newer(manifest.version, highest)) die(`v${manifest.version} isn't newer than v${highest} on the store. Bump "version" in manifest.json.`);
  if (versions(before).submitted.length) {
    console.log('  note: a submission is already in review; uploading replaces it.');
  }

  console.log(`Uploading ${path.basename(zip)}…`);
  let up = await api.upload(zip);
  let state = up.uploadState;
  for (let i = 0; state === 'IN_PROGRESS' && i < 60; i++) {
    await new Promise(r => setTimeout(r, 5000));
    state = (await api.status()).lastAsyncUploadState;
  }
  if (state !== 'SUCCEEDED') die(`Upload ended in state ${state || 'unknown'}: ${JSON.stringify(up).slice(0, 500)}`);
  console.log(`✓ uploaded v${up.crxVersion || manifest.version} as a draft`);
  if (cmd === 'upload') {
    console.log('Not submitted. Run `node scripts/publish.mjs publish` (or press Submit in the dashboard) when ready.');
    return;
  }

  await submit(api, cfg);
}

async function submit(api, cfg) {
  const pub = await api.publish(flags.has('--staged'));
  console.log(`✓ submitted for review — state ${pub.state || 'unknown'}`);
  for (const w of pub.warningInfo?.warnings || []) console.log(`  warning: ${w.reason}: ${w.description}`);
  console.log(flags.has('--staged')
    ? 'Once approved it waits for you: release it from the Developer Dashboard.'
    : 'It goes live automatically once review passes; Chrome then updates users within a few hours.');
  console.log(`https://chromewebstore.google.com/detail/${cfg.itemId}`);
}

main().catch(e => die(e.stack || String(e)));
