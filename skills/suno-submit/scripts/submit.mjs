#!/usr/bin/env node
/**
 * submit.mjs — batch-submit a prompts.json (or an episode folder) to Suno with Playwright.
 *
 * WHY THIS EXISTS
 * ---------------
 * The Claude-in-Chrome path costs ~3 model round-trips per prompt: load the lyrics onto the
 * clipboard, fill + verify the form, click Create. At 36 prompts that is ~110 turns, and every
 * turn re-sends the whole conversation — the dominant cost of a batch, by an order of magnitude.
 * This script keeps the same verified interaction sequence but runs the whole loop in ONE process,
 * so the model appears twice: once to launch it, once to read the result.
 *
 * It is NOT a rewrite of the technique — every selector and every workaround below was learned
 * the hard way through the Claude-in-Chrome path and is documented in SKILL.md. Read the
 * "UI notes & gotchas" section there before changing anything here.
 *
 * LOGIN
 * -----
 * Uses a dedicated persistent Chrome profile (default: <localappdata>/suno-toolkits-profile).
 * First run opens a real Chrome window and waits for you to log into Suno; after that the
 * session persists like any normal browser profile. No API key, no exported cookie file, no
 * password ever touches this script.
 *
 * That directory holds real credentials — keep it OUT of any repo. The default lives under
 * LOCALAPPDATA / ~/Library / ~/.local/share precisely so it cannot be committed by accident.
 *
 * A dedicated profile (rather than your everyday one) is required, not cosmetic:
 *   - Chrome ignores --remote-debugging-port on the default profile (security, Chrome 111+)
 *   - a profile directory is file-locked, so Playwright cannot open one Chrome already has open
 * With its own profile this runs alongside your normal browsing and Claude-in-Chrome, no conflict.
 *
 * Usage:
 *   node submit.mjs "<prompts.json|episode folder>" [options]
 *
 *   --login                sign in once for this profile, then exit (no path argument needed)
 *   --doctor               probe every selector and exit — ~15s, touches nothing, no login prompt
 *                          beyond the usual. Run this before starting work on a new batch.
 *   --dry-run              do everything except click Create (STRONGLY recommended first run)
 *   --only 01,BGM02:03     submit a subset (same selector rules as queue.mjs)
 *   --workspace "<name>"   override the auto-derived workspace name
 *   --profile "<dir>"      override the Chrome profile directory
 *   --headed / --headless  default is headed; headless trips bot detection and breaks clipboard
 *   --gap-same <sec>       pacing within one prompts.json group (default 8)
 *   --gap-group <sec>      pacing when crossing to the next group (default 30)
 *   --slowmo <ms>          Playwright slowMo, for watching it work
 *
 * On any selector failure the runner writes `_submit_failure_<ts>.json` + `.png` next to the
 * prompts: a screenshot plus the complete current shape of the create form (every input with its
 * placeholder and aria-label, every contenteditable, every slider, every button) alongside what
 * this script expects to find. Hand that pair to Claude and the repair needs no extra browser run.
 *
 * Exit codes: 0 = every selected prompt submitted and verified, 1 = anything else.
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import readline from 'node:readline';
import { buildQueue, applyOnly, shortNames, resolveModel } from './lib/queue-core.mjs';

// ---------------------------------------------------------------- args

const argv = process.argv.slice(2);
// `--login` is the one mode that needs no prompts — it exists so the sign-in instruction printed
// on a non-TTY run is a single copy-pasteable command.
const IS_LOGIN = argv.includes('--login');
if (!IS_LOGIN && (!argv.length || argv[0].startsWith('--'))) {
  console.error('Usage: node submit.mjs "<prompts.json|episode folder>" [--doctor] [--dry-run] [--only sel] [--workspace name]');
  console.error('       node submit.mjs --login          # one-time sign-in for this profile');
  process.exit(1);
}
const flag = (name, def = null) => {
  const i = argv.indexOf('--' + name);
  return i >= 0 ? (argv[i + 1] ?? true) : def;
};
const has = name => argv.includes('--' + name);

const INPUT = IS_LOGIN && (!argv.length || argv[0].startsWith('--')) ? process.cwd() : path.resolve(argv[0]);
const DRY_RUN = has('dry-run');
const DOCTOR = has('doctor');
const LOGIN_ONLY = has('login');
const ONLY = flag('only') ? String(flag('only')).split(',').map(s => s.trim()).filter(Boolean) : null;
const HEADLESS = has('headless');
const SLOWMO = Number(flag('slowmo', 0)) || 0;
const GAP_SAME = Number(flag('gap-same', 8)) * 1000;
const GAP_GROUP = Number(flag('gap-group', 30)) * 1000;

function defaultProfileDir() {
  if (process.platform === 'win32') {
    return path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'), 'suno-toolkits-profile');
  }
  if (process.platform === 'darwin') {
    return path.join(os.homedir(), 'Library', 'Application Support', 'suno-toolkits-profile');
  }
  return path.join(process.env.XDG_DATA_HOME || path.join(os.homedir(), '.local', 'share'), 'suno-toolkits-profile');
}
const PROFILE_DIR = path.resolve(String(flag('profile', defaultProfileDir())));

// Workspace name: explicit override, else the episode/parent folder name. For a single file
// input that is the file's parent — or its grandparent when the parent is a BGM_NN_* folder.
function deriveWorkspace(input) {
  const st = fs.statSync(input);
  if (st.isDirectory()) return path.basename(input);
  const parent = path.dirname(input);
  const base = path.basename(parent);
  return /^BGM_\d+/.test(base) ? path.basename(path.dirname(parent)) : base;
}
const WORKSPACE = String(flag('workspace', deriveWorkspace(INPUT)));

const MOD = process.platform === 'darwin' ? 'Meta' : 'Control';
const sleep = ms => new Promise(r => setTimeout(r, ms));
const log = (...a) => console.log(...a);

// ---------------------------------------------------------------- queue

let queue = [], items = [];
if (!LOGIN_ONLY) {
  try {
    queue = buildQueue(INPUT);
    items = applyOnly(queue, ONLY);
  } catch (e) {
    console.error('✗ ' + e.message);
    process.exit(1);
  }
}
if (!LOGIN_ONLY && !items.length) { console.error('✗ nothing to submit'); process.exit(1); }

const shorts = LOGIN_ONLY ? [] : shortNames(queue);
if (shorts.length > 1) console.error('⚠ short_name is inconsistent across folders: ' + shorts.join(', '));

const { model: MODEL, warning: modelWarning } = LOGIN_ONLY ? { model: 'v5.5', warning: null } : resolveModel(items);
if (modelWarning) console.error('⚠ ' + modelWarning);

const withAudioRef = items.filter(x => x.audio_reference);
if (withAudioRef.length) {
  console.error(`✗ ${withAudioRef.length} prompt(s) set audio_reference — this runner does not attach audio`);
  console.error('  references yet (the Browse/Remix modal is not automated). Use the Claude-in-Chrome');
  console.error('  path for those, or drop audio_reference to run here.');
  process.exit(1);
}

if (!LOGIN_ONLY) {
  log(`Workspace : ${WORKSPACE}`);
  log(`Model     : ${MODEL}`);
  log(`Prompts   : ${items.length}${ONLY ? ` (filtered from ${queue.length})` : ''}`);
}
log(`Profile   : ${PROFILE_DIR}`);
if (LOGIN_ONLY) log('MODE      : LOGIN — sign in once, then exit');
if (DOCTOR) log('MODE      : DOCTOR — probing selectors only, no form is touched');
else if (DRY_RUN) log('MODE      : DRY RUN — the form is filled and verified, Create is never clicked');
log('');

// ---------------------------------------------------------------- playwright

let chromium;
try {
  ({ chromium } = await import('playwright'));
} catch {
  console.error('✗ playwright is not installed.');
  console.error('  From the suno-toolkits repo root:  npm install && npx playwright install chrome');
  process.exit(1);
}

fs.mkdirSync(PROFILE_DIR, { recursive: true });

const ctx = await chromium.launchPersistentContext(PROFILE_DIR, {
  channel: 'chrome',            // the real Chrome, not bundled Chromium — closer fingerprint
  headless: HEADLESS,
  slowMo: SLOWMO,
  viewport: null,
  args: ['--start-maximized'],
});
// Writing to the *page* clipboard (not the OS one) is what makes this immune to the clobber
// that plagues the manual path: nothing the user copies mid-run can replace pending lyrics.
await ctx.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: 'https://suno.com' });

const page = ctx.pages()[0] || await ctx.newPage();
page.setDefaultTimeout(30000);

const results = [];
let failed = 0;
let capturedOnce = false;   // diagnostics are dumped once per run, not once per failing prompt

try {
  if (LOGIN_ONLY) {
    await ensureLoggedIn();
    log('');
    log('✓ this profile is signed in — submit.mjs can now run unattended');
  }
  else if (DOCTOR) { failed = await doctor() ? 0 : 1; }
  else await run();
} catch (e) {
  console.error('\n✗ aborted: ' + (e && e.stack || e));
  // Capture the scene BEFORE the browser closes — otherwise fixing this costs an extra
  // launch just to see what the UI looks like now. Skipped for failures that are not about
  // the UI (a missing sign-in), where a dump would be noise in the user's folder.
  if (!(e && e.skipDiagnostics)) await captureDiagnostics(String((e && e.message) || e));
  failed = failed || 1;
} finally {
  if (!DOCTOR && !LOGIN_ONLY) await writeResult();
  if (!DRY_RUN && !DOCTOR && !LOGIN_ONLY) log('\nLeaving the browser open for 10s so you can eyeball the queue…');
  await sleep(DRY_RUN || DOCTOR || LOGIN_ONLY ? 1000 : 10000);
  await ctx.close();
}
process.exit(failed ? 1 : 0);

// ================================================================ steps

async function run() {
  await ensureLoggedIn();
  const projectId = await ensureWorkspace(WORKSPACE);
  log(`✓ workspace ready (${projectId})`);

  await gotoWorkspace(projectId);
  await ensureAdvancedTab();
  await ensureModel(MODEL);
  await ensureMoreOptions();

  // Slider state is tracked across prompts — Suno keeps whatever the last prompt left.
  let cur = await readSliders();
  log(`✓ form ready (sliders at W=${cur.w} SI=${cur.si})\n`);

  let lastGroup = null;
  let baseline = await clipCount(projectId);

  for (const [n, item] of items.entries()) {
    if (lastGroup !== null && item.group !== lastGroup) await sleep(GAP_GROUP);
    else if (lastGroup !== null) await sleep(GAP_SAME);
    lastGroup = item.group;

    const tag = `[${n + 1}/${items.length}] ${item.group}:${item.id} ${item.title}`;
    log(tag);

    await fillTextFields(item);
    await fillLyrics(item);
    cur = await setSliders(item.w, item.si, cur);
    await setVocalGender(item.vocal_gender);

    const v = await verifyForm(item, cur);
    if (!v.ok) {
      console.error('  ✗ pre-Create verification failed: ' + v.problems.join('; '));
      console.error('    (nothing was submitted for this prompt)');
      results.push({ ...brief(item), submitted: false, error: v.problems.join('; ') });
      // A failed verification is the usual first sign of UI drift. Capture the scene ONCE —
      // repeating it for all 36 prompts would bury the useful one under identical copies.
      if (!capturedOnce) {
        capturedOnce = true;
        await captureDiagnostics(`pre-Create verification failed on ${item.title}: ${v.problems.join('; ')}`);
      }
      failed++;
      continue;
    }
    log(`  ✓ verified — ${v.state.paras} lyric paragraphs, W=${v.state.w} SI=${v.state.si}`);

    if (DRY_RUN) {
      results.push({ ...brief(item), submitted: false, dryRun: true });
      continue;
    }

    await clickCreate();
    const after = await expectClipCount(projectId, baseline + 2);
    if (after === null) {
      console.error(`  ✗ clip count did not reach ${baseline + 2} — STOPPING.`);
      console.error('    Suno\'s listing is eventually consistent, so this may still land.');
      console.error('    Check the workspace in the browser before re-running; a blind retry double-charges.');
      results.push({ ...brief(item), submitted: 'unconfirmed' });
      failed++;
      break;
    }
    baseline = after;
    log(`  ✓ created (workspace now ${after} clips)`);
    results.push({ ...brief(item), submitted: true });
  }

  if (!DRY_RUN) await finalVerify(projectId);
}

const brief = x => ({ group: x.group, id: x.id, title: x.title, w: x.w, si: x.si });

// ---------------------------------------------------------------- login

async function ensureLoggedIn() {
  await page.goto('https://suno.com/create', { waitUntil: 'domcontentloaded' });
  await sleep(4000);
  if (await isLoggedIn()) { log('✓ already signed in'); return; }

  // Without a TTY there is nobody to answer the prompt — an agent or CI would hang here until
  // it timed out, with a Chrome window open and no indication why. Fail fast and say exactly
  // what to run instead. `--login` exists purely so that instruction is a single command.
  if (!process.stdin.isTTY) {
    const p = PROFILE_DIR !== defaultProfileDir() ? ` --profile "${PROFILE_DIR}"` : '';
    log('');
    console.error('✗ not signed in to Suno, and there is no terminal to sign in from.');
    if (LOGIN_ONLY) {
      // Already the login command — telling them to run the login command would be circular.
      console.error('  --login needs a real terminal. Run it from a shell, or in Claude Code prefix');
      console.error('  the line with "! " so it runs in your session:');
      console.error('');
      console.error(`    ! node "${process.argv[1]}" --login${p}`);
    } else {
      console.error('  Sign in once and the session persists in the profile. From a terminal:');
      console.error('');
      console.error(`    node "${process.argv[1]}" --login${p}`);
    }
    console.error('');
    // Not a selector problem — diagnostics would be noise, and would litter the cwd.
    throw Object.assign(new Error('sign-in required (no TTY)'), { skipDiagnostics: true });
  }

  log('');
  log('  ── First run on this profile ──');
  log('  A Chrome window is open. Sign in to Suno there, then press Enter here.');
  log('  This is one-time: the session persists in the profile directory from now on.');
  log('');
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  await new Promise(r => rl.question('  Press Enter once you are signed in… ', () => { rl.close(); r(); }));

  await page.goto('https://suno.com/create', { waitUntil: 'domcontentloaded' });
  await sleep(4000);
  if (!(await isLoggedIn())) throw new Error('still not signed in to Suno — re-run once logged in');
  log('✓ signed in');
}

async function isLoggedIn() {
  try {
    return await page.evaluate(async () => {
      try { return !!(await window.Clerk?.session?.getToken()); } catch { return false; }
    });
  } catch { return false; }
}

/** Run an authenticated Suno API call from the page. The token never leaves the browser. */
async function api(pathAndQuery, init = null) {
  return page.evaluate(async ([p, i]) => {
    const token = await window.Clerk.session.getToken();
    const H = {
      accept: '*/*', 'content-type': 'application/json', authorization: `Bearer ${token}`,
      'browser-token': JSON.stringify({ token: btoa(JSON.stringify({ timestamp: Date.now() })) }),
      'device-id': '00000000-0000-4000-8000-000000000001',
      origin: 'https://suno.com', referer: 'https://suno.com/',
    };
    const r = await fetch('https://studio-api-prod.suno.com' + p, { ...(i || {}), headers: H });
    if (!r.ok) return { __error: r.status, body: (await r.text()).slice(0, 200) };
    const t = await r.text();
    return t ? JSON.parse(t) : {};
  }, [pathAndQuery, init]);
}

