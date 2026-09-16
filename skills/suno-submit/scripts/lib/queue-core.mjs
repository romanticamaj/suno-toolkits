/**
 * queue-core.mjs — the pure queue logic shared by queue.mjs (CLI) and submit.mjs (Playwright runner).
 *
 * Kept separate so both entry points derive titles, exclude tags and the --only filter from ONE
 * implementation. Two copies is how `short_name` drifts between the two paths and downloads
 * collide later.
 */
import fs from 'node:fs';
import path from 'node:path';

/** Collect prompts.json files under a file-or-folder path, sorted so queue order is stable. */
export function findPromptFiles(p) {
  const st = fs.statSync(p);
  if (st.isFile()) return [p];
  const out = [];
  const skipped = [];
  // Directories that hold COPIES, not new work. A delivery bundle (`export/`) or an archive keeps
  // its own prompts.json so it stays self-contained; globbing it as a second group re-submits the
  // whole episode — identical titles, double the credits, and the short_name consistency check
  // cannot see it because the copy is consistent by definition.
  const SKIP_DIR = /^(export|node_modules|\.git)$|^_/;
  (function walk(dir) {
    for (const e of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (SKIP_DIR.test(e.name)) {
          if (fs.existsSync(path.join(full, 'prompts.json'))) skipped.push(path.join(full, 'prompts.json'));
          continue;
        }
        walk(full);
      } else if (e.name === 'prompts.json') out.push(full);
    }
  })(p);
  if (skipped.length) {
    console.error(`⚠ ignored ${skipped.length} prompts.json in copy/archive folders (they would re-submit the same songs):`);
    for (const f of skipped) console.error('   ' + f);
  }
  return out;
}

/**
 * Build the full ordered queue from a prompts.json file or an episode folder.
 * Every derived field lives here — title rule, "NO " strip, slider defaults.
 */
export function buildQueue(input) {
  const queue = [];
  for (const file of findPromptFiles(input)) {
    const doc = JSON.parse(fs.readFileSync(file, 'utf8'));
    const parent = path.basename(path.dirname(file));
    const bgm = (parent.match(/^BGM_(\d+)/) || [])[1] || null;   // BGM_04_Foo → "04"
    const group = bgm ? 'BGM' + bgm : parent;
    for (const pr of doc.prompts || []) {
      // Title rule (SKILL.md): explicit `title` wins; else {short}_BGM##_{name} inside a BGM_NN_*
      // folder, else {short}_{name}. Keep short_name identical across an episode or downloads collide.
      const title = pr.title || (bgm
        ? `${doc.short_name}_BGM${bgm}_${pr.name}`
        : `${doc.short_name}_${pr.name}`);
      queue.push({
        i: queue.length + 1,
        file, group, id: pr.id, name: pr.name, title,
        // Carried so the drift check reads the declared short_name instead of re-parsing `title`:
        // an explicit per-prompt `title` legitimately ignores short_name, and parsing it back out
        // reported that deliberate override as a short_name inconsistency.
        short: doc.short_name,
        style: pr.style || '',
        // Suno's Exclude field wants bare tags — "NO vocals, NO drums" → "vocals, drums"
        exclude: (pr.negative_tags || '').split(',').map(s => s.trim().replace(/^no\s+/i, '')).filter(Boolean).join(', '),
        lyrics: pr.lyrics || '',
        w: pr.weirdness ?? 50,
        si: pr.style_influence ?? 50,
        model: pr.model || null,
        // Tri-state on purpose: true = instrumental, false = a sung track, null = not declared.
        // Collapsing absent to `false` would tell the pre-Create check "this one is meant to be
        // sung", which is exactly the wrong default for a toolkit whose batches are mostly BGM.
        instrumental: pr.instrumental ?? null,
        vocal_gender: pr.vocal_gender || null,
        audio_reference: pr.audio_reference || doc.audio_reference || null,
      });
    }
  }

  // Two prompts that compute the same title would create two identical pairs of songs. Whatever
  // the cause — a stray copy the skip list missed, a duplicated id, a hand-edited name — it is
  // always a double charge, so refuse rather than warn. A re-run of one prompt is unaffected:
  // that queue holds a single entry for the title.
  const byTitle = new Map();
  for (const q of queue) byTitle.set(q.title, (byTitle.get(q.title) || 0) + 1);
  const dupes = [...byTitle].filter(([, n]) => n > 1);
  if (dupes.length) {
    const lines = dupes.slice(0, 8).map(([t, n]) => `   ${t} ×${n}`).join('\n');
    throw new Error(`${dupes.length} title(s) appear more than once in this queue — submitting would ` +
      `create duplicate songs and charge twice:\n${lines}${dupes.length > 8 ? `\n   …and ${dupes.length - 8} more` : ''}\n` +
      `Check for a copied prompts.json (an export/ or backup folder) or repeated ids.`);
  }
  return queue;
}

