---
name: suno-submit
description: Batch-submit prompts.json files to Suno by running scripts/submit.mjs. Use when the user wants to submit Suno prompts, send prompts to Suno, batch-generate songs, run a prompts.json, re-submit or regenerate a single prompt, or invokes "/suno-submit". Do NOT drive the create form turn by turn - launch the script, which creates/switches the workspace and fills style, lyrics, exclude, title, model, Weirdness/Style Influence and vocal gender for every prompt in one process, then read _submit_result.json. It signs in through its own persistent Chrome profile (one-time --login), self-checks with --doctor, and dumps repair diagnostics when Suno's UI drifts. A model-driven Claude in Chrome loop remains as the documented fallback for audio references and for urgent batches when the script is broken. Supports an --only selector for a subset. Pairs with /suno-download to fetch the results.
version: 1.6.0
---

# Suno Submit

Batch-submit one or more `prompts.json` files to Suno's Advanced create form, all into a named workspace.

## What this skill does

**Run the script. Do not drive the browser by hand.** `scripts/submit.mjs` performs the entire
batch in one process; your job is to prepare the queue, get the user's go-ahead on the credit
spend, launch it, and report what came back. A 36-prompt batch costs ~4 model turns this way
versus ~110 driving the form yourself.

Path B (the model-driven Claude-in-Chrome loop, in **`references/path-b.md`**) is the **fallback**, not
an equal option. Use it only when one of these is true:

- a prompt sets `audio_reference` (the script refuses those up front — the Browse/Remix modal is not automated)
- the script fails on a UI change and the user needs this batch out **now**
- the user explicitly asks to watch it step by step

---

## Workflow (Path A — default)

### Step 1 · Build the queue and show it

No browser yet — this is free and catches bad input immediately.

```bash
node "<skill>/scripts/queue.mjs" "<path>" list            # add --only <sel> if the user asked for a subset
```

Report: workspace name (the episode folder), model, prompt count, and any `⚠` the script printed
(inconsistent `short_name` is the one that matters — it corrupts every downloaded filename later).

### Step 2 · Confirm the credit spend

**This creates real songs and spends credits.** Suno generates 2 per prompt. State the arithmetic —
"36 prompts → 72 songs" — and wait for a clear yes before Step 4. Do not skip this because the user
already said "submit"; they may not have realised the batch size.

If they want to sanity-check the direction first, offer `--only 01` — one prompt per BGM group, the
standard baseline test.

### Step 3 · Health check

```bash
node "<skill>/scripts/submit.mjs" "<path>" --doctor
```

~15 seconds, opens Chrome, touches nothing, creates nothing. Three outcomes:

- **All checks pass** → go to Step 4.
- **`sign-in required (no TTY)`** → the profile has never been signed in. The Bash tool has no
  interactive stdin, so *you cannot do this step*. Give the user the exact command the script
  printed and ask them to run it in this session with a `! ` prefix:
  `! node "<skill>/scripts/submit.mjs" --login`
  It opens Chrome once, they sign in, and the session persists forever after. Then re-run Step 3.
- **A selector failed** → Suno's UI has drifted. The script wrote `_submit_failure_<ts>.json` +
  `.png`; read the JSON (it contains the full current form shape and what the script expected) and
  repair `submit.mjs` (the selector knowledge it implements is in `references/path-b.md` →
  **UI notes & gotchas**). **Do not fall back to path B silently** — tell the user the script needs
  a fix, offer path B if the batch is urgent, and fix the script either way.

### Step 4 · Run it in the background

A batch takes roughly `prompts × 16s + groups × 30s` — about 15 minutes for 36 prompts, well past
the Bash tool's ceiling. **Always `run_in_background: true`.** You will be notified when it exits.

```bash
node "<skill>/scripts/submit.mjs" "<path>"               # + --only <sel> if used in Step 1
```

Do not poll it. **Ending your turn IS how you wait** — say what you launched, then stop. The
completion notification arrives as a new message and resumes you with full context. Do not invent
an "active wait" (`echo waiting`, a sleep loop, repeated `jobs`/`ls` checks): those spend the very
turns the script exists to save, and they are what the Bash tool's own guidance warns against.

Do not start a second run while one is in flight — both would drive the same profile and Chrome
will refuse the second (the profile is file-locked). `/suno-download` shares that profile.

### Step 5 · Report from the result file

Read `_submit_result.json` next to the prompts — do not re-derive from the log. Report submitted vs
selected, and surface anything with `submitted: false` or `"unconfirmed"`.

Exit `0` means every selected prompt was submitted **and** final verification found exactly 2 clips
per title. Non-zero means read the file and say plainly what did not go out.

If the run stopped mid-batch on an unconfirmed clip count: **do not blindly re-run** — that
double-charges. Check the workspace, then resume with `--only` naming only what is actually missing.