// ---------------------------------------------------------------- workspace

async function ensureWorkspace(name) {
  const seen = new Set(); const all = [];
  for (let pg = 1; pg <= 20; pg++) {
    const j = await api(`/api/project/me?page=${pg}&sort=created_at&show_trashed=false`);
    if (j.__error) break;
    const projs = j.projects || [];
    let added = 0;
    for (const p of projs) if (!seen.has(p.id)) { seen.add(p.id); all.push(p); added++; }
    if (!projs.length || !added || all.length >= (j.num_total_results || 0)) break;
  }
  const hit = all.find(p => p.name === name);
  if (hit) return hit.id;

  const created = await api('/api/project', {
    method: 'POST',
    body: JSON.stringify({ name, description: '', spec: { description: '' } }),
  });
  if (created.__error) throw new Error(`could not create workspace (${created.__error}) ${created.body || ''}`);
  return created.id;
}

/**
 * Select the workspace by URL. Verified: picking one in the "Save to…" dropdown rewrites the URL
 * to /create?wid=<project_id>, and loading that URL directly preselects it — far more robust than
 * driving the dropdown. The read-back below is the guard; if Suno ever drops ?wid this throws
 * loudly instead of quietly filing 36 songs into the wrong workspace.
 */
async function gotoWorkspace(projectId) {
  await page.goto(`https://suno.com/create?wid=${projectId}`, { waitUntil: 'domcontentloaded' });
  await sleep(4000);
  const shown = await readSaveToLabel();
  if (shown && shown !== WORKSPACE) {
    throw new Error(`workspace did not switch — "Save to" shows "${shown}", expected "${WORKSPACE}"`);
  }
  if (!shown) console.error('  ⚠ could not read the "Save to" button — relying on the clip-count check');
}

