---
name: suno-download
description: Download all WAV files plus complete metadata sidecar JSON from a Suno workspace. Use when the user wants to download Suno songs, export a workspace, fetch WAV files, grab generated tracks, or invokes "/suno-download". Triggers Suno's convert_wav flow, polls until ready, downloads lossless WAV from CDN, and writes a full-metadata sidecar JSON next to each file.
version: 1.0.0
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

**Split of work** (important — WAV files are 10-50MB each, too large for context):
- **Browser JS** (`javascript_tool`) — runs all *authenticated* API calls (list, convert, poll). Returns only small JSON (URLs + metadata).
- **Bash `curl`** — downloads the actual WAV bytes from the public CDN URL straight to disk.

## Prerequisites

- Chrome connected via Claude in Chrome, logged in to suno.com (Pro/Premier — WAV needs paid plan)
- A Suno tab open on `https://suno.com` (needed so `window.Clerk` exists for the auth token)

## Inputs

- **workspace** — workspace (project) name, e.g. `20260516 奧特曼光之國的誕生`. Partial match is OK; if ambiguous, list candidates and ask.
- **output dir** — where to save. Default: ask the user, or use the matching project folder if obvious.
- **selection** (optional) — `all` (default) or an interactive subset pick.

---

## Workflow

### Step 1 — Set up the browser tab

1. Load Claude in Chrome tools via `ToolSearch`: `select:mcp__claude-in-chrome__tabs_context_mcp,mcp__claude-in-chrome__navigate,mcp__claude-in-chrome__javascript_tool`
2. Call `tabs_context_mcp` to get a tab. If no Suno tab, `navigate` one to `https://suno.com/create`.
3. All `javascript_tool` calls below run in that tab.

### Step 2 — Resolve the workspace

Run JS block **`LIST_WORKSPACES`**. Match the user's workspace name (case-insensitive substring). If 0 matches → report and stop. If >1 → list and ask. Keep the `project_id`.

### Step 3 — List clips in the workspace

Run JS block **`LIST_CLIPS`** with the `project_id`. It paginates `/api/project/{id}?page=N` and returns every clip with `id, title, batch_index, duration, created_at`.

### Step 4 — Confirm selection

Show a table: `# | title | duration | variant`. Group the 2 variants of each prompt (`batch_index` 0 → `_a`, 1 → `_b`). Unless the user said "all", ask which to download.

### Step 5 — Convert + fetch WAV URLs (browser JS)

Run JS block **`CONVERT_AND_POLL`** with the selected clip IDs (**≤10 per call** — chunk larger sets). It triggers `convert_wav` for all (spaced 300ms), then polls every clip's `wav_file/` until ready (or 120s timeout per call). Returns one object per clip:

```
{ id, title, batch_index, wav_url, mp3_url, sidecar_json }
```

`sidecar_json` is an already-`JSON.stringify`'d **string** (write it verbatim — see the block's note on why it isn't a nested object).

If `wav_url` is `null` for some clips (timed out), re-run `CONVERT_AND_POLL` with just those IDs — conversion is already done server-side, so the retry resolves instantly.

### Step 6 — Download WAVs + write sidecar JSON

For each returned clip:
1. Build the filename: `{workspace} - {title}_{variant}` (variant `a`/`b` from `batch_index`; if `batch_index` is null, sort the two same-title clips by `created_at` then `id`).
   - Sanitize: replace `/ \ : * ? " < > |` with `_`.
   - **Watch path length** — `{workspace}` and `{title}` are both long and often share a prefix; the full path can approach the Windows 260-char `MAX_PATH` limit. If the path would exceed ~240 chars, drop the `{workspace} - ` prefix (the sidecar JSON still records the workspace) and tell the user.
2. **Bash**: `curl -s -L -o "{outdir}/{filename}.wav" "{wav_url}"`
   - Verify: file exists, size > 100KB, first 4 bytes are `RIFF`.
3. **Write** the sidecar `{outdir}/{filename}.json` — write the `sidecar_json` string from Step 5 **verbatim** (it is already valid pretty-printed JSON; do not re-serialize or hand-rebuild it from the tool's displayed output).

Batch the curl calls but keep ~300ms spacing to be polite to the CDN.

### Step 7 — Report

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

> **Process at most ~10 IDs per call.** Each result carries a ~2KB pre-stringified `sidecar_json`; larger batches risk the tool's output limit. For >10 clips, call this block in chunks.
>
> `sidecar_json` is returned as an **already-`JSON.stringify`'d string**, NOT a nested object. This is deliberate: `javascript_tool` truncates deeply-nested return objects (`[TRUNCATED: Max depth exceeded]`), which would corrupt a sidecar written from the displayed value. A string is rendered whole — write it to the `.json` file verbatim.

```js
(async () => {
  const token = await window.Clerk.session.getToken();
  const H = { accept: '*/*', authorization: `Bearer ${token}`,
    'browser-token': JSON.stringify({ token: btoa(JSON.stringify({ timestamp: Date.now() })) }),
    'device-id': '00000000-0000-4000-8000-000000000001', origin: 'https://suno.com', referer: 'https://suno.com/' };
  const API = 'https://studio-api-prod.suno.com';
  const ids = CLIP_IDS_JSON;
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  // trigger conversions (spaced)
  for (const id of ids) {
    await fetch(`${API}/api/gen/${id}/convert_wav/`, { method: 'POST', headers: H }).catch(() => {});
    await sleep(300);
  }
  // poll
  const wav = {};
  const deadline = Date.now() + 120000;
  while (Object.keys(wav).length < ids.length && Date.now() < deadline) {
    for (const id of ids) {
      if (wav[id]) continue;
      const r = await fetch(`${API}/api/gen/${id}/wav_file/`, { headers: H });
      if (r.ok) { const d = await r.json(); if (d.wav_file_url) wav[id] = d.wav_file_url; }
      await sleep(150);
    }
    if (Object.keys(wav).length < ids.length) await sleep(2000);
  }
  // fetch full metadata for sidecar
  const meta = {};
  for (let i = 0; i < ids.length; i += 20) {
    const batch = ids.slice(i, i + 20);
    const r = await fetch(`${API}/api/feed/?ids=${batch.join(',')}`, { headers: H });
    if (r.ok) {
      const j = await r.json();
      const arr = Array.isArray(j) ? j : (j.clips || []);
      arr.forEach(c => { meta[c.id] = c; });
    }
    await sleep(300);
  }
  return ids.map(id => {
    const c = meta[id] || {};
    return {
      id,
      title: c.title || null,
      batch_index: c.metadata?.batch_index ?? c.batch_index ?? null,
      wav_url: wav[id] || null,
      mp3_url: c.audio_url || null,
      sidecar_json: JSON.stringify(c, null, 2),  // pre-stringified — write to .json verbatim
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
