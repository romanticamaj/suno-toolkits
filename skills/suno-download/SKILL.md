---
name: suno-download
description: Download a Suno workspace as lossless WAV + full-metadata sidecar JSON by running scripts/download.mjs. Use when the user wants to download Suno songs, export a workspace, fetch WAV files, grab generated tracks, or invokes "/suno-download". Do NOT drive the browser turn by turn - launch the script, which resolves the workspace, waits for rendering clips, converts, downloads with size verification, writes sidecars and _download_result.json in one process. Shares the persistent Chrome profile (and one-time --login) with suno-submit. A model-driven Claude in Chrome loop remains as the documented fallback in references/path-b.md.
version: 2.0.0
---

# Suno Download

Download every song (or a subset) from a Suno workspace as **lossless WAV** (48 kHz / 16-bit /
stereo PCM) plus a **complete metadata sidecar JSON** per track.

## What this skill does

**Run the script. Do not drive the browser by hand.** `scripts/download.mjs` performs the whole
job in one process; your part is to launch it with the right arguments and report from
`_download_result.json`. A 60-clip workspace costs ~2 model turns this way versus ~25 driving
the API calls yourself (and the tool channel blocks the signed download URLs, which forced a
browser-download detour on every manual run).

Path B (the model-driven Claude-in-Chrome loop) lives in **`references/path-b.md`** and is the
**fallback**, not an equal option. Read it only when the script fails and the download is
urgent — then fix the script.

---

## Workflow

### Step 1 · Resolve the arguments

- **workspace** — the exact name, or a distinctive substring (case-insensitive). The script
  stops and lists candidates if the substring is ambiguous; pick and re-run.
- **`--out`** — where the files land. Use the project's `audio/` folder when one exists
  (`<project>/audio`); otherwise ask. **Always pass it** — the default is the current directory.
- **`--only a,b`** (optional) — each item matches a clip id exactly or a title substring.

### Step 2 · Dry run when the workspace is unfamiliar

```bash
node "<skill>/scripts/download.mjs" "<workspace>" --out "<dir>" --dry-run
```

~20 s, opens Chrome, lists every clip with status, duration and the planned filename, downloads
nothing. Skip this when the workspace was just created by `/suno-submit` in this session.

### Step 3 · Run it in the background

Conversion + download of a full workspace takes minutes (first-run WAV conversion is server-side
and not instant; 112 clips took ~3–4 min just to convert). **Always `run_in_background: true`.**

```bash
node "<skill>/scripts/download.mjs" "<workspace>" --out "<dir>"      # + --only … if used
```

The script **waits for rendering clips** (up to 20 min, `--wait-timeout <min>` to change,
`--no-wait` to download only what is complete). Launching it right after `/suno-submit` is fine.

Do not start a second run while one is in flight — both would open the same Chrome profile and
the second will refuse (the profile is file-locked). `/suno-submit` shares that profile too.

### Step 4 · Report from the result file

Read `<dir>/_download_result.json`. Report `ok / selected`, and surface every entry with
`ok: false` (its `error` says why: still rendering, convert refused, size mismatch after 3
tries). Exit `0` means **every selected clip is on disk and passed the size check**.

Re-running is safe and cheap: files already on disk that pass verification are **skipped**, so
a partial run is resumed by launching the same command again.

### Notes on invocation

- `<skill>` is this skill's own directory — the script sits beside this file.
- **First use on a machine** needs `npm install && npx playwright install chrome` in the repo
  root, then a one-time sign-in. If the script prints `sign-in required (no TTY)`, give the user
  the command it printed and ask them to run it with a `! ` prefix in this session:
  `! node "<skill>/scripts/download.mjs" --login`
  (the same profile serves `/suno-submit`, so a sign-in done there counts here).
- Pass paths through verbatim, quoted — workspace names carry spaces and CJK.

---

## What the script guarantees

- **Sidecar = the clip object from `/api/project/{id}`.** Verified identical (41 keys) to what
  `/api/feed/` returns, so there is no second metadata round-trip.
- **Filename** `{workspace} - {title}_{a|b}.wav` — the takes of a title ordered by
  `created_at`, then `id`. **Never by `batch_index`**: that field is transient (present right
  after a Create, gone from the same endpoint a day later), so a name built from it cannot be
  reproduced and a re-run silently swaps a/b under existing files. A title with >2 clips (double
  submit) gets `_c`, `_d`, …. Illegal characters → `_`; paths over 240 chars drop the prefix.
- **Verification catches truncation AND the wrong take.** A cut-off download keeps a valid
  `RIFF` header and only shows up as a short file — the script checks
  `size ≈ duration × 192000 + 44` (±3 %). Two takes of one title are often within 3 % of each
  other, so it also reads the clip id Suno embeds in every WAV (`ICMT … id=<clip id>`) and
  requires it to equal the clip being downloaded. Failures retry up to 3 times with a **fresh**
  signed URL (the old one may have expired). On a re-run, only files passing both checks are
  skipped.
- **Rate-limit safe.** ≤5 concurrent `studio-api` calls with 429 backoff; downloads run 8-wide
  against the CDN, which is a separate system.
- **Never spends credits** — `convert_wav` renders an existing clip; nothing new is generated.
  WAV export does need a paid plan (a `401/403` from `convert_wav` is reported per clip).

## Options

`--out <dir>` · `--only a,b` · `--dry-run` · `--no-wait` · `--wait-timeout <min>` (20) ·
`--login` · `--profile "<dir>"` · `--headless` (headed is the default; same fingerprint reasoning
as `submit.mjs`).

## Output

`<dir>/{name}.wav` + `<dir>/{name}.json` per clip, and `<dir>/_download_result.json`:
`{ workspace, projectId, outDir, selected, ok, skipped, failed, at, clips: [{ id, title,
variant, file, duration, ok, size | error }] }`.

## References

- `references/path-b.md` — the model-driven Claude-in-Chrome procedure and its JS blocks
  (workspace/clip listing, convert+poll, URL-map export, sidecar bundle). Fallback only.
- `../suno-submit/scripts/lib/session.mjs` — the shared profile / login / `api()` helper.
