#!/usr/bin/env node
/**
 * download.mjs — download a whole Suno workspace as lossless WAV + full-metadata sidecar JSON.
 *
 * WHY THIS EXISTS
 * ---------------
 * The Claude-in-Chrome path costs ~25 model turns for a 60-clip workspace: list, convert, poll,
 * export the URL map through a browser download (the tool channel blocks signed URLs), curl,
 * rename, verify, export the sidecars, split them. Every turn re-sends the whole conversation.
 * This script runs the identical sequence in ONE process — the model launches it and reads
 * `_download_result.json`, nothing else.
 *
 * It shares the persistent Chrome profile with submit.mjs (see lib/session.mjs), so one
 * `--login` serves both. No API key, no exported cookies, no password.
 *
 * WHAT IT DOES
 * ------------
 *   1. resolve the workspace (exact name, else case-insensitive substring; ambiguity stops)
 *   2. list every clip via /api/project/{id} — those clip objects ARE the sidecar metadata
 *      (verified identical to /api/feed/, so that extra round-trip is gone)
 *   3. wait until every selected clip is `complete` (--no-wait to skip)
 *   4. name files `{workspace} - {title}_{a|b}` (batch_index; created_at order as fallback)
 *   5. skip files already on disk that pass the size check — re-runs never re-download
 *   6. resolve each WAV through the Suno Studio download endpoint
 *      (GET /api/studio/clip/{id}/download?format=wav, polled to `ready`; ≤5 in flight, 429 backoff).
 *      Since the 2026-09-03 download caps this is the documented-unlimited route for Premier +
 *      Studio accounts and it does not touch `download_usage` (see docs/2026-09-suno-download-
 *      limits.md). `--legacy-wav` keeps the old convert_wav + wav_file/ pair; accounts without
 *      Studio access fall back to it automatically with a warning.
 *   7. stream each WAV to disk in Node (8 in flight), retrying with a FRESH signed URL
 *   8. verify RIFF header + size ≈ duration×192000+44 — a truncated download keeps a valid
 *      header and only shows up as a short file, so the header check alone is not enough
 *   9. write the sidecar JSON and `_download_result.json`
 *
 * Usage:
 *   node download.mjs "<workspace name or substring>" --out "<dir>" [options]
 *
 *   --out <dir>            where WAV + JSON land (default: current directory)
 *   --only a,b,c           subset — each item matches a clip id exactly or a title substring
 *   --dry-run              resolve + list + show planned filenames; convert/download nothing
 *   --no-wait              do not wait for rendering clips; download what is complete
 *   --wait-timeout <min>   how long to wait for rendering clips (default 20)
 *   --legacy-wav           use convert_wav + wav_file/ instead of the Studio download endpoint
 *   --force                run even when the batch exceeds the remaining download allowance
 *   --login                sign in once for this profile, then exit
 *   --profile "<dir>"      override the Chrome profile directory
 *   --headless             headed is the default (same fingerprint reasoning as submit.mjs)
 *
 * Exit codes: 0 = every selected clip is on disk and verified, 1 = anything else.
 */
import fs from 'node:fs';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import { Readable } from 'node:stream';
import {
  defaultProfileDir, launchSession, ensureLoggedIn, api, apiRetry, pool, sleep,
} from '../../suno-submit/scripts/lib/session.mjs';

// ---------------------------------------------------------------- args

const argv = process.argv.slice(2);
const IS_LOGIN = argv.includes('--login');
if (!IS_LOGIN && (!argv.length || argv[0].startsWith('--'))) {
  console.error('Usage: node download.mjs "<workspace>" --out "<dir>" [--only sel] [--dry-run] [--no-wait]');
  console.error('       node download.mjs --login          # one-time sign-in for this profile');
  process.exit(1);
}
const flag = (name, def = null) => {
  const i = argv.indexOf('--' + name);
  return i >= 0 ? (argv[i + 1] ?? true) : def;
};
const has = name => argv.includes('--' + name);