/**
 * Apply the --only selector list to a queue.
 *
 * Resolution order per selector, first tier that hits wins:
 *   group:id  → that one prompt          (e.g. BGM02:03)
 *   exact id  → that id in EVERY group   (e.g. 01 = "prompt 01 of each BGM", the baseline test)
 *   exact name→ all prompts with that name
 *   title substring → must be unambiguous, else throw
 *
 * The tiering matters: a bare id must NOT fall through to substring, or "03" also drags in
 * every title containing "03" (BGM03:01, BGM03:02 …). Verified against a 30-prompt episode.
 */
export function applyOnly(queue, only) {
  if (!only || !only.length) return queue;
  const picked = [];
  for (const sel of only) {
    let hits;
    if (sel.includes(':')) {
      const [gPart, idPart] = sel.split(':');
      const norm = s => s.replace(/[_\s]/g, '').toLowerCase();
      hits = queue.filter(q => norm(q.group).includes(norm(gPart)) && q.id === idPart);
    } else {
      hits = queue.filter(q => q.id === sel);
      if (!hits.length) hits = queue.filter(q => q.name === sel);
      if (!hits.length) {
        hits = queue.filter(q => q.title.toLowerCase().includes(sel.toLowerCase()));
        if (hits.length > 1) {
          const cands = hits.map(h => h.group + ':' + h.id + ' ' + h.title).join(' | ');
          throw new Error(`--only "${sel}" is ambiguous: ${cands}\n  qualify it with group:id, e.g. ${hits[0].group}:${hits[0].id}`);
        }
      }
    }
    if (!hits.length) throw new Error(`--only "${sel}" matched nothing`);
    for (const h of hits) if (!picked.includes(h)) picked.push(h);
  }
  return picked.sort((a, b) => a.i - b.i);
}

/** Distinct short_name values in a queue — more than one means titles will be inconsistent. */
export function shortNames(queue) {
  return [...new Set(queue.map(q => q.short).filter(Boolean))];
}

/** First non-null model across the queue, mapped to the create form's dropdown label. */
/**
 * Which model the batch runs on.
 *
 * `known` is what Suno's dropdown ACTUALLY offers, read from the live menu on 2026-09-16:
 * v6 · v6-wild · v6-mini, all `role=menuitemradio`. The v5.x and v4.5 line was retired when v6
 * shipped — so every prompts.json still saying `"model": "v5.5"` (which is most of them) now asks
 * for something unselectable. That falls through to the warning branch and runs on the fallback,
 * which is the honest outcome; the alternative was the silent wrong-model batch this list existed
 * to prevent. Re-read the menu and update this when Suno ships the next generation.
 */
export function resolveModel(queue, fallback = 'v6') {
  const raw = queue.map(q => q.model).find(Boolean) || fallback;
  const known = ['v6', 'v6-wild', 'v6-mini'];

  // The model is set ONCE on the form and applies to the whole batch — per-prompt `model` values
  // that disagree cannot be honoured, so say so rather than silently using whichever came first.
  const distinct = [...new Set(queue.map(q => q.model).filter(Boolean))];
  const mixed = distinct.length > 1
    ? `prompts request different models (${distinct.join(', ')}) — the form takes one per batch, using "${raw}" for all of them; split the batch to use others`
    : null;

  if (known.includes(raw)) return { model: raw, warning: mixed };
  // v3 / v3.5 are no longer in Suno's dropdown
  const unknown = `model "${raw}" is not in Suno's dropdown — falling back to ${fallback}`;
  return { model: fallback, warning: mixed ? `${unknown}. Also: ${mixed}` : unknown };
}