/**
 * Best-effort read of the workspace shown next to "Save to…".
 *
 * This is an EARLY WARNING, not the safety net. The real guarantee is `expectClipCount`, which
 * polls the specific project_id: if ?wid= ever stopped routing Creates into that workspace, the
 * count would not rise and the run stops after the FIRST prompt — one wasted generation, not 36.
 * So a null here is a warning, never a hard failure; the label markup is far more likely to be
 * restyled than the routing is to break.
 *
 * Two strategies because the label and its button are not reliably siblings: a Playwright text
 * locator first, then a walk UP to the nearest ancestor that actually contains a button.
 */
async function readSaveToLabel() {
  try {
    const lbl = page.getByText(/^Save to/).last();
    if (await lbl.count().catch(() => 0)) {
      const btn = lbl.locator('xpath=ancestor::*[.//button][1]//button[1]');
      if (await btn.count().catch(() => 0)) {
        const t = (await btn.first().innerText().catch(() => '')).trim();
        if (t) return t;
      }
    }
  } catch { /* fall through */ }
  return page.evaluate(() => {
    const txt = e => (e.textContent || '').trim();
    const leaf = [...document.querySelectorAll('*')]
      .filter(e => !e.children.length && /^Save to/i.test(txt(e))).pop();
    if (!leaf) return null;
    let cur = leaf;
    for (let d = 0; cur && d < 8; d++, cur = cur.parentElement) {
      const b = cur.querySelector && cur.querySelector('button');
      if (b) return txt(b) || null;
    }
    return null;
  }).catch(() => null);
}