const WORKSPACE_Q = IS_LOGIN && (!argv.length || argv[0].startsWith('--')) ? null : argv[0];
const OUT_DIR = path.resolve(String(flag('out', process.cwd())));
const ONLY = flag('only') ? String(flag('only')).split(',').map(s => s.trim()).filter(Boolean) : null;
const DRY_RUN = has('dry-run');
const NO_WAIT = has('no-wait');
const WAIT_TIMEOUT_MS = Number(flag('wait-timeout', 20)) * 60 * 1000;
const LEGACY_WAV = has('legacy-wav');
const FORCE = has('force');
const HEADLESS = has('headless');
const PROFILE_DIR = path.resolve(String(flag('profile', defaultProfileDir())));

const log = (...a) => console.log(...a);
const MB = n => (n / 1e6).toFixed(1) + 'MB';

// WAV as Suno serves it: 48 kHz, 16-bit, stereo PCM. Size is a hard function of duration.
const BYTES_PER_SEC = 48000 * 2 * 2;
const WAV_HEADER = 44;

if (!IS_LOGIN) {
  log(`Workspace : ${WORKSPACE_Q}`);
  log(`Output    : ${OUT_DIR}`);
  if (ONLY) log(`Only      : ${ONLY.join(', ')}`);
}
log(`Profile   : ${PROFILE_DIR}`);
if (IS_LOGIN) log('MODE      : LOGIN — sign in once, then exit');
else if (DRY_RUN) log('MODE      : DRY RUN — list and plan filenames, download nothing');
log('');

// ---------------------------------------------------------------- browser

const { ctx, page } = await launchSession({ profileDir: PROFILE_DIR, headless: HEADLESS });

const results = [];
let failed = 0;
let projectId = null, workspaceName = null;
let wavPath_ = null;            // 'studio' | 'legacy' — decided in run() from the account's features
let usageBefore = null, usageAfter = null;

try {
  await ensureLoggedIn(page, { profileDir: PROFILE_DIR, loginOnly: IS_LOGIN, log });
  if (IS_LOGIN) {
    log('');
    log('✓ this profile is signed in — download.mjs and submit.mjs can now run unattended');
  } else {
    await run();
  }
} catch (e) {
  console.error('\n✗ aborted: ' + (e && e.message || e));
  failed = failed || 1;
} finally {
  if (!IS_LOGIN && !DRY_RUN) {
    // Re-read the allowance so the result file shows whether this run was counted.
    if (wavPath_) { try { usageAfter = (await api(page, '/api/billing/info/')).download_usage || null; } catch {} }
    writeResult();
  }
  await ctx.close();
}
process.exit(failed ? 1 : 0);

// ================================================================ steps

