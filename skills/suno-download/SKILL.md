---
name: suno-download
description: Download all WAV files plus complete metadata sidecar JSON from a Suno workspace. Use when the user wants to download Suno songs, export a workspace, fetch WAV files, grab generated tracks, or invokes "/suno-download". Triggers Suno's convert_wav flow, polls until ready, downloads lossless WAV from CDN in parallel, and writes a full-metadata sidecar JSON next to each file.
version: 1.1.0
---

# Suno Download

Download every song (or a selected subset) from a Suno workspace as **lossless WAV** (48kHz/16-bit/stereo PCM) plus a **complete metadata sidecar JSON** for each track.

## When to use

- User wants to download/export songs from a Suno workspace
- User says "download the WAVs", "export workspace X", "抓 Suno 的歌"
- Follows a `/suno-submit` run once Suno finishes generating

## How it works (architecture)

Suno only serves MP3 by default. WAV is an **on-demand server-side conversion**:

```
POST /api/gen/{clipId}/convert_wav/    → triggers conversion (returns 204)
GET  /api/gen/{clipId}/wav_file/       → 404 = not ready; 200 = {wav_file_url}
GET  {wav_file_url}                    → public CDN, no auth, the WAV bytes
```

**Split of work** (important — WAV files are 10-50MB each, far too large for context, and the Claude-in-Chrome tool channel is security-filtered + size-limited):
- **Browser JS** (`javascript_tool`) — runs the *authenticated* API calls only (list, convert, poll, fetch metadata). Returns small plain-text JSON.
- **Bash `curl`** — downloads the WAV bytes from the public CDN **in parallel**, straight to disk. Bulk binary never touches the tool channel.
- **Sidecar JSON** comes out of the browser as **plain JSON text in small chunks** — never base64/gzip (the output filter blocks those).

**Speed rule:** minimise model↔browser round-trips. Fire conversions in parallel, poll in parallel, download WAVs in parallel. Never sequential-with-sleeps.

## Prerequisites

- **Claude Code must be started with the `--chrome` flag** (`claude --chrome`). Without it the Claude in Chrome browser tools are not available and this skill cannot run. If the `mcp__claude-in-chrome__*` tools can't be loaded, tell the user to relaunch with `claude --chrome`.
- **Chrome must have the Claude extension installed** (the "Claude in Chrome" extension) — that is what `--chrome` connects to.
- Logged in to **suno.com** in that Chrome, on a paid plan (WAV export needs Pro/Premier).
- A Suno tab does **not** need to be open beforehand — Step 1 navigates a tab to suno.com itself.

## Inputs

- **workspace** — workspace (project) name, e.g. `20260516 奧特曼光之國的誕生`. Partial match is OK; if ambiguous, list candidates and ask.
- **output dir** — where to save. Default: ask the user, or use the matching project folder if obvious.
- **selection** (optional) — `all` (default) or an interactive subset pick.

---

## Workflow

### Step 1 — Set up the browser tab

1. Load Claude in Chrome tools via `ToolSearch`: `select:mcp__claude-in-chrome__tabs_context_mcp,mcp__claude-in-chrome__navigate,mcp__claude-in-chrome__javascript_tool`. If these tools cannot be loaded, Claude Code was not started with `--chrome` — stop and tell the user to relaunch with `claude --chrome`.
2. Call `tabs_context_mcp` to get (or create) a tab. **Always `navigate` that tab to `https://suno.com/create`** — do not assume a Suno tab is already open (it usually is not). The tab must be on a `suno.com` origin or `window.Clerk` (the auth token source) won't exist.
3. All `javascript_tool` calls below run in that tab.

### Step 2 — Resolve the workspace

Run JS block **`LIST_WORKSPACES`**. Match the user's workspace name (case-insensitive substring). If 0 matches → report and stop. If >1 → list and ask. Keep the `project_id`.

### Step 3 — List clips in the workspace

Run JS block **`LIST_CLIPS`** with the `project_id`. It paginates `/api/project/{id}?page=N` and returns every clip with `id, title, batch_index, duration, created_at`.

### Step 4 — Confirm selection

Show a table: `# | title | duration | variant`. Group the 2 variants of each prompt (`batch_index` 0 → `_a`, 1 → `_b`). Unless the user said "all", ask which to download.

### Step 5 — Convert + get WAV URLs (browser JS)

Run JS block **`CONVERT_AND_POLL`** with **all** selected clip IDs at once — no chunk limit, the return is tiny (`{id, wav_url}` pairs only). It fires every `convert_wav` in parallel, then polls all `wav_file/` endpoints in parallel rounds until ready (3-minute ceiling).

- **First run** waits for Suno's server-side conversion (can be a few minutes for a fresh workspace). **Reruns are instant** — already converted.
- Returns `[{ id, wav_url }]`. If any `wav_url` is `null`, re-run with just those IDs.

### Step 6 — Download WAVs in parallel (Bash)

**Do not download sequentially with sleeps** — that is the #1 cause of slow runs. Download concurrently:

