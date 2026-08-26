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
  (function walk(dir) {
    for (const e of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) walk(full);
      else if (e.name === 'prompts.json') out.push(full);
    }
  })(p);
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
        style: pr.style || '',
        // Suno's Exclude field wants bare tags — "NO vocals, NO drums" → "vocals, drums"
        exclude: (pr.negative_tags || '').split(',').map(s => s.trim().replace(/^no\s+/i, '')).filter(Boolean).join(', '),
        lyrics: pr.lyrics || '',
        w: pr.weirdness ?? 50,
        si: pr.style_influence ?? 50,
        model: pr.model || null,
        instrumental: pr.instrumental === true,
        vocal_gender: pr.vocal_gender || null,
        audio_reference: pr.audio_reference || doc.audio_reference || null,
      });
    }
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

/** Distinct short_name prefixes in a queue — more than one means titles will be inconsistent. */
export function shortNames(queue) {
  return [...new Set(queue.map(q => q.title.split('_')[0]))];
}

/** First non-null model across the queue, mapped to the create form's dropdown label. */
export function resolveModel(queue, fallback = 'v5.5') {
  const raw = queue.map(q => q.model).find(Boolean) || fallback;
  const known = ['v5.5', 'v5', 'v4.5+', 'v4.5'];
  if (known.includes(raw)) return { model: raw, warning: null };
  // v3 / v3.5 are no longer in Suno's dropdown
  return { model: fallback, warning: `model "${raw}" is not in Suno's dropdown — falling back to ${fallback}` };
}