async function run() {
  // Which WAV route, and how much download allowance is left. Suno caps downloads per plan
  // since 2026-09-03; the Studio endpoint is documented as unlimited for Premier and measured
  // not to touch download_usage, so it is the default whenever the account has Studio access.
  const bill = await api(page, '/api/billing/info/');
  const features = new Set((bill.accessible_features || []).map(f => f.name));
  const hasStudio = features.has('studio');
  wavPath_ = LEGACY_WAV ? 'legacy' : hasStudio ? 'studio' : 'legacy';
  usageBefore = bill.download_usage || null;
  if (usageBefore) {
    const u = usageBefore;
    log(`Downloads : ${u.current_period_downloads_used}/${u.current_period_downloads_limit} used this period` +
        (u.additional_download_remaining ? ` (+${u.additional_download_remaining} extra)` : ''));
  }
  log(`WAV route : ${wavPath_ === 'studio' ? 'Studio download endpoint (uncounted for Premier+Studio)' : 'legacy convert_wav + wav_file/'}`);
  if (!LEGACY_WAV && !hasStudio) console.error('  ⚠ this account has no Studio access — falling back to the legacy WAV route');

  ({ id: projectId, name: workspaceName } = await resolveWorkspace(WORKSPACE_Q));
  log(`✓ workspace "${workspaceName}" (${projectId})`);

  let clips = await listClips(projectId);
  log(`✓ ${clips.length} clips listed`);

  let selected = applyOnly(clips, ONLY);
  if (!selected.length) throw new Error('nothing matched --only');
  if (ONLY) log(`  ${selected.length} selected by --only`);

  // Wait for rendering clips. Suno's listing is eventually consistent and a clip can sit in
  // `streaming` for a couple of minutes after its siblings finish — polling here is what lets
  // the skill be launched right after submit and still come back with everything.
  const pending = () => selected.filter(c => c.status !== 'complete' && c.status !== 'error');
  if (pending().length && !NO_WAIT && !DRY_RUN) {
    log(`  ${pending().length} still rendering — waiting (up to ${WAIT_TIMEOUT_MS / 60000} min)…`);
    const deadline = Date.now() + WAIT_TIMEOUT_MS;
    while (pending().length && Date.now() < deadline) {
      await sleep(10000);
      clips = await listClips(projectId);
      selected = applyOnly(clips, ONLY);
    }
    if (pending().length) console.error(`  ⚠ ${pending().length} clip(s) still not complete after timeout — they will be skipped`);
    else log('  ✓ all rendered');
  }

  const plan = planFiles(selected, workspaceName);

  if (DRY_RUN) {
    log('');
    for (const p of plan) log(`  ${p.status.padEnd(9)} ${fmtDur(p.duration)}  ${p.file}.wav`);
    log('');
    log(`${plan.length} file(s) would be written to ${OUT_DIR}`);
    return;
  }

  fs.mkdirSync(OUT_DIR, { recursive: true });

  // Resume: anything already on disk and verified is done. Sidecars are cheap — always rewrite.
  const todo = [];
  for (const p of plan) {
    if (p.status !== 'complete') {
      results.push({ ...brief(p), ok: false, error: `status=${p.status}` });
      failed++;
      continue;
    }
    const v = verifyWav(wavPath(p), p.duration, p.id);
    if (v.ok) {
      writeSidecar(p);
      results.push({ ...brief(p), ok: true, skipped: true, size: v.size });
      continue;
    }
    todo.push(p);
  }
  const skipped = results.filter(r => r.skipped).length;
  if (skipped) log(`✓ ${skipped} already on disk and verified — skipped`);
  if (!todo.length) { log('✓ nothing to download'); return; }

  // Quota guard. The legacy route is counted server-side (measured 2026-09-09: 2 clips →
  // downloads_used 0→2); a batch larger than the remaining allowance is refused there unless
  // --force. The Studio route is documented unlimited and measured uncounted, so it only informs.
  if (usageBefore && wavPath_ === 'legacy') {
    const remaining = (usageBefore.current_period_downloads_limit - usageBefore.current_period_downloads_used) + (usageBefore.additional_download_remaining || 0);
    if (todo.length > remaining && !FORCE) {
      throw new Error(`${todo.length} clips to download but only ${remaining} download(s) left this period on the legacy route — use the Studio route, --only to pick takes, or --force`);
    }
  }

  // Kick off conversions. Studio: the first poll on an unconverted clip starts the render
  // server-side. Legacy: explicit convert_wav (204 = queued or already converted).
  log(`▶ preparing ${todo.length} WAV(s) via ${wavPath_} route…`);
  await pool(todo, 5, async p => {
    if (wavPath_ === 'studio') {
      const r = await apiRetry(page, `/api/studio/clip/${p.id}/download?format=wav`);
      if (r && r.__error && r.__error !== 429) p.convertError = r.__error;
    } else {
      const r = await apiRetry(page, `/api/gen/${p.id}/convert_wav/`, { method: 'POST' });
      if (r && r.__error) p.convertError = r.__error;
    }
  });
  const convFailed = todo.filter(p => p.convertError);
  if (convFailed.length) {
    console.error(`  ✗ ${convFailed.length} clip(s) refused (HTTP ${convFailed[0].convertError}) — WAV export needs a paid plan${wavPath_ === 'studio' ? '; try --legacy-wav' : ''}`);
  }

  // Download as each URL becomes ready, 8 in flight. A failed transfer retries with a FRESH
  // signed URL — the old one may have expired mid-batch, and reusing it just fails again.
  log(`▶ downloading (${todo.length} files, 8 in flight)…`);
  let n = 0;
  await pool(todo.filter(p => !p.convertError), 8, async p => {
    let lastErr = null;
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        const url = await waitWavUrl(p.id);
        await streamToFile(url, wavPath(p) + '.part');
        fs.renameSync(wavPath(p) + '.part', wavPath(p));
        const v = verifyWav(wavPath(p), p.duration, p.id);
        if (!v.ok) throw new Error(v.reason);
        writeSidecar(p);
        n++;
        log(`  ✓ ${String(n).padStart(3)}/${todo.length}  ${MB(v.size).padStart(7)}  ${fmtDur(p.duration)}  ${p.file}`);
        results.push({ ...brief(p), ok: true, size: v.size, attempts: attempt });
        return;
      } catch (e) {
        lastErr = e;
        try { fs.rmSync(wavPath(p) + '.part', { force: true }); } catch {}
        if (attempt < 3) await sleep(3000 * attempt);
      }
    }
    console.error(`  ✗ ${p.file}: ${lastErr && lastErr.message}`);
    results.push({ ...brief(p), ok: false, error: String(lastErr && lastErr.message || lastErr) });
    failed++;
  });
  for (const p of convFailed) {
    results.push({ ...brief(p), ok: false, error: `convert_wav HTTP ${p.convertError}` });
    failed++;
  }
}