1. Compute each clip's final filename: `{workspace} - {title}_{variant}`
   - `title` / `batch_index` come from the Step 3 clip list. Variant: `batch_index` 0→`a`, 1→`b`; if null, sort the two same-title clips by `created_at` then `id`.
   - Sanitize: replace `/ \ : * ? " < > |` with `_`.
   - **MAX_PATH guard**: `{workspace}` and `{title}` are long and often share a prefix. If the full path would exceed ~240 chars (Windows limit 260), drop the `{workspace} - ` prefix (the sidecar JSON still records the workspace) and tell the user.
2. Write `_wav_urls.txt` into the output dir — one `wav_url` per line.
3. **Parallel download**, 8-way. `curl -O` saves each file under its URL basename (`{clipId}.wav` — UUID, no spaces, safe):
   ```bash
   cd "{outdir}" && xargs -P 8 -n 1 curl -sL -O < _wav_urls.txt
   ```
4. **Rename** each `{clipId}.wav` → its final `{workspace} - {title}_{variant}.wav`.
5. **Verify** each final file: exists, size > 100KB, first 4 bytes are `RIFF`.
6. Delete `_wav_urls.txt`.

### Step 7 — Fetch + write sidecar JSON

Run JS block **`FETCH_SIDECARS`** in **chunks of 8 clip IDs** (8 × ~5KB ≈ 40KB — stays under the tool output limit). It returns plain pretty-printed JSON strings.

> ⚠️ **Never** ask the JS to base64-encode, gzip, or "compress" the sidecars, and never spin up a localhost server to ferry them. The Claude-in-Chrome output filter blocks base64/binary-looking payloads — that path is a dead end and wastes 15+ minutes. Plain JSON text in small chunks passes fine and is fast.

For each returned `{id, title, batch_index, sidecar_json}`: **Write** `{final filename}.json` (same base name as the WAV) with the `sidecar_json` string **verbatim** — it is already valid pretty-printed JSON.

If a chunk's return looks truncated, halve the chunk size and retry just that chunk.

### Step 8 — Report

```
## Suno Download 完成

📁 {output dir}
Workspace: {name} ({project_id})

| # | File | WAV size | dur |
|---|------|----------|-----|
...

共 N 首 WAV + N 個 sidecar JSON
失敗：{list, or 無}
```

---

## JS Blocks

All blocks assume a Suno tab. Each is a self-contained IIFE for `javascript_tool`.

### Shared header helper (prepended inside every block)

```js
const token = await window.Clerk.session.getToken();
const H = {
  accept: '*/*',
  'content-type': 'application/json',
  authorization: `Bearer ${token}`,
  'browser-token': JSON.stringify({ token: btoa(JSON.stringify({ timestamp: Date.now() })) }),
  'device-id': '00000000-0000-4000-8000-000000000001',
  origin: 'https://suno.com',
  referer: 'https://suno.com/',
};
const API = 'https://studio-api-prod.suno.com';  // dash host; studio-api.prod.suno.com (dot) is an alias
```

### `LIST_WORKSPACES`

> Note: `/api/project/me` pages are **1-indexed**; `page=0` returns the same data as `page=1`. The loop below starts at 1 and de-dups by `id` so a paging quirk can never inflate the result (a false ">1 match").

