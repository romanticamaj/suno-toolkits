---
name: suno-submit
description: Batch-submit prompts.json files to Suno. Use when the user wants to submit Suno prompts, send prompts to Suno, batch-generate songs, run a prompts.json, re-submit or regenerate a single prompt, or invokes "/suno-submit". Creates/switches to a named workspace, fills the Advanced create form per prompt (style, lyrics, exclude, title, model, Weirdness/Style Influence, vocal gender), optionally attaches a workspace clip as an audio reference (Cover/Inspiration) with a set Audio Influence applied to every prompt, and clicks Create with paced timing. Prefers the scripted Playwright runner (scripts/submit.mjs) which runs the whole batch in one process; falls back to a model-driven Claude in Chrome loop. Supports an --only selector to submit just specific prompts (by id, name, or BGM group) instead of the whole batch. Pairs with /suno-download to fetch the results.
version: 1.3.0
---

# Suno Submit

Batch-submit one or more `prompts.json` files to Suno's Advanced create form, all into a named workspace.

## Two paths — pick the scripted one by default

| | **A · Scripted** (`scripts/submit.mjs`, Playwright) | **B · Model-driven** (Claude in Chrome) |
|---|---|---|
| Model round-trips | ~4 total | ~3 **per prompt** (≈110 for 36) |
| Relative token cost | 1× | ~15× |
| Needs `claude --chrome` | no | yes |
| Login | its own persistent Chrome profile, one manual sign-in ever | your existing Chrome session |
| Audio reference (Cover/Inspiration) | ✗ not automated | ✓ |
| Recovering from an unexpected UI change | poor — it throws | good — Claude can look and adapt |

**Default to A.** Reach for B when a prompt sets `audio_reference`, when A fails on a UI change and the user needs the batch out now, or when the user explicitly asks to watch it happen step by step.

Both paths drive the same form the same way and share `scripts/lib/queue-core.mjs`, so titles, exclude-tag stripping and `--only` behave identically. **The "UI notes & gotchas" section near the end of this file is the shared source of truth for both** — read it before changing either path.

After Suno finishes generating (minutes later), use **`/suno-download`** to fetch the WAVs.

---

## Path A — the scripted runner

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

Escalation ladder when a batch is urgent and the script is broken: run path B for this episode, then
fix the script from the diagnostics afterwards. Breakage is never blocking, only more expensive once.

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

## Path B — the model-driven loop (Claude in Chrome)

Everything from "Prerequisites" onward describes this path.

## When to use

- User wants to submit/run a `prompts.json` (or a folder of them) on Suno
- Follows a prompt-generation step (e.g. `/storytelling-bgm`, `/suno-prompt`)
- User says "submit these to Suno", "batch generate", "跑 Suno"

After Suno finishes generating (minutes later), use **`/suno-download`** to fetch the WAVs.

## Architecture

- **Workspace create + final verify** → authenticated Suno API via `javascript_tool`.
- **Form filling + Create clicks** → real UI interaction (`form_input`, `computer` clicks/keys) because the create form has no clean submit API and sliders are custom Radix components.

## Prerequisites

- **Claude Code must be started with the `--chrome` flag** (`claude --chrome`). Without it the Claude in Chrome browser tools are not available and this skill cannot run. If the `mcp__claude-in-chrome__*` tools can't be loaded, tell the user to relaunch with `claude --chrome`.
- **Chrome must have the Claude extension installed** (the "Claude in Chrome" extension) — that is what `--chrome` connects to.
- Logged in to **suno.com** in that Chrome, on a paid plan (v5/v5.5 models need it).
- A Suno tab does **not** need to be open beforehand — Step 2 navigates a tab to suno.com itself.
- Generates real songs and **consumes credits** — confirm with the user before the loop if the batch is large.

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
- **Title** for each song: `{short_name}_{name}`. If the prompts.json sits in a `BGM_NN_*` folder, use `{short_name}_BGM{NN}_{name}` so titles stay traceable. An explicit per-prompt `title` field, if present, overrides this.
- **Audio reference (Cover/Inspiration)**: these may be set **top-level** (apply to every prompt — the common case: "套 audio reference = 全部都套") OR per-prompt. `audio_reference` = the **title of an existing clip in the same workspace** to condition on (e.g. an uploaded acapella/reference). `audio_mode` = `cover` (default) or `inspiration`. `audio_influence` = 0-100 (null → Suno default). If `audio_reference` is set, do **Step 4.5** once before the loop. If only some prompts set it, attach/detach per prompt (slower) — prefer one shared reference for the batch.
- **`vocal_gender`**: sets the Advanced "Vocal Gender" Male/Female toggle. null → leave unset (Suno decides from style/lyrics).

