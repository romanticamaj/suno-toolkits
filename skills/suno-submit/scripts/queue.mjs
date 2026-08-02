#!/usr/bin/env node
/**
 * queue.mjs — build the submit queue from prompts.json, and push one prompt's lyrics
 * to the system clipboard (the only way to fill Suno's Lexical lyrics editor).
 *
 * Why this exists: every field the submit loop needs is derived, not literal — the title
 * follows a BGM##-aware rule, `negative_tags` must have its leading "NO " stripped per item,
 * and the lyrics have to reach the clipboard as UTF-16LE or CJK arrives mangled. Re-deriving
 * that by hand each session is how titles end up inconsistent.
 *
 * Usage:
 *   node queue.mjs <path> list                 # numbered queue (path = prompts.json OR a folder)
 *   node queue.mjs <path> <n>                  # fields for item n, as JSON
 *   node queue.mjs <path> <n> --clip           # ...and copy that item's lyrics to the clipboard
 *   node queue.mjs <path> list --only 01,03    # filter (see --only in SKILL.md)
 *
 * `list` also prints TOTAL= so a caller can bound its loop.
 */
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const argv = process.argv.slice(2);
if (!argv.length) {
  console.error('Usage: node queue.mjs <prompts.json|folder> <list|N> [--clip] [--only sel,sel]');
  process.exit(1);
}
const INPUT = argv[0];
const CMD = argv[1] || 'list';
const WANT_CLIP = argv.includes('--clip');
const onlyIx = argv.indexOf('--only');
const ONLY = onlyIx >= 0 ? (argv[onlyIx + 1] || '').split(',').map(s => s.trim()).filter(Boolean) : null;

// ---- collect prompts.json files (sorted, so the queue order is stable) ----
function findPromptFiles(p) {
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

// ---- build the queue ----
const queue = [];
for (const file of findPromptFiles(INPUT)) {
  const doc = JSON.parse(fs.readFileSync(file, 'utf8'));
  const parent = path.basename(path.dirname(file));
  const bgm = (parent.match(/^BGM_(\d+)/) || [])[1] || null;   // BGM_04_Foo → "04"
  const group = bgm ? 'BGM' + bgm : parent;
  for (const pr of doc.prompts || []) {
    // Title rule (SKILL.md): explicit `title` wins; else {short}_BGM##_{name} inside a BGM_NN_* folder,
    // else {short}_{name}. Keep short_name identical across an episode or downloads collide.
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
    });
  }
}

// ---- --only filter ----
// Resolution order per selector, first tier that hits wins:
//   group:id  → that one prompt          (e.g. BGM02:03)
//   exact id  → that id in EVERY group   (e.g. 01 = "prompt 01 of each BGM", the baseline test)
//   exact name→ all prompts with that name
//   title substring → must be unambiguous, else stop and ask
// The tiering matters: a bare id must NOT fall through to substring, or "03" also drags in
// every title containing "03" (BGM03:01, BGM03:02 …). Verified against a 30-prompt episode.
let items = queue;
if (ONLY) {
  const picked = [];
  for (const sel of ONLY) {
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
          console.error(`✗ --only "${sel}" is ambiguous: ${hits.map(h => h.group + ':' + h.id + ' ' + h.title).join(' | ')}`);
          console.error('  qualify it with group:id, e.g. ' + hits[0].group + ':' + hits[0].id);
          process.exit(1);
        }
      }
    }
    if (!hits.length) { console.error(`✗ --only "${sel}" matched nothing`); process.exit(1); }
    for (const h of hits) if (!picked.includes(h)) picked.push(h);
  }
  items = picked.sort((a, b) => a.i - b.i);
}

if (CMD === 'list') {
  for (const x of items) {
    console.log(`${String(x.i).padStart(2)} ${x.group} ${x.id} W=${x.w} SI=${x.si} ${x.title}`);
  }
  console.log('TOTAL=' + items.length);
  const shorts = [...new Set(queue.map(q => q.title.split('_')[0]))];
  if (shorts.length > 1) console.error('⚠ short_name is inconsistent across folders: ' + shorts.join(', '));
  process.exit(0);
}

const item = queue[Number(CMD) - 1];
if (!item) { console.error('no such index ' + CMD + ' (queue has ' + queue.length + ')'); process.exit(1); }

if (WANT_CLIP) {
  // clip.exe needs UTF-16LE or CJK comes out mangled. This is the ONLY reliable way to get
  // text into Suno's Lexical lyrics editor (see SKILL.md) — paste it with a real ctrl+v.
  if (process.platform === 'win32') execFileSync('clip', { input: Buffer.from(item.lyrics, 'utf16le') });
  else execFileSync('pbcopy', { input: Buffer.from(item.lyrics, 'utf8') });
}

const { lyrics, file, ...rest } = item;
console.log(JSON.stringify({
  ...rest,
  lyricsLines: lyrics ? lyrics.split('\n').filter(l => l.trim()).length : 0,
  lyricsHead: lyrics.slice(0, 60),
  endsWithEnd: lyrics.trim().endsWith('[End]'),
}, null, 1));
