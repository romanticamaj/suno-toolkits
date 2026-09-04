/**
 * session.mjs — the logged-in Suno browser session shared by submit.mjs and download.mjs.
 *
 * Everything here was learned on the submit path and is documented in suno-submit/SKILL.md
 * ("Login model", "Why headed, and why real Chrome"). Both scripts open the SAME persistent
 * profile, so one `--login` serves both.
 *
 *   defaultProfileDir()                 → OS-appropriate profile path, outside any repo
 *   launchSession({...})                → { ctx, page } on the persistent profile
 *   ensureLoggedIn(page, {...})         → resolves when Clerk has a token, or throws with
 *                                         the exact --login command to run (no-TTY safe)
 *   api(page, path, init)               → authenticated studio-api call from inside the page;
 *                                         the token never leaves the browser
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import readline from 'node:readline';

export const sleep = ms => new Promise(r => setTimeout(r, ms));

export function defaultProfileDir() {
  if (process.platform === 'win32') {
    return path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'), 'suno-toolkits-profile');
  }
  if (process.platform === 'darwin') {
    return path.join(os.homedir(), 'Library', 'Application Support', 'suno-toolkits-profile');
  }
  return path.join(process.env.XDG_DATA_HOME || path.join(os.homedir(), '.local', 'share'), 'suno-toolkits-profile');
}

/**
 * Open the persistent profile in real Chrome.
 * `clipboard: true` grants page-clipboard permissions on suno.com (submit needs it for the
 * Lexical lyrics paste; download does not).
 */
export async function launchSession({ profileDir, headless = false, slowMo = 0, clipboard = false } = {}) {
  let chromium;
  try {
    ({ chromium } = await import('playwright'));
  } catch {
    console.error('✗ playwright is not installed.');
    console.error('  From the suno-toolkits repo root:  npm install && npx playwright install chrome');
    process.exit(1);
  }

  fs.mkdirSync(profileDir, { recursive: true });

  const ctx = await chromium.launchPersistentContext(profileDir, {
    channel: 'chrome',            // the real Chrome, not bundled Chromium — closer fingerprint
    headless,
    slowMo,
    viewport: null,
    // Google's OAuth screen refuses to sign in from a browser flagged as automated
    // ("this browser or app may not be secure"). Playwright ships --enable-automation and
    // sets navigator.webdriver; dropping both is what lets the one-time --login succeed.
    ignoreDefaultArgs: ['--enable-automation'],
    args: ['--start-maximized', '--disable-blink-features=AutomationControlled'],
  });
  // Belt and braces: some Chrome builds still expose navigator.webdriver after the flag above.
  await ctx.addInitScript(() => {
    Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
  });
  if (clipboard) {
    await ctx.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: 'https://suno.com' });
  }

  const page = ctx.pages()[0] || await ctx.newPage();
  page.setDefaultTimeout(30000);
  return { ctx, page };
}

export async function isLoggedIn(page) {
  try {
    return await page.evaluate(async () => {
      try { return !!(await window.Clerk?.session?.getToken()); } catch { return false; }
    });
  } catch { return false; }
}

/**
 * Resolve once the profile holds a Suno session.
 *
 * Without a TTY there is nobody to answer the sign-in prompt — an agent or CI would hang with a
 * Chrome window open and no indication why. Fail fast and print the exact command to run instead.
 * The thrown error carries `skipDiagnostics: true` so callers that dump UI diagnostics on failure
 * know this one is not a UI problem.
 */
export async function ensureLoggedIn(page, { profileDir, loginOnly = false, log = console.log } = {}) {
  await page.goto('https://suno.com/create', { waitUntil: 'domcontentloaded' });
  await sleep(4000);
  if (await isLoggedIn(page)) { log('✓ already signed in'); return; }

  if (!process.stdin.isTTY) {
    const p = profileDir && profileDir !== defaultProfileDir() ? ` --profile "${profileDir}"` : '';
    log('');
    console.error('✗ not signed in to Suno, and there is no terminal to sign in from.');
    if (loginOnly) {
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
  if (!(await isLoggedIn(page))) throw new Error('still not signed in to Suno — re-run once logged in');
  log('✓ signed in');
}

/**
 * Authenticated studio-api call, executed inside the page so the Clerk token never leaves the
 * browser. Returns parsed JSON, `{}` for an empty body, or `{ __error: <status>, body }`.
 */
export async function api(page, pathAndQuery, init = null) {
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

/**
 * `api()` with 429 backoff (2s → 30s, 6 tries). Suno's studio-api throttles aggressive clients;
 * use this for anything called in a loop or a pool.
 */
export async function apiRetry(page, pathAndQuery, init = null) {
  let last = null;
  for (let i = 0; i < 6; i++) {
    last = await api(page, pathAndQuery, init);
    if (last && last.__error === 429) { await sleep(Math.min(2000 * 2 ** i, 30000)); continue; }
    return last;
  }
  return last;
}

/** Run `fn` over `items` with at most `limit` in flight. Results keep input order. */
export async function pool(items, limit, fn) {
  const out = new Array(items.length);
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (i < items.length) { const k = i++; out[k] = await fn(items[k], k); }
  }));
  return out;
}