// ---------------------------------------------------------------- form chrome

async function ensureAdvancedTab() {
  const tab = page.getByRole('button', { name: 'Advanced', exact: true })
    .or(page.locator('button:has-text("Advanced")')).first();
  if (await tab.count().catch(() => 0)) await tab.click().catch(() => {});
  await sleep(1000);
}

async function ensureModel(model) {
  const shown = await page.evaluate(() => {
    const b = [...document.querySelectorAll('button')].find(e => /^v\d/.test((e.textContent || '').trim()));
    return b ? (b.textContent || '').trim() : null;
  });
  if (shown === model) { log(`✓ model already ${model}`); return; }
  const sel = page.locator('button').filter({ hasText: /^v\d[\d.+]*$/ }).first();
  if (!(await sel.count().catch(() => 0))) {
    console.error(`  ⚠ model selector not found — leaving as "${shown}" (wanted ${model})`);
    return;
  }
  await sel.click();
  await sleep(1200);
  const opt = page.getByRole('menuitem', { name: model, exact: true })
    .or(page.locator(`[role=option]:has-text("${model}")`))
    .or(page.locator(`div:text-is("${model}")`)).first();
  if (await opt.count().catch(() => 0)) await opt.click().catch(() => {});
  await page.keyboard.press('Escape').catch(() => {});
  await sleep(800);
}