function brief(p) {
  return { id: p.id, title: p.title, variant: p.variant, file: p.file + '.wav', duration: p.duration };
}

// ---------------------------------------------------------------- workspace & clips

async function resolveWorkspace(q) {
  const seen = new Set(); const all = [];
  for (let pg = 1; pg <= 20; pg++) {
    const j = await api(page, `/api/project/me?page=${pg}&sort=created_at&show_trashed=false`);
    if (j.__error) break;
    const projs = j.projects || [];
    let added = 0;
    for (const p of projs) if (!seen.has(p.id)) { seen.add(p.id); all.push(p); added++; }
    if (!projs.length || !added || all.length >= (j.num_total_results || 0)) break;
  }
  const exact = all.filter(p => p.name === q);
  if (exact.length === 1) return exact[0];
  const ql = q.toLowerCase();
  const hits = all.filter(p => (p.name || '').toLowerCase().includes(ql));
  if (hits.length === 1) return hits[0];
  if (!hits.length) throw new Error(`no workspace matches "${q}" (${all.length} workspaces checked)`);
  console.error(`✗ "${q}" matches ${hits.length} workspaces — be more specific:`);
  for (const h of hits) console.error(`   ${h.name}  (${h.clip_count} clips)`);
  throw new Error('ambiguous workspace');
}

async function listClips(pid) {
  const seen = new Set(); const clips = [];
  for (let pg = 1; pg <= 60; pg++) {
    const j = await apiRetry(page, `/api/project/${pid}?page=${pg}`);
    if (!j || j.__error) break;
    const got = (j.project_clips || []).map(pc => pc.clip).filter(Boolean);
    let added = 0;
    for (const c of got) if (!seen.has(c.id)) { seen.add(c.id); clips.push(c); added++; }
    if (!got.length || !added || clips.length >= (j.clip_count || 0)) break;
  }
  return clips;
}

function applyOnly(clips, only) {
  if (!only) return clips;
  const ol = only.map(s => s.toLowerCase());
  return clips.filter(c => ol.some(s => c.id === s || (c.title || '').toLowerCase().includes(s)));
}

// ---------------------------------------------------------------- filenames

