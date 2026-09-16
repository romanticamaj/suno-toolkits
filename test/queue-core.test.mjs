/**
 * Unit tests for queue-core.mjs — the pure queue logic behind both suno-submit entry points.
 *
 * Scope is deliberate: submit.mjs and download.mjs drive a real browser and are covered by
 * `--doctor` / `--dry-run` against live Suno. Everything HERE is pure and can be wrong silently,
 * which is exactly where this repo's regressions have landed (see the v6 case below).
 *
 * Run: npm test
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { buildQueue, applyOnly, shortNames, resolveModel, findPromptFiles }
  from '../skills/suno-submit/scripts/lib/queue-core.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIX = p => path.join(HERE, 'fixtures', p);

const episode = () => buildQueue(FIX('episode'));

// ─────────────────────────────────────────────────────────────── findPromptFiles

test('findPromptFiles: folder walk is sorted, so queue order is reproducible', () => {
  const files = findPromptFiles(FIX('episode')).map(f => path.basename(path.dirname(f)));
  assert.deepEqual(files, ['BGM_01_Opening', 'BGM_02_Chase']);
});

test('findPromptFiles: a direct file path returns just that file', () => {
  const one = FIX(path.join('single', 'prompts.json'));
  assert.deepEqual(findPromptFiles(one), [one]);
});

// ─────────────────────────────────────────────────────────────────── buildQueue

test('buildQueue: title inside a BGM_NN_* folder carries the BGM number', () => {
  const q = episode();
  assert.equal(q[0].title, 'Fable_BGM01_WarmNylon');
  assert.equal(q[0].group, 'BGM01');
});

test('buildQueue: title outside a BGM folder omits the BGM segment', () => {
  const q = buildQueue(FIX('single'));
  assert.equal(q[0].title, 'Solo_OnlyTrack');
  assert.equal(q[0].group, 'single');
});

test('buildQueue: an explicit per-prompt title overrides the derived one', () => {
  const q = episode();
  assert.equal(q.find(x => x.id === '03').title, 'ExplicitTitleWins');
});

test('buildQueue: exclude strips a leading "NO " case-insensitively and drops empties', () => {
  const q = episode();
  // "NO vocals, NO drums" → bare tags; Suno's Exclude field rejects the NO prefix.
  assert.equal(q[0].exclude, 'vocals, drums');
  // "no brass,  NO   synth lead , " → lowercase prefix, inner padding, and a trailing empty item.
  assert.equal(q[1].exclude, 'brass, synth lead');
});

test('buildQueue: an empty negative_tags yields an empty exclude, not "undefined"', () => {
  const q = episode();
  assert.equal(q.find(x => x.title === 'Fable_BGM02_HornDrive').exclude, '');
});

test('buildQueue: weirdness/style_influence fall back to Suno default 50', () => {
  const q = episode();
  assert.equal(q[0].w, 50);
  assert.equal(q[0].si, 50);
});

test('buildQueue: explicit weirdness/style_influence are preserved, including 0-ish values', () => {
  const q = episode();
  assert.equal(q[1].w, 20);
  assert.equal(q[1].si, 80);
});

test('buildQueue: instrumental is strict-true only', () => {
  const q = episode();
  assert.equal(q[0].instrumental, true);
  assert.equal(q.find(x => x.id === '03').instrumental, false);
});

test('buildQueue: null lyrics become an empty string rather than the literal null', () => {
  const q = episode();
  assert.equal(q[1].lyrics, '');
});

test('buildQueue: model stays null when unset so resolveModel can apply the fallback', () => {
  const q = episode();
  assert.equal(q[0].model, null);
  assert.equal(q[1].model, 'v6');
});

test('buildQueue: audio_reference falls back to the document-level value', () => {
  const q = episode();
  // BGM_02 sets a doc-level ref; prompt 01 inherits it, prompt 03 overrides it.
  assert.equal(q.find(x => x.title === 'Fable_BGM02_HornDrive').audio_reference, 'DocLevelRef');
  assert.equal(q.find(x => x.id === '03').audio_reference, 'PromptLevelRef');
});

test('buildQueue: index i is 1-based and continuous across group boundaries', () => {
  const q = episode();
  assert.deepEqual(q.map(x => x.i), [1, 2, 3, 4]);
});

// ──────────────────────────────────────────────────────────────────── applyOnly

test('applyOnly: no selector returns the queue untouched', () => {
  const q = episode();
  assert.equal(applyOnly(q, []), q);
  assert.equal(applyOnly(q, undefined), q);
});

test('applyOnly: group:id selects exactly one prompt', () => {
  const picked = applyOnly(episode(), ['BGM02:01']);
  assert.deepEqual(picked.map(p => p.title), ['Fable_BGM02_HornDrive']);
});

test('applyOnly: group part ignores underscores, spaces and case', () => {
  for (const sel of ['BGM_02:01', 'bgm02:01', 'BGM 02:01']) {
    assert.deepEqual(applyOnly(episode(), [sel]).map(p => p.id), ['01'], `selector ${sel}`);
  }
});

test('applyOnly: a bare id selects that id in EVERY group — the baseline-test behaviour', () => {
  const picked = applyOnly(episode(), ['01']);
  assert.deepEqual(picked.map(p => p.title), ['Fable_BGM01_WarmNylon', 'Fable_BGM02_HornDrive']);
});

test('applyOnly: a bare id must NOT fall through to a title substring match', () => {
  // Regression guard for the documented trap: if "03" fell through to substring matching it would
  // also drag in every title containing "03". Here id "03" exists, so exactly one prompt matches.
  const picked = applyOnly(episode(), ['03']);
  assert.equal(picked.length, 1);
  assert.equal(picked[0].id, '03');
});

test('applyOnly: an exact name matches when no id does', () => {
  const picked = applyOnly(episode(), ['TenseStrings']);
  assert.deepEqual(picked.map(p => p.name), ['TenseStrings']);
});

test('applyOnly: a unique title substring resolves', () => {
  const picked = applyOnly(episode(), ['warmnylon']);
  assert.deepEqual(picked.map(p => p.title), ['Fable_BGM01_WarmNylon']);
});

test('applyOnly: an ambiguous title substring throws and names the candidates', () => {
  // "Fable_" prefixes three of the four titles (the fourth has an explicit title).
  assert.throws(() => applyOnly(episode(), ['Fable_']), err => {
    assert.match(err.message, /ambiguous/);
    assert.match(err.message, /qualify it with group:id/);
    assert.match(err.message, /BGM01:01/);
    return true;
  });
});

test('applyOnly: a selector matching nothing throws rather than silently narrowing the batch', () => {
  assert.throws(() => applyOnly(episode(), ['nope']), /matched nothing/);
});

test('applyOnly: overlapping selectors de-duplicate instead of submitting twice', () => {
  // Submitting the same prompt twice would spend credits twice — the dedupe is a money guard.
  const picked = applyOnly(episode(), ['BGM01:01', '01', 'WarmNylon']);
  assert.equal(picked.filter(p => p.title === 'Fable_BGM01_WarmNylon').length, 1);
});

test('applyOnly: result keeps original queue order regardless of selector order', () => {
  const picked = applyOnly(episode(), ['BGM02:01', 'BGM01:01']);
  assert.deepEqual(picked.map(p => p.i), [1, 3]);
});

// ─────────────────────────────────────────────────────────────────── shortNames

test('shortNames: a consistent episode reports exactly one prefix', () => {
  assert.deepEqual(shortNames(episode()), ['Fable']);
});

test('shortNames: drifting short_name across folders is surfaced, not merged', () => {
  // More than one prefix means downloaded filenames will be inconsistent later.
  assert.deepEqual(shortNames(buildQueue(FIX('drift'))).sort(), ['Alpha', 'Beta']);
});

// ────────────────────────────────────────────────────────────────── resolveModel

test('resolveModel: v6 is accepted', () => {
  // REGRESSION GUARD (2026-09-15): v6 was missing from the known list, so a prompts.json asking
  // for v6 was silently downgraded to v5.5 and a 27-prompt batch nearly ran on the wrong model.
  assert.deepEqual(resolveModel([{ model: 'v6' }]), { model: 'v6', warning: null });
});

test('resolveModel: every shorthand currently in Suno\'s dropdown is accepted without warning', () => {
  for (const m of ['v6', 'v5.5', 'v5', 'v4.5+', 'v4.5']) {
    assert.deepEqual(resolveModel([{ model: m }]), { model: m, warning: null }, `model ${m}`);
  }
});

test('resolveModel: an all-null queue uses the default, with no warning', () => {
  assert.deepEqual(resolveModel([{ model: null }, { model: null }]), { model: 'v5.5', warning: null });
});

test('resolveModel: the first non-null model in the queue wins', () => {
  assert.equal(resolveModel([{ model: null }, { model: 'v5' }, { model: 'v6' }]).model, 'v5');
});

test('resolveModel: a retired model falls back AND warns — the fallback must never be silent', () => {
  const r = resolveModel([{ model: 'v3.5' }]);
  assert.equal(r.model, 'v5.5');
  assert.match(r.warning, /v3\.5/);
  assert.match(r.warning, /falling back to v5\.5/);
});

test('resolveModel: an unknown future model warns rather than being passed through to the UI', () => {
  const r = resolveModel([{ model: 'v7' }]);
  assert.equal(r.model, 'v5.5');
  assert.match(r.warning, /v7/);
});

test('resolveModel: a caller-supplied fallback is honoured', () => {
  assert.equal(resolveModel([{ model: null }], 'v6').model, 'v6');
});

test('resolveModel: an empty queue still yields a usable model', () => {
  assert.deepEqual(resolveModel([]), { model: 'v5.5', warning: null });
});

// ────────────────────────────────── copies, duplicates, tri-state (added 2026-09-16)
//
// Each of these covers a defect an audit found in the shipped code: a delivered project keeps a
// copy of prompts.json inside export/, which the folder walk happily queued a second time —
// identical titles, double the credits, and the short_name drift check cannot see it because a
// copy is consistent with itself by definition.

test('findPromptFiles: a prompts.json inside export/ is ignored, not queued again', () => {
  const files = findPromptFiles(FIX('copyfolder'));
  assert.equal(files.length, 1, 'only the project root copy should be queued');
  assert.ok(!files[0].includes('export'), `export/ copy leaked into the queue: ${files[0]}`);
});

test('buildQueue: the export/ copy does not double the queue', () => {
  const q = buildQueue(FIX('copyfolder'));
  assert.equal(q.length, 2);
  assert.deepEqual(q.map(x => x.title), ['Camp_Emberlight', 'Camp_StillWater']);
});

test('buildQueue: duplicate computed titles abort — they would charge twice', () => {
  assert.throws(() => buildQueue(FIX('duptitle')), err => {
    assert.match(err.message, /appear more than once/i);
    assert.match(err.message, /Dup_SameName/);
    return true;
  });
});

test('buildQueue: instrumental stays tri-state — true / false / null when undeclared', () => {
  const q = buildQueue(FIX('vocal'));
  assert.equal(q[0].instrumental, false, 'an explicitly sung track must stay false');
  assert.equal(q[1].instrumental, null, 'an undeclared prompt must not be coerced to false');
  // Coercing null → false would tell the pre-Create check "this is meant to be sung" and let a
  // mislabelled instrumental sprout vocals.
  const inst = buildQueue(FIX('episode'));
  assert.equal(inst[0].instrumental, true);
});

test('resolveModel: prompts asking for different models warn — the form takes one per batch', () => {
  const { model, warning } = resolveModel(buildQueue(FIX('mixedmodel')));
  assert.equal(model, 'v6', 'the first non-null model still wins');
  assert.match(warning, /different models/i);
  assert.match(warning, /v6/);
  assert.match(warning, /v5\.5/);
});

test('resolveModel: agreeing prompts do not warn, and neither does an all-null queue', () => {
  assert.equal(resolveModel([{ model: 'v6' }, { model: 'v6' }]).warning, null);
  assert.equal(resolveModel([{ model: null }, { model: null }]).warning, null);
  // One declared + one undeclared is not a disagreement — null means "no preference".
  assert.equal(resolveModel([{ model: 'v6' }, { model: null }]).warning, null);
});