async function ensureMoreOptions() {
  const hasSliders = async () => page.evaluate(() => !!document.querySelector('[aria-label="Weirdness"]'));
  if (await hasSliders()) return;
  const btn = page.locator('text=More Options').first();
  if (await btn.count().catch(() => 0)) { await btn.click().catch(() => {}); await sleep(1500); }
  if (!(await hasSliders())) throw new Error('could not expand More Options — Weirdness slider never appeared');
}

// ---------------------------------------------------------------- per-prompt

/**
 * Fill Styles / Exclude / Title.
 *
 * Anchoring on the "Exclude styles" placeholder is deliberate: the Styles box ships a RANDOM
 * sample placeholder (it has been "emotive delivery, trance influence…", "calm atmosphere,
 * adventurous…", others), and the page renders TWO "Song Title (Optional)" inputs. Only the
 * DOM order around Exclude is stable: [Styles] [Exclude] [Song Title].
 *
 * React inputs also ignore a plain `.value =` assignment, hence the native-setter dance.
 */
async function fillTextFields(item) {
  const got = await page.evaluate(([style, exclude, title]) => {
    const set = (el, v) => {
      const proto = el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
      Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, v);
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
    };
    const els = [...document.querySelectorAll('textarea,input')];
    const xi = els.findIndex(e => (e.placeholder || '').includes('Exclude styles'));
    if (xi < 1) return { error: 'no "Exclude styles" anchor in the DOM' };
    set(els[xi - 1], style);
    set(els[xi], exclude);
    set(els[xi + 1], title);
    return { style: els[xi - 1].value, exclude: els[xi].value, title: els[xi + 1].value };
  }, [item.style, item.exclude, item.title]);
  if (got.error) throw new Error(got.error);
  // The style input event re-renders the form; give it a beat before touching focus or sliders.
  await sleep(1000);
}

/**
 * Fill the lyrics box.
 *
 * It is a Lexical contenteditable, NOT a textarea: native value setters do nothing, a synthetic
 * ClipboardEvent is untrusted and ignored, and execCommand('insertText') eats every newline
 * (all section tags collapse onto one line). Clipboard + a REAL ctrl+v is the only fill that works.
 *
 * Focus is set in JS, never by clicking a coordinate — after the first Create the create panel
 * scrolls, and a coordinate that was right for prompt 1 pastes the whole lyric into Styles later.
 */
async function fillLyrics(item) {
  await page.evaluate(t => navigator.clipboard.writeText(t), item.lyrics);
  const focused = await page.evaluate(() => {
    const el = document.querySelector('[aria-label="Lyrics editor"]');
    if (!el) return null;
    el.focus();
    return document.activeElement.getAttribute('aria-label');
  });
  if (focused !== 'Lyrics editor') throw new Error('could not focus the lyrics editor');
  await page.keyboard.press(`${MOD}+A`);
  await page.keyboard.press(`${MOD}+V`);
  await sleep(1200);
}

async function readSliders() {
  return page.evaluate(() => ({
    w: Number(document.querySelector('[aria-label="Weirdness"]')?.getAttribute('aria-valuenow')),
    si: Number(document.querySelector('[aria-label="Style Influence"]')?.getAttribute('aria-valuenow')),
  }));
}

/**
 * Suno's sliders are Radix [role=slider] divs — value setters do nothing; they only move on real
 * arrow keys, and only while focused. Address them by aria-label, never by index: attaching an
 * audio reference adds a third slider and would shift every positional lookup.
 */