// Hoisted `function`s below, not `const` arrows: the top-level try block runs `run()` before this
// part of the module is evaluated, and a const would sit in the temporal dead zone.
function sanitize(s) { return s.replace(/[\/\\:*?"<>|]/g, '_').replace(/[. ]+$/, ''); }

/**
 * `{workspace} - {title}_{a|b}`: the takes of one title are ordered by created_at, then id.
 *
 * NOT by `batch_index`. That field is transient — present in the listing right after a Create,
 * gone from the same endpoint a day later — so a name derived from it cannot be reproduced on a
 * re-run, and a re-run then silently swaps a/b under the existing files (it happened: 10 of 30
 * titles flipped). created_at + id are immutable, so this ordering is stable forever.
 * A title with more than two clips (a double submit) gets c, d, … so nothing is overwritten.
 */
function planFiles(clips, ws) {
  const byTitle = {};
  for (const c of clips) (byTitle[c.title || '(untitled)'] = byTitle[c.title || '(untitled)'] || []).push(c);
  for (const t in byTitle) {
    byTitle[t].sort((a, b) => (a.created_at || '').localeCompare(b.created_at || '') || a.id.localeCompare(b.id));
  }
  const used = new Set();
  const plan = [];
  let dropped = false;
  for (const c of clips) {
    const title = c.title || '(untitled)';
    const variant = String.fromCharCode(97 + byTitle[title].findIndex(x => x.id === c.id));
    let file = sanitize(`${ws} - ${title}_${variant}`);
    // Windows MAX_PATH: drop the workspace prefix rather than fail; the sidecar still records it.
    if (path.join(OUT_DIR, file + '.wav').length > 240) { file = sanitize(`${title}_${variant}`); dropped = true; }
    while (used.has(file)) file += '_';
    used.add(file);
    plan.push({
      id: c.id, title, variant, file, status: c.status,
      duration: Number(c.metadata?.duration) || 0, clip: c,
    });
  }
  if (dropped) console.error('  ⚠ some paths exceeded 240 chars — workspace prefix dropped from those filenames');
  return plan;
}

function wavPath(p) { return path.join(OUT_DIR, p.file + '.wav'); }
function fmtDur(s) { return s ? `${Math.floor(s / 60)}:${String(Math.round(s % 60)).padStart(2, '0')}` : '  ?:??'; }

// ---------------------------------------------------------------- wav

/**
 * Resolve a fresh signed WAV URL (1 h TTL) for a clip. Called right before each transfer and
 * again on retry, never cached — a URL minted at the start of a long batch would be dead.
 */
async function waitWavUrl(id, timeoutMs = 4 * 60 * 1000) {
  return wavPath_ === 'studio' ? waitWavUrlStudio(id, timeoutMs) : waitWavUrlLegacy(id, timeoutMs);
}

// Studio route: {ok, status:"processing"|"ready"|"error", download_url?, reason?, detail?}.
// The endpoint renders the WAV itself on first request; "rate_limited" asks for a short backoff.
async function waitWavUrlStudio(id, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const r = await apiRetry(page, `/api/studio/clip/${id}/download?format=wav`);
    if (!r) { await sleep(3000); continue; }
    if (r.__error) throw new Error(`studio download HTTP ${r.__error}${r.body ? ' ' + r.body.slice(0, 80) : ''}`);
    if (r.reason === 'rate_limited') { await sleep(1000 + Math.random() * 1000); continue; }
    if (r.status === 'ready' && r.download_url) return r.download_url;
    if (r.status === 'error') throw new Error(`studio download failed: ${r.detail || r.message || 'unknown'}`);
    await sleep(3000);
  }
  throw new Error('WAV render did not finish in time');
}

// Legacy route: wav_file/ answers 404 (or 200 {}) until convert_wav has produced the file.
async function waitWavUrlLegacy(id, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const r = await apiRetry(page, `/api/gen/${id}/wav_file/`);
    if (r && !r.__error && r.wav_file_url) return r.wav_file_url;
    if (r && r.__error && r.__error !== 404) throw new Error(`wav_file HTTP ${r.__error}`);
    await sleep(5000);
  }
  throw new Error('WAV conversion did not finish in time');
}

async function streamToFile(url, dest) {
  const res = await fetch(url);
  if (!res.ok || !res.body) throw new Error(`download HTTP ${res.status}`);
  await pipeline(Readable.fromWeb(res.body), fs.createWriteStream(dest));
}

/**
 * Two failures hide behind a healthy-looking file:
 *   - a truncated download keeps its RIFF header and plays for a few seconds — size against the
 *     clip's known duration catches that;
 *   - the WRONG take under this name (two takes of one title often differ by <3 % in length, so
 *     size alone passes) — Suno stamps every WAV with `ICMT: … id=<clip id>`, and that embedded
 *     id must equal the clip we meant. It is the ground truth for what a file actually is.
 */
function verifyWav(file, duration, clipId) {
  if (!fs.existsSync(file)) return { ok: false, reason: 'missing' };
  const size = fs.statSync(file).size;
  if (size < 100000) return { ok: false, size, reason: `too small (${size} bytes)` };
  const fd = fs.openSync(file, 'r');
  const head = Buffer.alloc(4);
  fs.readSync(fd, head, 0, 4, 0);
  fs.closeSync(fd);
  if (head.toString('latin1') !== 'RIFF') return { ok: false, size, reason: 'not a RIFF/WAV file' };
  if (duration > 0) {
    const expected = duration * BYTES_PER_SEC + WAV_HEADER;
    const ratio = size / expected;
    if (ratio < 0.97 || ratio > 1.05) {
      return { ok: false, size, reason: `size ${MB(size)} vs expected ${MB(expected)} for ${fmtDur(duration)} — truncated?` };
    }
  }
  const embedded = readEmbeddedId(file);
  if (embedded && clipId && embedded !== clipId) {
    return { ok: false, size, reason: `embedded clip id ${embedded.slice(0, 8)}… is not ${clipId.slice(0, 8)}… — a different take is under this name` };
  }
  return { ok: true, size, idVerified: !!embedded };
}

/** The clip id Suno writes into the WAV's LIST/INFO `ICMT` chunk, or null if there is none. */
function readEmbeddedId(file) {
  const fd = fs.openSync(file, 'r');
  try {
    const size = fs.fstatSync(fd).size;
    const hdr = Buffer.alloc(12);
    fs.readSync(fd, hdr, 0, 12, 0);
    if (hdr.toString('latin1', 0, 4) !== 'RIFF' || hdr.toString('latin1', 8, 12) !== 'WAVE') return null;
    const h = Buffer.alloc(8);
    let off = 12;
    while (off + 8 <= size) {
      fs.readSync(fd, h, 0, 8, off);
      const id = h.toString('latin1', 0, 4);
      const len = h.readUInt32LE(4);
      if (id === 'LIST') {
        const buf = Buffer.alloc(Math.min(len, 65536));
        fs.readSync(fd, buf, 0, buf.length, off + 8);
        const m = buf.toString('latin1').match(/id=([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/);
        if (m) return m[1];
      }
      off += 8 + len + (len & 1);
    }
    return null;
  } finally {
    fs.closeSync(fd);
  }
}

function writeSidecar(p) {
  fs.writeFileSync(path.join(OUT_DIR, p.file + '.json'), JSON.stringify(p.clip, null, 2));
}

// ---------------------------------------------------------------- result

function writeResult() {
  const ok = results.filter(r => r.ok).length;
  const out = {
    workspace: workspaceName, projectId, outDir: OUT_DIR,
    wavRoute: wavPath_,
    downloadUsage: { before: usageBefore, after: usageAfter },
    selected: results.length, ok, skipped: results.filter(r => r.skipped).length, failed,
    at: new Date().toISOString(),
    clips: results,
  };
  const file = path.join(OUT_DIR, '_download_result.json');
  try { fs.writeFileSync(file, JSON.stringify(out, null, 2)); } catch {}
  log('');
  log(`${failed ? '✗' : '✓'} ${ok}/${results.length} on disk and verified`);
  if (usageBefore && usageAfter) {
    const d = usageAfter.current_period_downloads_used - usageBefore.current_period_downloads_used;
    log(`  download allowance: ${usageAfter.current_period_downloads_used}/${usageAfter.current_period_downloads_limit} used` +
        (d ? `  (this run counted ${d})` : '  (this run was not counted)'));
  }
  if (failed) {
    for (const r of results.filter(r => !r.ok)) console.error(`   ✗ ${r.file}: ${r.error}`);
  }
  log(`  result → ${file}`);
}