Then point at the next step: `/suno-download "<workspace name>"` once Suno has rendered (1–3 min/song).

### Notes on invocation

- `<skill>` is this skill's own directory — the scripts sit beside this file, so build the path from
  it rather than assuming a repo location.
- **First use on a machine** also needs `npm install && npx playwright install chrome` in the
  repo root. If the script reports playwright missing, run that (foreground, it is quick), then retry.
- Pass the user's path through verbatim, quoted. Episode folders contain spaces and CJK.

---

## Path A reference

### Direct invocation

```bash
cd /path/to/suno-toolkits
npm install && npx playwright install chrome      # once

node skills/suno-submit/scripts/submit.mjs "<episode folder>" --dry-run   # verify first
node skills/suno-submit/scripts/submit.mjs "<episode folder>"             # then submit
```

**Always offer `--dry-run` before the real run on a new episode.** It performs every step — workspace switch, form fill, lyric paste, sliders, full pre-Create verification — and stops short of clicking Create. It costs nothing, creates nothing, and catches a UI drift before it can waste credits.

Options: `--doctor` · `--only 01,BGM02:03` · `--workspace "<name>"` · `--profile "<dir>"` · `--gap-same <sec>` (default 8) · `--gap-group <sec>` (default 30) · `--slowmo <ms>` · `--headless` (don't — see below).

### Handling UI drift — the part that actually matters

A script is more brittle than a model *per change*, but this is the better trade, for a reason worth
stating plainly: **the model-driven path never survived UI drift either.** Every gotcha in this file
was written after path B broke on it. Worse, path B sometimes does not break — it improvises into the
wrong action. The coordinate bug pasted a full lyric into the Styles box, reported success, and
spent a generation on garbage. A script that throws `no "Exclude styles" anchor` is the safer failure.

So the loop is: detect drift for free, then repair with evidence in hand.

```bash
node skills/suno-submit/scripts/submit.mjs "<folder>" --doctor    # ~15s, touches nothing
```

`--doctor` probes every selector the runner depends on and prints a health report — the anchor
index and the three fields it resolves to, the lyrics editor, both sliders, the Create button, the
model selector. When something is missing it prints the **nearest candidates** found on the page, so
the fix is usually a one-line edit rather than an investigation.

**On any failure — `--doctor`, an exception, or the first failed pre-Create verification — the runner
writes a diagnostics pair next to the prompts:**

```
_submit_failure_<timestamp>.json   full current form shape + what the script expected
_submit_failure_<timestamp>.png    screenshot
```

The JSON lists every input with its placeholder and aria-label, every contenteditable, every slider,
every button, plus the script's own expectations. Hand that pair to Claude and ask it to update
`submit.mjs` — **no second browser run is needed to diagnose**, which is what keeps the repair cheap.
Diagnostics are captured once per run, not once per failing prompt.

Escalation ladder when a batch is urgent and the script is broken: run path B (`references/path-b.md`)
for this episode, then fix the script from the diagnostics afterwards. Breakage is never blocking,
only more expensive once.

### Login model

`submit.mjs` opens a **dedicated persistent Chrome profile** — default `%LOCALAPPDATA%\suno-toolkits-profile` (macOS `~/Library/Application Support/…`, Linux `$XDG_DATA_HOME/…`). First run it waits at a prompt while you sign in to Suno in that window; every run after reuses the session like any browser profile.

- **No API key, no exported cookie file, no password** ever reaches the script.
- That directory holds **real credentials** — it lives outside the repo on purpose. Never point `--profile` inside a repo, and never commit one.
- A **dedicated** profile is required, not cosmetic: Chrome ignores `--remote-debugging-port` on the default profile (security, Chrome 111+), and a profile directory is file-locked, so Playwright cannot open one that Chrome already has open. With its own profile the runner coexists with your normal browsing and with Claude in Chrome.

### Why headed, and why real Chrome

`channel: 'chrome'` + `headless: false` is deliberate: it keeps the fingerprint close to ordinary manual use (the older localhost API path was abandoned when anti-bot handling broke it), and headless Chrome is unreliable for both clipboard permissions and the real key events the Lexical lyrics editor needs.

### One genuine improvement over path B

The scripted runner writes lyrics to the **page** clipboard (`navigator.clipboard.writeText` under a granted permission), not the OS clipboard. Nothing the user copies mid-run can clobber a pending paste — a failure that hit path B twice in one episode.

### Output

Writes `_submit_result.json` next to the prompts (workspace, model, per-prompt submitted/failed) and prints a one-line summary. Exit `0` only if every selected prompt was submitted **and** final verification found exactly 2 clips per title. Read that file rather than re-deriving what happened.

### When it stops

On a failed pre-Create verification it **skips that prompt and continues**; on an unconfirmed clip count it **stops the whole run**. Neither ever retries a Create — a blind retry double-charges. If a run stops mid-batch, check the workspace, then resume with `--only` listing what is still missing.

---

## Inputs

- **path** — a `prompts.json` file, OR a folder. A folder is globbed for `**/prompts.json` (sorted by path); each file is one "group" for pacing.
- **workspace** (optional) — overrides the auto-derived name.
- **--only `<selector>`** (optional) — submit only specific prompts instead of the whole batch. Comma-separated. Each selector item matches a queued prompt by, in priority order: exact prompt `id` (`01`), exact `name` (`DreamwaveStarfield`), or case-insensitive substring of the computed `title`. To disambiguate when the same `id` repeats across BGM folders, qualify with `BGM02:03` or `BGM_02:03` (group token + `:` + id). Also accepts conversational intent — "只送 BGM_02 的第三個", "re-run prompt 01" — map it to the same selector logic.
- Default workspace name = the **episode/parent folder name**. For a folder input, that's the input folder's name; for a single-file input, the file's parent (or grandparent if the parent is a `BGM_NN_*` folder).
  - Note: when `--only` re-submits into an *existing* workspace, songs are added alongside what's already there — Suno does not de-duplicate. Tell the user if the target prompt already has clips so they can decide.

## prompts.json schema (read these fields)

Top level: `project`, `short_name`, `creator`, `date`, `prompts[]`.
Per prompt: `id`, `name`, `name_zh`, `style`, `lyrics` (string or null), `negative_tags`, `instrumental` (bool), `model` (shorthand or null), `weirdness` (0-100 or null), `style_influence` (0-100 or null), `vocal_gender` (`"male"`/`"female"`/null), `audio_reference` (string or null), `audio_mode` (`"cover"`/`"inspiration"`/null), `audio_influence` (0-100 or null).

- **null = use Suno default** (model → v5.5; weirdness/style_influence → 50; honor whatever is filled).
- **`model` shorthands** — currently `v6` / `v5.5` / `v5` / `v4.5+` / `v4.5` (v6 verified 2026-09-15). Anything outside `resolveModel`'s known list in `scripts/lib/queue-core.mjs` falls back to v5.5 and the run continues — the warning is easy to miss in a long log, so **when Suno ships a new model, add it to that list first**, then set it here. Check the model line in the script's startup banner before letting a batch proceed.
- **Title** for each song: `{short_name}_{name}`. If the prompts.json sits in a `BGM_NN_*` folder, use `{short_name}_BGM{NN}_{name}` so titles stay traceable. An explicit per-prompt `title` field, if present, overrides this.
- **Audio reference (Cover/Inspiration)**: these may be set **top-level** (apply to every prompt — the common case: "套 audio reference = 全部都套") OR per-prompt. `audio_reference` = the **title of an existing clip in the same workspace** to condition on (e.g. an uploaded acapella/reference). `audio_mode` = `cover` (default) or `inspiration`. `audio_influence` = 0-100 (null → Suno default). If `audio_reference` is set the script refuses the batch — run path B (`references/path-b.md`, Step 4.5 attaches the reference once before the loop). If only some prompts set it, attach/detach per prompt (slower) — prefer one shared reference for the batch.
- **`vocal_gender`**: sets the Advanced "Vocal Gender" Male/Female toggle. null → leave unset (Suno decides from style/lyrics).

---

## Voice (persona) — known limitation, NOT automatable

Suno's **`+ Voice`** ("Voices", Beta) feature — upload/record a voice so generated songs adopt that singer's timbre — **cannot be automated** and should not be attempted as part of a batch:
- Creating a Voice requires a **live microphone verification**: Suno makes you read a phrase aloud and matches it against the uploaded sample to confirm you are a real, present person and that the voice is **yours**. This is a human, real-time action Claude cannot perform, and it is an anti-impersonation gate that must not be bypassed.
- The uploaded sample must be **≥10 seconds** of clean singing; prep it with the silence-trim approach (ffmpeg `silencedetect` → cut the longest continuous sung segment) before handing off.
- Practical guidance: prep the sample, open `+ Voice → Create Voice`, check the consent box, then **hand the mic-verification step to the user**. If the reference voice is someone else's, the gate will (correctly) block it — use style + audio Cover + Vocal Gender instead.

---

## References

- **`references/path-b.md`** — the model-driven Claude-in-Chrome procedure (manual submit loop,
  `ENSURE_WORKSPACE` / `VERIFY_SUBMISSIONS` JS blocks) **and the UI notes & gotchas** that
  `submit.mjs` encodes. Load it to run the fallback, or to repair the script from a
  `_submit_failure_*.json` dump. Fallback only — the script is the default.
- `scripts/submit.mjs` · `scripts/queue.mjs` · `<repo>/lib/session.mjs` (shared Chrome profile,
  login and `api()` — the same one `/suno-download` uses, so one `--login` serves both).
- `/suno-download` — fetches the WAVs once Suno has rendered.