async function setSliders(targetW, targetSI, cur) {
  for (const [label, target, key] of [['Weirdness', targetW, 'w'], ['Style Influence', targetSI, 'si']]) {
    const delta = target - cur[key];
    if (delta === 0) continue;
    const ok = await page.evaluate(l => {
      const el = document.querySelector(`[aria-label="${l}"]`);
      if (!el) return false;
      el.focus();
      return document.activeElement === el;
    }, label);
    if (!ok) throw new Error(`could not focus the ${label} slider`);
    const arrow = delta > 0 ? 'ArrowRight' : 'ArrowLeft';
    for (let i = 0; i < Math.abs(delta); i++) await page.keyboard.press(arrow);
    await sleep(150);
  }
  // Read back rather than trust the arithmetic — a dropped keypress is silent otherwise.
  let now = await readSliders();
  for (const [label, target, key] of [['Weirdness', targetW, 'w'], ['Style Influence', targetSI, 'si']]) {
    let guard = 0;
    while (now[key] !== target && guard++ < 5) {
      await page.evaluate(l => document.querySelector(`[aria-label="${l}"]`).focus(), label);
      await page.keyboard.press(now[key] < target ? 'ArrowRight' : 'ArrowLeft');
      await sleep(120);
      now = await readSliders();
    }
  }
  return now;
}

/** Sticky Male/Female toggle in More Options — only touch it when it needs to change. */
async function setVocalGender(gender) {
  if (!gender) return;
  const want = gender.toLowerCase() === 'male' ? 'Male' : 'Female';
  const btn = page.getByRole('button', { name: want, exact: true }).first();
  if (!(await btn.count().catch(() => 0))) {
    console.error(`  ⚠ vocal gender "${want}" button not found — leaving unset`);
    return;
  }
  await btn.click().catch(() => {});
  await sleep(400);
}

/**
 * The gate. Never click Create on an unverified form — this is what catches a paste that landed
 * in the wrong field or a slider that silently dropped a keypress.
 */
async function verifyForm(item, cur) {
  const st = await page.evaluate(() => {
    const els = [...document.querySelectorAll('textarea,input')];
    const xi = els.findIndex(e => (e.placeholder || '').includes('Exclude styles'));
    const ed = document.querySelector('[aria-label="Lyrics editor"]');
    const text = ed ? ed.innerText : '';
    return {
      paras: ed ? ed.querySelectorAll('p').length : 0,
      head: text.slice(0, 60),
      endsWithEnd: text.trim().endsWith('[End]'),
      hasVocalTags: /\[Verse\]|\[Chorus\]/.test(text),
      style: xi > 0 ? els[xi - 1].value : '',
      exclude: xi > 0 ? els[xi].value : '',
      title: xi > 0 ? els[xi + 1].value : '',
      w: Number(document.querySelector('[aria-label="Weirdness"]')?.getAttribute('aria-valuenow')),
      si: Number(document.querySelector('[aria-label="Style Influence"]')?.getAttribute('aria-valuenow')),
    };
  });

  const problems = [];
  if (st.title !== item.title) problems.push(`title is "${st.title}"`);
  if (st.style.slice(0, 40) !== item.style.slice(0, 40)) problems.push('style field does not match');
  // A "["-prefixed style means the lyric paste landed in the Styles box — the classic coordinate bug.
  if (st.style.trim().startsWith('[')) problems.push('style starts with "[" — lyrics pasted into the wrong field');
  if (st.exclude !== item.exclude) problems.push('exclude field does not match');
  if (item.lyrics) {
    const want = item.lyrics.split('\n').filter(l => l.trim()).length;
    if (st.paras < want) problems.push(`lyrics has ${st.paras} paragraphs, expected >= ${want}`);
    if (!st.endsWithEnd && item.lyrics.trim().endsWith('[End]')) problems.push('lyrics does not end with [End]');
  }
  if (st.hasVocalTags) problems.push('lyrics contains [Verse]/[Chorus] — will trigger vocals');
  if (st.w !== item.w) problems.push(`Weirdness is ${st.w}, expected ${item.w}`);
  if (st.si !== item.si) problems.push(`Style Influence is ${st.si}, expected ${item.si}`);

  return { ok: !problems.length, problems, state: st };
}

async function clickCreate() {
  const btn = page.getByRole('button', { name: 'Create song' })
    .or(page.locator('button:has-text("Create")')).first();
  if (!(await btn.count().catch(() => 0))) throw new Error('Create button not found');
  await btn.click();          // exactly once — a second click bills a second generation
  await sleep(6000);
}

// ---------------------------------------------------------------- verification

async function clipCount(projectId) {
  const j = await api(`/api/project/${projectId}?page=1`);
  return j.__error ? null : (j.clip_count ?? 0);
}

/**
 * Wait for the workspace to report `want` clips.
 *
 * Suno's project listing is eventually consistent after a Create — the count can lag by tens of
 * seconds. Polling here (instead of failing fast) is what stops a spurious "it didn't work",
 * which historically led to a re-submit and a double charge. On timeout we STOP rather than retry.
 */