```js
(async () => {
  const token = await window.Clerk.session.getToken();
  const H = { accept: '*/*', authorization: `Bearer ${token}`,
    'browser-token': JSON.stringify({ token: btoa(JSON.stringify({ timestamp: Date.now() })) }),
    'device-id': '00000000-0000-4000-8000-000000000001', origin: 'https://suno.com', referer: 'https://suno.com/' };
  const seen = new Set();
  const out = [];
  for (let page = 1; page <= 20; page++) {
    const r = await fetch(`https://studio-api-prod.suno.com/api/project/me?page=${page}&sort=created_at&show_trashed=false`, { headers: H });
    if (!r.ok) break;
    const j = await r.json();
    const projs = j.projects || [];
    let added = 0;
    for (const p of projs) { if (!seen.has(p.id)) { seen.add(p.id); out.push(p); added++; } }
    if (projs.length === 0 || added === 0) break;
    if (out.length >= (j.num_total_results || 0)) break;
  }
  return out.map(p => ({ id: p.id, name: p.name, clip_count: p.clip_count, created_at: p.created_at }));
})()
```

### `LIST_CLIPS`  — replace `PROJECT_ID`

```js
(async () => {
  const token = await window.Clerk.session.getToken();
  const H = { accept: '*/*', authorization: `Bearer ${token}`,
    'browser-token': JSON.stringify({ token: btoa(JSON.stringify({ timestamp: Date.now() })) }),
    'device-id': '00000000-0000-4000-8000-000000000001', origin: 'https://suno.com', referer: 'https://suno.com/' };
  const pid = 'PROJECT_ID';
  const seen = new Set();
  const clips = [];
  for (let page = 1; page <= 30; page++) {
    const r = await fetch(`https://studio-api-prod.suno.com/api/project/${pid}?page=${page}`, { headers: H });
    if (!r.ok) break;
    const j = await r.json();
    const items = (j.project_clips || []).map(pc => pc.clip).filter(Boolean);
    let added = 0;
    for (const c of items) { if (!seen.has(c.id)) { seen.add(c.id); clips.push(c); added++; } }
    if (items.length === 0 || added === 0 || clips.length >= (j.clip_count || 0)) break;
  }
  return clips.map(c => ({
    id: c.id, title: c.title, batch_index: c.metadata?.batch_index ?? c.batch_index ?? null,
    duration: Math.round(c.metadata?.duration || 0), created_at: c.created_at,
  }));
})()
```

### `CONVERT_AND_POLL`  — replace `CLIP_IDS_JSON` with a JS array literal e.g. `["id1","id2"]`

> Pass **all** selected clip IDs in one call. Conversions fire in parallel, polling runs in parallel rounds. The return is just `{id, wav_url}` pairs (tiny — no size concern).

```js
(async () => {
  const token = await window.Clerk.session.getToken();
  const H = { accept: '*/*', authorization: `Bearer ${token}`,
    'browser-token': JSON.stringify({ token: btoa(JSON.stringify({ timestamp: Date.now() })) }),
    'device-id': '00000000-0000-4000-8000-000000000001', origin: 'https://suno.com', referer: 'https://suno.com/' };
  const API = 'https://studio-api-prod.suno.com';
  const ids = CLIP_IDS_JSON;
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  // fire ALL conversions in parallel
  await Promise.allSettled(ids.map(id =>
    fetch(`${API}/api/gen/${id}/convert_wav/`, { method: 'POST', headers: H })));
  // poll ALL pending in parallel rounds
  const wav = {};
  const deadline = Date.now() + 180000;
  while (Object.keys(wav).length < ids.length && Date.now() < deadline) {
    const pending = ids.filter(id => !wav[id]);
    const res = await Promise.allSettled(pending.map(async id => {
      const r = await fetch(`${API}/api/gen/${id}/wav_file/`, { headers: H });
      if (r.ok) { const d = await r.json(); if (d.wav_file_url) return [id, d.wav_file_url]; }
      return null;
    }));
    for (const x of res) if (x.status === 'fulfilled' && x.value) wav[x.value[0]] = x.value[1];
    if (Object.keys(wav).length < ids.length) await sleep(3000);
  }
  return ids.map(id => ({ id, wav_url: wav[id] || null }));
})()
```

### `FETCH_SIDECARS`  — replace `CLIP_IDS_JSON` with a **chunk of ≤8** clip IDs

> Call once per chunk of 8. Returns plain pretty-printed JSON strings — depth-1 array of flat objects, so no truncation from the depth limiter; ~40KB/chunk stays under the output size limit. Do NOT base64-encode or compress the result.

```js
(async () => {
  const token = await window.Clerk.session.getToken();
  const H = { accept: '*/*', authorization: `Bearer ${token}`,
    'browser-token': JSON.stringify({ token: btoa(JSON.stringify({ timestamp: Date.now() })) }),
    'device-id': '00000000-0000-4000-8000-000000000001', origin: 'https://suno.com', referer: 'https://suno.com/' };
  const API = 'https://studio-api-prod.suno.com';
  const ids = CLIP_IDS_JSON;
  const r = await fetch(`${API}/api/feed/?ids=${ids.join(',')}`, { headers: H });
  const j = r.ok ? await r.json() : [];
  const arr = Array.isArray(j) ? j : (j.clips || []);
  const meta = {}; arr.forEach(c => { meta[c.id] = c; });
  return ids.map(id => {
    const c = meta[id] || {};
    return {
      id,
      title: c.title || null,
      batch_index: c.metadata?.batch_index ?? c.batch_index ?? null,
      sidecar_json: JSON.stringify(c, null, 2),  // plain JSON string — write to .json verbatim
    };
  });
})()
```

---

## Notes & gotchas

- **WAV needs a paid plan.** If `convert_wav` returns 401/403, the account lacks WAV access — report it.
- **`wav_url` is a public CDN link** (`cdn1.suno.ai/{id}.wav`). `curl` it directly; no headers needed.
- **Re-running is cheap** — once converted, `wav_file/` returns the URL instantly.
- **Variant suffix**: `batch_index` 0 → `_a`, 1 → `_b`. If null, sort the two same-title clips by `created_at` then `id`.
- **Both API hosts work**: `studio-api-prod.suno.com` (dash) and `studio-api.prod.suno.com` (dot) are aliases.
- **Sidecar JSON** is the full clip object — `tags` (style), `negative_tags` (excludes), `prompt` (lyrics), `make_instrumental`, `model_name`, `duration`, `media_urls`, `project`, timestamps.
- **`metadata.control_sliders`** (`style_weight`, `weirdness_constraint`, 0-1 floats) is **only present when the user adjusted those sliders** away from 50%. A clip generated with default sliders has **no `control_sliders` key at all** — that is normal, not an error. Treat its absence as "defaults (0.5 / 0.5)".
- This skill is **read-only on Suno** (convert_wav only triggers a render of an existing clip — no new generations, no extra credits beyond the WAV entitlement).