---

## Workflow

### Step 1 — Resolve inputs & build the queue

**Use the shipped helper — do not re-derive the queue by hand.** Title construction, the `NO `-strip,
and the UTF-16LE clipboard write are all easy to get subtly wrong (inconsistent `short_name` across
folders is the classic result, and it corrupts every downloaded filename afterwards):

```bash
node "skills/suno-submit/scripts/queue.mjs" "<prompts.json|episode folder>" list            # numbered queue + TOTAL=
node "skills/suno-submit/scripts/queue.mjs" "<path>" list --only 01                         # one prompt per group (baseline)
node "skills/suno-submit/scripts/queue.mjs" "<path>" 7 --clip                               # item 7's fields + lyrics → clipboard
```

`list` warns if `short_name` differs between folders. A single `--clip` call is Step 5's item 0.
Selector tiers: `group:id` → exact `id` **in every group** → exact `name` → unique title substring
(ambiguous substrings stop with the candidates listed).

1. Resolve `path` → list of `prompts.json` files (sorted).
2. Read each. Build an ordered queue of prompt objects, each tagged with its **group** (= source file), a **group token** (the `BGM_NN` from the folder name, or the file's parent folder name), and the computed **title**.
3. **Apply `--only` filter** (if given):
   - Split the selector on commas. For each item, match against the queue: a `group:id` form matches a prompt whose group token contains the group part AND whose `id` equals the id part; otherwise match exact `id`, exact `name`, then case-insensitive `title` substring.
   - If any selector item matches **0** prompts → stop, report it (likely a typo).
   - If any item matches **>1** prompt (ambiguous `id` across BGM folders) → list the candidates and ask the user to qualify with `group:id`. Do not guess.
   - The filtered queue keeps original order; groups with no surviving prompt are dropped.
4. Determine **workspace name** (override → else auto-derived folder name).
5. Pick the **model**: first non-null `model` across the *filtered* prompts, default `v5.5`. Map shorthand → dropdown label:
   `v5.5`→`v5.5`, `v5`→`v5`, `v4.5+`→`v4.5+`, `v4.5`→`v4.5`. Older (`v3`,`v3.5`) aren't in the current dropdown — warn and fall back to `v5.5`.
6. Show the user a summary: workspace name, model, **how many prompts will submit** (and, if `--only` was used, which were selected vs. the full set), per-group count, and any prompt with non-default W/SI. If the batch is large, confirm before proceeding.

### Step 2 — Browser setup

1. `ToolSearch`: `select:mcp__claude-in-chrome__tabs_context_mcp,mcp__claude-in-chrome__navigate,mcp__claude-in-chrome__javascript_tool,mcp__claude-in-chrome__find,mcp__claude-in-chrome__read_page,mcp__claude-in-chrome__form_input,mcp__claude-in-chrome__computer,mcp__claude-in-chrome__browser_batch`. If these tools cannot be loaded, Claude Code was not started with `--chrome` — stop and tell the user to relaunch with `claude --chrome`.
2. `tabs_context_mcp` → get (or create) a tab. **Always `navigate` it to `https://suno.com/create`** — do not assume a Suno tab is already open (it usually is not).

### Step 3 — Set the workspace

1. Run JS block **`ENSURE_WORKSPACE`** with the workspace name — it lists workspaces and creates the project via API if missing. (Creating via API guarantees the name is exact.)
2. In the UI, click the **"Save to..."** selector button (a button showing the current workspace, e.g. "My Workspace" — `find` it with query "Save to workspace selector button").
3. In the dropdown's search box, type the workspace name. Click the matching row.
4. Verify the "Save to..." button now shows the target workspace name. **All Creates while this is set route into that workspace.**

### Step 4 — Advanced mode, model, expand options

1. If the form is **not already on the "Advanced" tab**, click it. (The page often loads on Advanced already — clicking a tab that is already selected is a harmless no-op, but check first.)
2. Click the **model selector** (top-right, shows e.g. "v5.5"). If it already shows the resolved model (a checkmark next to it), just press `Escape`. Otherwise pick the resolved model, then `Escape`.
3. Click **"More Options"** to expand (reveals Exclude styles, Weirdness, Style Influence). If those fields are already visible, it's already expanded — skip.
4. `find` and record the refs you'll reuse every iteration:
   - Styles textbox — query "Style of Music textbox"
   - Lyrics textbox — query "Lyrics textbox"
   - Exclude styles textbox — query "Exclude styles textbox"
   - Song Title textbox — query "Song Title textbox"
   - Create button — query "Create song button"
   Sliders are addressed by JS via their **`aria-label`** — `document.querySelector('[aria-label="Weirdness"]')`, `[aria-label="Style Influence"]`, and (only when audio is attached) `[aria-label="Audio Influence"]` — not refs and **not positional index**. Label addressing is drift-proof: attaching an audio reference adds a third slider, and addressing by label means the order never matters.
5. Track slider state in your head: both start at **50**.

### Step 4.5 — Attach audio reference (only if `audio_reference` is set)

Do this **once** before the loop. The audio condition, its Cover/Inspiration mode, and the Audio Influence value all **persist across Create clicks**, so attach + set once, then loop normally. (Verified: settings survive every Create until you change or remove them.)

1. **Attach the clip.** At the top of the Advanced form there is a row of condition tabs: **`+ Audio`** (label "Add audio - Browse, upload, or record audio"), **`+ Voice`**, **`+ Inspo`**. Click **`+ Audio`** → its menu offers **Browse / Upload / Record** — click **"Browse"**. This opens a picker modal titled **"Choose a song to Remix"** with tabs **Staff Picks / For You / Library**. Click the **Library** tab (your own + workspace clips live here). **Search by a distinctive ASCII substring of the clip title, not the full CJK name** — verified: searching the full `一起吃飯吧_trim` returned 0 results, but searching `trim` found it instantly. Click the matching row's **"Remix"** button (the action button is labeled "Remix", not "Select"). (Alternatively the user may have already attached it — if an **Audio** block with a waveform already shows the right clip, skip attaching.)
   - **"Overwrite Styles?" dialog** — attaching a reference that carries its own style tags pops an Overwrite / Keep Current dialog. Click **Keep Current** to preserve the Styles field. ⚠️ **Even with Keep Current, the attach overwrites the Lyrics field** with the reference clip's structure tags. This is harmless here because Step 5 fills lyrics per prompt *after* Step 4.5 (the first prompt's fill restores correct lyrics) — but **never attach a reference mid-loop without re-asserting lyrics**, and if you only run one prompt, re-fill lyrics after attaching.