async function expectClipCount(projectId, want, timeoutMs = 90000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const n = await clipCount(projectId);
    if (n !== null && n >= want) return n;
    await sleep(5000);
  }
  return null;
}

async function finalVerify(projectId) {
  const seen = new Set(); const clips = [];
  for (let pg = 1; pg <= 40; pg++) {
    const j = await api(`/api/project/${projectId}?page=${pg}`);
    if (j.__error) break;
    const got = (j.project_clips || []).map(pc => pc.clip).filter(Boolean);
    let added = 0;
    for (const c of got) if (!seen.has(c.id)) { seen.add(c.id); clips.push(c); added++; }
    if (!got.length || !added || clips.length >= (j.clip_count || 0)) break;
  }
  const byTitle = {};
  for (const c of clips) byTitle[c.title || '(untitled)'] = (byTitle[c.title || '(untitled)'] || 0) + 1;

  const submitted = results.filter(r => r.submitted === true);
  const wrong = submitted.filter(r => byTitle[r.title] !== 2)
    .map(r => `${r.title}=${byTitle[r.title] ?? 0}`);

  log('');
  log(`Verification: ${clips.length} clips in the workspace, ${Object.keys(byTitle).length} distinct titles`);
  if (wrong.length) {
    console.error('⚠ these titles do not have exactly 2 clips (4 = double submit, 0/1 = still settling):');
    for (const w of wrong) console.error('   ' + w);
    failed++;
  } else {
    log('✓ every submitted title has exactly 2 clips — no double submits');
  }
}

// ---------------------------------------------------------------- doctor & diagnostics

/**
 * Probe every selector this runner depends on, and touch nothing.
 *
 * Suno's create form drifts (the Styles placeholder became randomised, a second "Song Title"
 * input appeared, the panel started scrolling after the first Create). Both submit paths have
 * been broken by that at least three times. `--doctor` turns "it broke somewhere in a 36-prompt
 * batch" into a 15-second yes/no you can run before starting work, and when something IS wrong
 * it prints the nearest candidates so the fix is one edit rather than an investigation.
 */
async function doctor() {
  log('Running selector health check…\n');
  await ensureLoggedIn();
  await page.goto('https://suno.com/create', { waitUntil: 'domcontentloaded' });
  await sleep(4000);
  await ensureAdvancedTab();
  await ensureMoreOptions().catch(() => {});

  const probe = await page.evaluate(() => {
    const txt = e => (e.textContent || '').trim();
    const els = [...document.querySelectorAll('textarea,input')];
    const xi = els.findIndex(e => (e.placeholder || '').includes('Exclude styles'));
    const buttons = [...document.querySelectorAll('button')]
      .map(b => ({ text: txt(b).slice(0, 40), label: b.getAttribute('aria-label') }))
      .filter(b => b.text || b.label);
    return {
      xi,
      fields: els.map((e, i) => ({ i, tag: e.tagName, placeholder: (e.placeholder || '').slice(0, 45) })),
      lyricsEditor: !!document.querySelector('[aria-label="Lyrics editor"]'),
      sliders: [...document.querySelectorAll('[role=slider]')].map(s => s.getAttribute('aria-label')),
      buttons,
      modelButton: (() => {
        const b = [...document.querySelectorAll('button')].find(e => /^v\d/.test(txt(e)));
        return b ? txt(b) : null;
      })(),
    };
  });

  const checks = [];
  const add = (ok, name, detail) => { checks.push({ ok, name, detail }); log(`${ok ? '✓' : '✗'} ${name}${detail ? '  — ' + detail : ''}`); };

  add(true, 'signed in');
  if (probe.xi >= 1) {
    const f = probe.fields;
    add(true, '"Exclude styles" anchor', `xi=${probe.xi} → Styles[${probe.xi - 1}] / Exclude[${probe.xi}] / Title[${probe.xi + 1}]`);
  } else {
    add(false, '"Exclude styles" anchor', 'not found — field addressing is broken');
    log('    inputs currently on the page:');
    for (const f of probe.fields) log(`      [${f.i}] ${f.tag} placeholder="${f.placeholder}"`);
  }
  add(probe.lyricsEditor, '[aria-label="Lyrics editor"]',
    probe.lyricsEditor ? null : 'not found — the lyrics box was renamed or is not rendered');

  for (const want of ['Weirdness', 'Style Influence']) {
    const ok = probe.sliders.includes(want);
    add(ok, `slider [aria-label="${want}"]`, ok ? null : `present sliders: ${probe.sliders.join(', ') || '(none)'}`);
  }

  const createBtn = probe.buttons.find(b => b.label === 'Create song' || /^Create( song)?$/i.test(b.text));
  if (createBtn) add(true, 'Create button', `text="${createBtn.text}" aria-label="${createBtn.label ?? ''}"`);
  else {
    add(false, 'Create button', 'no button matching "Create song" / "Create"');
    const near = probe.buttons.filter(b => /creat|generat|submit/i.test(b.text + ' ' + (b.label || '')));
    log('    nearest candidates: ' + (near.length ? near.map(b => `"${b.text}"`).join(', ') : '(none)'));
  }

  // Warning only: the clip-count check on the specific project_id is the real workspace guard.
  const saveTo = await readSaveToLabel();
  if (saveTo) log(`✓ "Save to" workspace button  — shows "${saveTo}"`);
  else log('⚠ "Save to" workspace button  — not readable; the clip-count check still guards routing');
  add(probe.modelButton !== null, 'model selector', probe.modelButton ? `shows "${probe.modelButton}"` : 'not found');

  const bad = checks.filter(c => !c.ok);
  log('');
  if (!bad.length) { log('✓ all selectors healthy — submit.mjs should run'); return true; }

  const file = await captureDiagnostics(`--doctor: ${bad.length} selector(s) failed`);
  log(`✗ ${bad.length} selector(s) failed: ${bad.map(b => b.name).join(', ')}`);
  log('  Suno\'s UI has drifted. Hand the diagnostics file below to Claude and ask it to');
  log('  update submit.mjs — it contains the full current form shape, so no re-run is needed.');
  if (file) log(`  → ${file}`);
  return false;
}

