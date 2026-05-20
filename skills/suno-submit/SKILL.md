---
name: suno-submit
description: Batch-submit prompts.json files to Suno via Claude in Chrome. Use when the user wants to submit Suno prompts, send prompts to Suno, batch-generate songs, run a prompts.json, re-submit or regenerate a single prompt, or invokes "/suno-submit". Creates/switches to a named workspace, fills the Advanced create form per prompt (style, lyrics, exclude, title, model, Weirdness/Style Influence), and clicks Create with paced timing. Supports an --only selector to submit just specific prompts (by id, name, or BGM group) instead of the whole batch. Pairs with /suno-download to fetch the results.
version: 1.0.0
---

# Suno Submit

Batch-submit one or more `prompts.json` files to Suno's Advanced create form, all into a named workspace, via the Claude in Chrome browser tools.

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
Per prompt: `id`, `name`, `name_zh`, `style`, `lyrics` (string or null), `negative_tags`, `instrumental` (bool), `model` (shorthand or null), `weirdness` (0-100 or null), `style_influence` (0-100 or null).

- **null = use Suno default** (model → v5.5; weirdness/style_influence → 50; honor whatever is filled).
- **Title** for each song: `{short_name}_{name}`. If the prompts.json sits in a `BGM_NN_*` folder, use `{short_name}_BGM{NN}_{name}` so titles stay traceable. An explicit per-prompt `title` field, if present, overrides this.

---

## Workflow

### Step 1 — Resolve inputs & build the queue

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
   Sliders are addressed by JS (`document.querySelectorAll('[role=slider]')[0]`=Weirdness, `[1]`=Style Influence), not refs.
5. Track slider state in your head: both start at **50**.

### Step 5 — Submit loop

Process the queue in order. For each prompt:

1. **Fill fields** via `form_input` (one `browser_batch`):
   - Styles ← `style`
   - Lyrics ← `lyrics` (empty string `""` if null)
   - Exclude styles ← `negative_tags` — **strip a leading `NO `/`no ` from each comma item** (Suno's exclude field wants bare tags; `NO vocals` becomes `vocals`). Empty string if null.
   - Song Title ← computed title
2. **Set sliders** — see procedure **SET_SLIDERS** below. Skip entirely if target W and SI both equal current state.
3. **Click Create exactly ONCE.** Then wait. **Never double-click Create** — if it looks like nothing happened, do NOT click again; verify with a screenshot instead. (A double-click submits the prompt twice and wastes credits.)
4. **Pacing**: wait 5s before the next prompt in the same group; wait 30s when the next prompt is from a different group. (Overridable, but this is the tested-safe default.)

#### SET_SLIDERS procedure

Suno's sliders are Radix `[role=slider]` DIVs — `form_input` does NOT work on them. Use focus + real arrow keys (1 keypress = 1%):

1. Target: `W = weirdness ?? 50`, `SI = style_influence ?? 50`.
2. Weirdness — **two separate tool calls**:
   (a) `javascript_tool`: `document.querySelectorAll('[role="slider"]')[0].focus();`
   (b) `computer` action `key`, text `ArrowRight` (if target > current) or `ArrowLeft`, `repeat` = `|target - current|`.
3. Style Influence — same two calls: JS focus `[role="slider"][1]`, then arrow-key delta.
4. Verify with JS: `({w: document.querySelectorAll('[role="slider"]')[0].getAttribute('aria-valuenow'), s: document.querySelectorAll('[role="slider"]')[1].getAttribute('aria-valuenow')})`. If off by 1-2 (occasionally a key is dropped), nudge with single arrow presses.
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

- **Refs are session-specific.** `find` the form refs once after Step 4; reuse them through the loop. If a `form_input` errors, re-`find`.
- **Re-discover after navigation.** Any `navigate` invalidates all refs.
- **Create exactly once per prompt.** The #1 failure mode is double-clicking Create (→ 4 songs for one prompt, wasted credits). Click once, wait, verify by screenshot — never re-click.
- **Lyrics field & instrumental**: Advanced mode auto-sets instrumental from the Lyrics field — blank lyrics → instrumental. Structural-only tags (`[Intro]`, `[Build Section]`) also render instrumental in practice. If `instrumental: true` and an explicit "Instrumental" toggle is visible, turn it on; otherwise the negative_tags + structural tags suffice. Note: the result's true instrumental-ness can't be verified until the song renders — `VERIFY_SUBMISSIONS` only confirms it queued. If a paid plan and an Instrumental toggle exists, prefer using it.
- **Stale tag-chips** below the Styles box (small pills like `ethereal pan flute` from a prior session) are cosmetic and derived — `form_input` correctly replaces the textarea value, which is what's authoritative. Ignore leftover chips; don't try to clear them.
- **Exclude field** wants bare tags. Strip leading `NO ` from items: `NO vocals, NO drums` → `vocals, drums`.
- **Sliders**: focus via JS immediately before arrow keys; verify `aria-valuenow`; 1 keypress = 1%.
- **Model dropdown** currently offers v5.5 / v5 / v4.5+ / v4.5. Set once in Step 4.
- **Workspace routing** is sticky — set "Save to..." once; every Create goes there until changed.
- Both API hosts (`studio-api-prod.suno.com` dash / `studio-api.prod.suno.com` dot) are aliases.