2. **Set the mode.** The attached **Audio** block has a dropdown showing **Cover** or **Inspiration** (aka "Inspo"), plus a trash icon. `find` the toggle (query "Change condition type" button) and set it to match `audio_mode` (default **Cover**). The button's accessibility label reads "Change condition type from Cover" when it is *currently* Cover. **Note:** `audio_mode: inspiration` is set via *this* Audio-block dropdown, NOT via the separate top-row **`+ Inspo`** tab (that tab is a different feature — playlist-based inspiration — don't use it for an `audio_reference`).
3. **Set Audio Influence.** Once an audio condition is attached, a **third** slider appears in More Options. Address it as **`[aria-label="Audio Influence"]`** (never by positional index). **Its default on a fresh attach is 25** (not 50) — compute the arrow-key delta from 25, or read its current `aria-valuenow` first. Set it to `audio_influence` using the **same JS-focus + arrow-key** method as SET_SLIDERS (focus `document.querySelector('[aria-label="Audio Influence"]')`, then ArrowRight/Left by the delta). **Fallback if arrows don't take:** this slider also responds to a `computer` `left_click_drag` along its track (~1.5 px per 1%); drag, then read `aria-valuenow` and nudge. Always verify `aria-valuenow` afterward. (Verified: maps to `control_sliders.audio_weight` in the API, e.g. 30 → 0.30.)
4. Verify with JS: `document.querySelector('[aria-label="Audio Influence"]').getAttribute('aria-valuenow')`. Confirm the **Audio** block still shows the right clip and the mode is correct before starting the loop.