/**
 * Dump everything needed to repair a selector break, so the fix does not require re-running
 * the browser just to look: a screenshot plus the full current shape of the create form.
 */
async function captureDiagnostics(reason) {
  try {
    const outDir = fs.statSync(INPUT).isDirectory() ? INPUT : path.dirname(INPUT);
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const shotPath = path.join(outDir, `_submit_failure_${stamp}.png`);
    const jsonPath = path.join(outDir, `_submit_failure_${stamp}.json`);

    await page.screenshot({ path: shotPath, fullPage: false }).catch(() => {});

    const dom = await page.evaluate(() => {
      const txt = e => (e.textContent || '').trim();
      return {
        url: location.href,
        inputs: [...document.querySelectorAll('textarea,input')].map((e, i) => ({
          i, tag: e.tagName, type: e.type || null,
          placeholder: e.placeholder || null,
          ariaLabel: e.getAttribute('aria-label'),
          valueHead: (e.value || '').slice(0, 60),
        })),
        contentEditables: [...document.querySelectorAll('[contenteditable]')].map(e => ({
          ariaLabel: e.getAttribute('aria-label'), cls: (e.className || '').toString().slice(0, 80),
        })),
        sliders: [...document.querySelectorAll('[role=slider]')].map(s => ({
          ariaLabel: s.getAttribute('aria-label'), value: s.getAttribute('aria-valuenow'),
        })),
        buttons: [...document.querySelectorAll('button')]
          .map(b => ({ text: txt(b).slice(0, 50), ariaLabel: b.getAttribute('aria-label') }))
          .filter(b => b.text || b.ariaLabel),
      };
    }).catch(() => null);

    fs.writeFileSync(jsonPath, JSON.stringify({
      reason,
      at: new Date().toISOString(),
      runner: 'submit.mjs',
      expects: {
        fieldAnchor: 'input whose placeholder contains "Exclude styles"; Styles = xi-1, Title = xi+1',
        lyrics: '[aria-label="Lyrics editor"] (Lexical contenteditable, clipboard + real ctrl+v)',
        sliders: ['[aria-label="Weirdness"]', '[aria-label="Style Influence"]'],
        create: 'button named "Create song" (falls back to any button containing "Create")',
        workspace: 'navigate to /create?wid=<project_id>, verify via the "Save to" button',
      },
      dom,
    }, null, 2));

    log('');
    log('Diagnostics written (hand these to Claude to repair submit.mjs — no re-run needed):');
    log('  ' + jsonPath);
    log('  ' + shotPath);
    return jsonPath;
  } catch (e) {
    console.error('  (could not write diagnostics: ' + (e && e.message) + ')');
    return null;
  }
}

async function writeResult() {
  const outDir = fs.statSync(INPUT).isDirectory() ? INPUT : path.dirname(INPUT);
  const out = {
    workspace: WORKSPACE,
    model: MODEL,
    dryRun: DRY_RUN,
    selected: items.length,
    submitted: results.filter(r => r.submitted === true).length,
    failed,
    at: new Date().toISOString(),
    prompts: results,
  };
  const file = path.join(outDir, '_submit_result.json');
  fs.writeFileSync(file, JSON.stringify(out, null, 2));
  log('');
  log(`${failed ? '✗' : '✓'} ${out.submitted}/${items.length} submitted${DRY_RUN ? ' (dry run — nothing was created)' : ''}`);
  log(`  result → ${file}`);
}
