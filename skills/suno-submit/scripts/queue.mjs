#!/usr/bin/env node
/**
 * queue.mjs — build the submit queue from prompts.json, and push one prompt's lyrics
 * to the system clipboard (the only way to fill Suno's Lexical lyrics editor by hand).
 *
 * Why this exists: every field the submit loop needs is derived, not literal — the title
 * follows a BGM##-aware rule, `negative_tags` must have its leading "NO " stripped per item,
 * and the lyrics have to reach the clipboard as UTF-16LE or CJK arrives mangled. Re-deriving
 * that by hand each session is how titles end up inconsistent.
 *
 * This is the CLI for the **Claude-in-Chrome** (model-driven) submit path. The Playwright
 * runner (`submit.mjs`) imports the same logic from lib/queue-core.mjs — keep derivations there,
 * not here, so the two paths can never disagree.
 *
 * Usage:
 *   node queue.mjs <path> list                 # numbered queue (path = prompts.json OR a folder)
 *   node queue.mjs <path> <n>                  # fields for item n, as JSON
 *   node queue.mjs <path> <n> --clip           # ...and copy that item's lyrics to the clipboard
 *   node queue.mjs <path> list --only 01,03    # filter (see --only in SKILL.md)
 *
 * `list` also prints TOTAL= so a caller can bound its loop.
 */
import { execFileSync } from 'node:child_process';
import { buildQueue, applyOnly, shortNames } from './lib/queue-core.mjs';

const argv = process.argv.slice(2);
if (!argv.length) {
  console.error('Usage: node queue.mjs <prompts.json|folder> <list|N> [--clip] [--only sel,sel]');
  process.exit(1);
}
const INPUT = argv[0];
const CMD = argv[1] || 'list';
const WANT_CLIP = argv.includes('--clip');
// `--only` with nothing after it must fail, not quietly select everything. Left alone it yields
// an empty selector list, which applyOnly treats as "no filter" — so `… list --only` printed the
// whole queue as if the filter had been honoured. submit.mjs guards this; queue.mjs parses the
// flag separately and did not, so the guard has to exist in both places.
const onlyIx = argv.indexOf('--only');
const onlyRaw = onlyIx >= 0 ? argv[onlyIx + 1] : null;
if (onlyIx >= 0 && (onlyRaw === undefined || onlyRaw.startsWith('--'))) {
  console.error('✗ --only needs a value, e.g. --only 01,03 (leaving it empty would list everything)');
  process.exit(1);
}
const ONLY = onlyIx >= 0 ? onlyRaw.split(',').map(s => s.trim()).filter(Boolean) : null;
if (ONLY && !ONLY.length) {
  console.error('✗ --only was given but selects nothing — check the value');
  process.exit(1);
}

// buildQueue throws on a duplicate title (a double charge waiting to happen). Surface that as a
// one-line error like every other failure here; an uncaught throw dumps a stack trace and buries
// the message that actually tells the user what to do.
let queue;
try {
  queue = buildQueue(INPUT);
} catch (e) {
  console.error('✗ ' + e.message);
  process.exit(1);
}

let items;
try {
  items = applyOnly(queue, ONLY);
} catch (e) {
  console.error('✗ ' + e.message);
  process.exit(1);
}

if (CMD === 'list') {
  for (const x of items) {
    console.log(`${String(x.i).padStart(2)} ${x.group} ${x.id} W=${x.w} SI=${x.si} ${x.title}`);
  }
  console.log('TOTAL=' + items.length);
  const shorts = shortNames(queue);
  if (shorts.length > 1) console.error('⚠ short_name is inconsistent across folders: ' + shorts.join(', '));
  process.exit(0);
}

const item = queue[Number(CMD) - 1];
if (!item) { console.error('no such index ' + CMD + ' (queue has ' + queue.length + ')'); process.exit(1); }

if (WANT_CLIP) {
  // clip.exe needs UTF-16LE or CJK comes out mangled. This is the ONLY reliable way to get
  // text into Suno's Lexical lyrics editor by hand (see SKILL.md) — paste it with a real ctrl+v.
  // (submit.mjs avoids the OS clipboard entirely — it writes to the *page* clipboard instead,
  // so nothing the user copies mid-run can clobber it.)
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