> Note: an audio reference can make Suno run long. See "length runaway" in UI notes — keep lyrics' vamp sections (open `La la`/`Oh oh`) short and end with `[End]`.

### Step 5 — Submit loop

Process the queue in order. For each prompt:

0. **Put this prompt's lyrics on the system clipboard** (Bash, before touching the browser) — the Lyrics box is a Lexical contenteditable and clipboard paste is the only fill that works:
   ```bash
   node "skills/suno-submit/scripts/queue.mjs" "<path>" <n> --clip
   ```
   It prints the prompt's `style` / `exclude` / `title` / `w` / `si` for the next step and reports
   `lyricsLines` + `endsWithEnd` so you can eyeball the skeleton before filling. (Internally it writes
   **UTF-16LE** to `clip` — plain UTF-8 mangles CJK.)
1. **Fill Styles / Exclude / Title by JS native setter, then focus the lyrics editor** (one `browser_batch`) — three plain inputs matched by placeholder substring, then a coordinate-free focus:
   ```js
   (() => { const set=(el,v)=>{const p=el.tagName==='TEXTAREA'?HTMLTextAreaElement.prototype:HTMLInputElement.prototype;
     Object.getOwnPropertyDescriptor(p,'value').set.call(el,v); el.dispatchEvent(new Event('input',{bubbles:true})); el.dispatchEvent(new Event('change',{bubbles:true}));};
     const byPh=s=>[...document.querySelectorAll('textarea,input')].find(e=>(e.placeholder||'').includes(s));
     set(byPh('emotive delivery'), `STYLE`); set(byPh('Exclude styles'), `EXCLUDE`); set(byPh('Song Title'), `TITLE`);
     document.querySelector('[aria-label="Lyrics editor"]').focus();
     return document.activeElement.getAttribute('aria-label'); })()
   ```
   The return value must be `"Lyrics editor"`. Placeholders: Styles → the long `emotive delivery, trance influence, …` sample text, Exclude → "Exclude styles", Title → "Song Title".
   **Exclude styles**: strip a leading `NO `/`no ` from each comma item (Suno's exclude field wants bare tags; `NO vocals` → `vocals`). Empty string if null.
2. **Paste the lyrics**: `ctrl+a` then `ctrl+v` (real `computer` key events — they land on the focused Lexical editor), then wait ~1s.
3. **Set sliders** — see **SET_SLIDERS** below. **Skip the calls entirely** if target W and SI both equal current state (`repeat: 0` is an error, not a no-op).
4. **Set vocal gender** (only if `vocal_gender` is given): click the **Male** / **Female** button in the "Vocal Gender" row of More Options. It's a sticky toggle — once set it persists across prompts, so only click when it needs to change. (Re-confirm it after a regenerate if gender matters.)
5. **Verify the whole form before Create** — see the mandatory pre-Create verification in *UI notes & gotchas*. This is what catches a clipboard clobber or a paste into the wrong field. **Never click Create on an unverified form.**
6. **Click Create exactly ONCE.** Then wait. **Never double-click Create** — if it looks like nothing happened, do NOT click again; verify instead. (A double-click submits the prompt twice and wastes credits.)
7. **Confirm the clip count went +2** via the project API (see *Per-Create count verification*), then continue.
8. **Pacing**: wait ~6s before the next prompt in the same group; wait 30s when the next prompt is from a different group. (`computer` `wait` caps at 10s — chain three of them for the 30s gap.)

> **Why not `form_input` for lyrics**: the Lyrics box is **not** an input/textarea, so `form_input` and native value setters silently do nothing. Clipboard + real `ctrl+v` is the only path. Style / Exclude / Title *are* plain inputs — the native setter above is reliable for them and avoids a `find` round-trip per prompt.

#### SET_SLIDERS procedure

Suno's sliders are Radix `[role=slider]` DIVs — `form_input` does NOT work on them. Use focus + real arrow keys (1 keypress = 1%):

1. Target: `W = weirdness ?? 50`, `SI = style_influence ?? 50`.
2. Weirdness — **two separate tool calls**:
   (a) `javascript_tool`: `document.querySelector('[aria-label="Weirdness"]').focus();`
   (b) `computer` action `key`, text `ArrowRight` (if target > current) or `ArrowLeft`, `repeat` = `|target - current|`.
3. Style Influence — same two calls: JS focus `document.querySelector('[aria-label="Style Influence"]')`, then arrow-key delta.
4. Verify with JS: `({w: document.querySelector('[aria-label="Weirdness"]').getAttribute('aria-valuenow'), s: document.querySelector('[aria-label="Style Influence"]').getAttribute('aria-valuenow')})`. If off by 1-2 (occasionally a key is dropped), nudge with single arrow presses.

> Address sliders by `aria-label`, never by positional index — when an audio reference is attached a third slider ("Audio Influence") appears and positional indices would be fragile. Label addressing is order-independent.
5. Update your tracked current state to the verified values.

> Arrow keys only land on a slider that is focused. If you press arrows without the JS `.focus()` first, they go to whatever else has focus (e.g. the Title field) — always focus immediately before.

### Step 6 — Verify

After the loop, run JS block **`VERIFY_SUBMISSIONS`** with the workspace `project_id`. It lists the workspace clips and reports, per title, the `control_sliders`. Cross-check:
- prompt count submitted × 2 ≈ clip count (Suno makes 2 songs per Create)
- non-default W/SI prompts show matching `control_sliders` (defaults show no `control_sliders` key — normal)
Flag any duplicate-titled set that has 4 clips (a double-submit).

### Step 7 — Report

Write `submission_log.md` into the input folder and print a summary:

```
## Suno Submit 完成

Workspace: {name}  ({project_id})
Model: {model}   |  提交 {N} prompts → 預期 {N*2} 首

| Group | Prompt | Title | W | SI |
...

⚠️ {duplicate / timeout / fallback warnings, or 無}

下一步：等 Suno 生成（約 1-3 分鐘/首），然後 /suno-download "{workspace name}"
```

---

## JS Blocks

### `ENSURE_WORKSPACE` — replace `WS_NAME`

```js
(async () => {
  const token = await window.Clerk.session.getToken();
  const H = { accept: '*/*', 'content-type': 'application/json', authorization: `Bearer ${token}`,
    'browser-token': JSON.stringify({ token: btoa(JSON.stringify({ timestamp: Date.now() })) }),
    'device-id': '00000000-0000-4000-8000-000000000001', origin: 'https://suno.com', referer: 'https://suno.com/' };
  const API = 'https://studio-api-prod.suno.com';
  const name = `WS_NAME`;
  // list (1-indexed pages, de-dup)
  const seen = new Set(); const all = [];
  for (let page = 1; page <= 20; page++) {
    const r = await fetch(`${API}/api/project/me?page=${page}&sort=created_at&show_trashed=false`, { headers: H });
    if (!r.ok) break;
    const j = await r.json(); const projs = j.projects || [];
    let added = 0;
    for (const p of projs) { if (!seen.has(p.id)) { seen.add(p.id); all.push(p); added++; } }
    if (projs.length === 0 || added === 0 || all.length >= (j.num_total_results || 0)) break;
  }
  let ws = all.find(p => p.name === name);
  if (ws) return { existed: true, id: ws.id, name: ws.name };
  // create
  const cr = await fetch(`${API}/api/project`, { method: 'POST', headers: H,
    body: JSON.stringify({ name, description: '', spec: { description: '' } }) });
  if (!cr.ok) return { error: `create failed ${cr.status}`, body: (await cr.text()).slice(0, 200) };
  const created = await cr.json();
  return { existed: false, id: created.id, name: created.name };
})()
```

### `VERIFY_SUBMISSIONS` — replace `PROJECT_ID`

```js
(async () => {
  const token = await window.Clerk.session.getToken();
  const H = { accept: '*/*', authorization: `Bearer ${token}`,
    'browser-token': JSON.stringify({ token: btoa(JSON.stringify({ timestamp: Date.now() })) }),
    'device-id': '00000000-0000-4000-8000-000000000001', origin: 'https://suno.com', referer: 'https://suno.com/' };
  const pid = 'PROJECT_ID';
  const seen = new Set(); const clips = [];
  for (let page = 1; page <= 30; page++) {
    const r = await fetch(`https://studio-api-prod.suno.com/api/project/${pid}?page=${page}`, { headers: H });
    if (!r.ok) break;
    const j = await r.json();
    const items = (j.project_clips || []).map(pc => pc.clip).filter(Boolean);
    let added = 0;
    for (const c of items) { if (!seen.has(c.id)) { seen.add(c.id); clips.push(c); added++; } }
    if (items.length === 0 || added === 0 || clips.length >= (j.clip_count || 0)) break;
  }
  const byTitle = {};
  for (const c of clips) {
    const t = c.title || '(untitled)';
    byTitle[t] = byTitle[t] || { count: 0, cs: null };
    byTitle[t].count++;
    const cs = c.metadata?.control_sliders;
    if (cs) byTitle[t].cs = { W: Math.round((cs.weirdness_constraint ?? 0.5) * 100), SI: Math.round((cs.style_weight ?? 0.5) * 100) };
  }
  return { total_clips: clips.length, titles: byTitle };
})()
```

---

## UI notes & gotchas

> Shared by both paths. `scripts/submit.mjs` encodes every item below; if you change one, change it in both places.

- **Never locate a form field by its placeholder text alone.** The Styles box ships a **randomised** sample placeholder — observed as `emotive delivery, trance influence, …`, `calm atmosphere, adventurous, dynamic drops, melodic metal, retro 80s`, and others — so matching on any one of them breaks at random. The page also renders **two** `Song Title (Optional)` inputs. The only stable handle is DOM order around the one placeholder that never changes: find the index `xi` of the input whose placeholder contains `Exclude styles`, then **`els[xi-1]` = Styles, `els[xi]` = Exclude, `els[xi+1]` = Song Title** over `[...document.querySelectorAll('textarea,input')]`. (Verified again on the EP26 batch, where `xi` was 4 — the absolute index also drifts between renders, so recompute it every prompt.)
- **The workspace can be selected by URL.** Picking one in the "Save to…" dropdown rewrites the URL to `/create?wid=<project_id>`, and loading that URL directly preselects it — much more robust than driving the dropdown, and it survives a page reload. Read the "Save to" button back afterwards as an early warning, but treat a *null* read as a warning only: the label and its button are not reliable siblings and the markup is easy to restyle. The real guard against filing a batch into the wrong workspace is the per-Create clip-count check against that specific `project_id` — if routing ever broke, the count would not rise and the run stops after the **first** prompt, costing one generation rather than the whole batch.
- **Lyrics is a Lexical contenteditable, NOT a textarea** (`[aria-label="Lyrics editor"]`). React native-value setters do nothing, synthetic `ClipboardEvent('paste')` is ignored (untrusted), and `execCommand('insertText')` EATS ALL NEWLINES (every section tag collapses onto one line). The ONLY reliable fill (verified EP22, 56 prompts; EP23, 33 prompts): write the lyrics to the **system clipboard** (`node -e "process.stdout.write(...)" | clip`), then focus the editor → `ctrl+a` → `ctrl+v`. Verify with `el.querySelectorAll('p').length`. Bonus: lyrics never transit the model context. (Style/Exclude/Title are still plain inputs — native setter works for those.) **Path A uses the *page* clipboard instead** (`navigator.clipboard.writeText` under a granted permission) — same real `ctrl+v`, but immune to the OS-clipboard clobber below.
- **Focus the lyrics editor with JS, NEVER by clicking a coordinate.** Use:
  ```js
  document.querySelector('[aria-label="Lyrics editor"]').focus()
  ```
  then send `ctrl+a` / `ctrl+v`. Keyboard events go to the focused element, so this is immune to layout shift. **After the first Create the left create-panel scrolls down** — the Styles box slides up into where the lyrics box used to be, so a coordinate that was correct for prompt 1 pastes the entire lyric into **Styles** on prompt 2 (hit exactly this in EP23; the lyrics field still held the previous prompt's text). Coordinates are only safe before the first Create, and there is no reason to use them at all.
- **The clipboard is a shared resource — verify before every Create.** While a batch is running, anything the user copies (a chat message, a URL) silently replaces the lyrics you are about to paste. This happened **twice** in EP23. The verification step below is the only defence, and it works: both incidents were caught before Create, so nothing was mis-submitted and no credits were wasted.
- **Mandatory pre-Create verification.** After filling, read back in one JS call and check all of it before clicking Create:
  ```js
  (()=>{const byPh=s=>[...document.querySelectorAll('textarea,input')].find(e=>(e.placeholder||'').includes(s));
    const e=document.querySelector('[aria-label="Lyrics editor"]');
    return {paras:e.querySelectorAll('p').length, head:e.innerText.slice(0,50), end:e.innerText.trim().endsWith('[End]'),
      styleHead:byPh('emotive delivery').value.slice(0,50), title:byPh('Song Title').value,
      w:document.querySelector('[aria-label="Weirdness"]').getAttribute('aria-valuenow'),
      si:document.querySelector('[aria-label="Style Influence"]').getAttribute('aria-valuenow')};})()
  ```
  Assert: paragraph count matches the prompt's lyric lines, `end` is true, `head` starts with `[`, `styleHead` is the style (**not** a `[`-prefixed lyric — that means the paste went into the wrong field), title/W/SI match. Anything off → re-copy, re-paste, re-verify. **Do not click Create on an unverified form.**
- **`computer` `key` rejects `repeat: 0`.** When a prompt's W/SI equal the previous prompt's, skip the slider calls entirely — passing `repeat: 0` errors out and aborts the rest of the batch.
- **Slider race after filling Styles**: the style `input` event re-renders the form and steals focus, so a `.focus()` fired in the same batch may land on a dead node and the arrow keys go nowhere (EP22: W stayed at 35 instead of 25). **Wait ~1s after filling text fields before focusing a slider**, and ALWAYS read back `aria-valuenow` before clicking Create — nudge if off.
- **Per-Create count verification**: after every Create, read the workspace's "N songs" counter from the page (`[...document.querySelectorAll('*')].filter(e=>/songs$/.test(e.textContent)&&!e.children.length).pop()`) and assert it went **+2**. Catching a missed submit immediately beats reconciling 40 prompts afterwards. Don't scan clip titles from the DOM instead — the list is virtualised, only visible rows exist.
- **If token-reading JS returns `{}`**: prefix the whole IIFE with `await` (unawaited-promise serialisation regression), and remember JS **side effects still ran** — check UI state before re-running anything that creates/submits, or you'll double-pay. Workspace creation via ENSURE_WORKSPACE has silently succeeded this way (EP22).

- **Refs are session-specific.** `find` the form refs once after Step 4; reuse them through the loop. If a `form_input` errors, re-`find`.
- **Re-discover after navigation.** Any `navigate` invalidates all refs.
- **Create exactly once per prompt.** The #1 failure mode is double-clicking Create (→ 4 songs for one prompt, wasted credits). Click once, wait, verify by screenshot — never re-click.
- **Lyrics field & instrumental**: Advanced mode auto-sets instrumental from the Lyrics field — blank lyrics → instrumental. Structural-only tags (`[Intro]`, `[Build Section]`) also render instrumental in practice. If `instrumental: true` and an explicit "Instrumental" toggle is visible, turn it on; otherwise the negative_tags + structural tags suffice. Note: the result's true instrumental-ness can't be verified until the song renders — `VERIFY_SUBMISSIONS` only confirms it queued. If a paid plan and an Instrumental toggle exists, prefer using it.
- **Stale tag-chips** below the Styles box (small pills like `ethereal pan flute` from a prior session) are cosmetic and derived — `form_input` correctly replaces the textarea value, which is what's authoritative. Ignore leftover chips; don't try to clear them.
- **Exclude field** wants bare tags. Strip leading `NO ` from items: `NO vocals, NO drums` → `vocals, drums`.
- **Sliders**: focus via JS immediately before arrow keys; verify `aria-valuenow`; 1 keypress = 1%.
- **Model dropdown** currently offers v5.5 / v5 / v4.5+ / v4.5. Set once in Step 4.
- **Workspace routing** is sticky — set "Save to..." once; every Create goes there until changed.
- **Audio reference (Cover) is sticky too** — once attached with a mode + Audio Influence, it stays through every Create until you remove it (trash icon) or change it. Attach once in Step 4.5, then loop. The **Audio Influence** slider only exists while an audio condition is attached, and it adds a third `[role=slider]` to the form — so **always address sliders by `aria-label`** (`Weirdness` / `Style Influence` / `Audio Influence`), never by positional index, since attaching audio changes the slider count.
- **Slider input**: the JS-focus + arrow-key method (SET_SLIDERS) is the primary way for all sliders. If a slider ignores arrow keys, it was not focused — JS `.focus()` it first. As a last resort, `computer` `left_click_drag` along the track works (~1.5 px/1%); always verify `aria-valuenow` after.
- **Length runaway (8-min tracks)**: a verbose style prompt (~85+ words) and/or an attached audio reference can make Suno generate runaway ~8-minute tracks even from short lyrics. The dominant cause is **open-ended vocalise in the lyrics** (long `[Bridge]` `Oh oh…` / `La la…`, `[Outro]` `Ha ah…`). Fix at the lyrics level: keep vamp sections short and add a final **`[End]`** tag. A concise (~50-65 word) style also helps. This reliably pulls length back toward the reference. (Length can't be verified until render — flag the risk; `/suno-download` shows the final durations.)
- **Vocal Gender** Male/Female is a sticky toggle in More Options; set once, persists. Useful to lock a gender the style alone doesn't guarantee.
- Both API hosts (`studio-api-prod.suno.com` dash / `studio-api.prod.suno.com` dot) are aliases.

## Voice (persona) — known limitation, NOT automatable

Suno's **`+ Voice`** ("Voices", Beta) feature — upload/record a voice so generated songs adopt that singer's timbre — **cannot be automated** and should not be attempted as part of a batch:
- Creating a Voice requires a **live microphone verification**: Suno makes you read a phrase aloud and matches it against the uploaded sample to confirm you are a real, present person and that the voice is **yours**. This is a human, real-time action Claude cannot perform, and it is an anti-impersonation gate that must not be bypassed.
- The uploaded sample must be **≥10 seconds** of clean singing; prep it with the silence-trim approach (ffmpeg `silencedetect` → cut the longest continuous sung segment) before handing off.
- Practical guidance: prep the sample, open `+ Voice → Create Voice`, check the consent box, then **hand the mic-verification step to the user**. If the reference voice is someone else's, the gate will (correctly) block it — use style + audio Cover + Vocal Gender instead.
