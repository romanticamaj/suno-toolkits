---
name: suno-download
description: Download all WAV files plus complete metadata sidecar JSON from a Suno workspace. Use when the user wants to download Suno songs, export a workspace, fetch WAV files, grab generated tracks, or invokes "/suno-download". Triggers Suno's convert_wav flow, polls until ready, downloads lossless WAV from CDN in parallel, and writes a full-metadata sidecar JSON next to each file.
version: 1.3.0
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
- **Sidecar JSON** — the metadata is exported via a **browser file download** (one bundle file), then split into per-clip files by a one-line `node` command. The Claude-in-Chrome tool channel *cannot* carry it reliably — it truncates string values over ~1KB, truncates deep objects, and blocks base64. A browser download sidesteps the channel completely (this is how the official-style exporter extensions do it too).

**Speed rule:** minimise model↔browser round-trips, but **cap API concurrency**. `convert_wav` and polling run through a concurrency pool — **≤5 `studio-api` requests in flight** — with **429 exponential backoff**. Never one-at-a-time-with-sleeps (too slow); never all-32-at-once (trips Suno's rate limiter). WAV downloads hit the `cdn1.suno.ai` **CDN**, not the API — 8-way parallel there is fine.

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

Run JS block **`CONVERT_AND_POLL`** with **all** selected clip IDs at once — no chunk limit, the return is tiny (`{id, wav_url}` pairs only). Internally it caps at **5 concurrent `studio-api` requests** and retries `429`s with exponential backoff, so it is fast without tripping Suno's rate limiter. It fires the conversions, then polls `wav_file/` every 5s until all ready (4-minute ceiling).

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

### Step 7 — Export + write sidecar JSON

**Do not** try to pull the metadata through the tool channel — it truncates string values over ~1KB and deep objects, and blocks base64. Each clip's metadata is ~5KB. Trying chunks / slicing / base64 / a localhost server are all dead ends that have each wasted 15+ minutes. Export it the way a browser extension does — as **one downloaded file**:

1. Build a **filename map** `{ "<clipId>": "<final .json filename>" }` for every selected clip. The `.json` name is the **same base name as the clip's WAV** (variant + sanitise + MAX_PATH rule from Step 6).
2. Run JS block **`FETCH_SIDECARS_BUNDLE`** — substitute `FILEMAP_JSON` with that map. It fetches every clip's full metadata (batched, 429-safe), builds one bundle, and triggers a **browser download**. It returns only a tiny status `{count, filename, bytes, missing}` — the real data goes to disk via the download, never through the tool channel, so no truncation is possible.
   - If Chrome shows a download permission prompt, approve it.
3. The bundle lands in the OS **Downloads folder** (`%USERPROFILE%\Downloads`; in bash usually `/c/Users/<you>/Downloads`) under the exact `filename` the JS returned. **Bash** — move it into the output dir and split it with **`SPLIT_SIDECARS`** (one `node` command, writes every per-clip `.json`, deletes the bundle):

```bash
# SPLIT_SIDECARS — {DL_FILE} = full path to the downloaded bundle, {OUTDIR} = output dir
mv "{DL_FILE}" "{OUTDIR}/_suno_sidecars.json" && node -e "const fs=require('fs'),p=require('path'),d=process.argv[1],b=JSON.parse(fs.readFileSync(p.join(d,'_suno_sidecars.json'),'utf8'));b.forEach(e=>fs.writeFileSync(p.join(d,e.file),e.json));fs.unlinkSync(p.join(d,'_suno_sidecars.json'));console.log('wrote '+b.length+' sidecars')" "{OUTDIR}"
```

This is **one inline `node` command** — not a script file, not a server. If `node` is genuinely unavailable, the only fallback is writing each `.json` with the `Write` tool individually (slow but works).

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

> **Shared rate-limit helpers** — both `CONVERT_AND_POLL` and `FETCH_SIDECARS` below open with the same two helpers: `api()` (a `fetch` wrapper that retries `429` with exponential backoff 2s→30s) and `pool()` (runs an async fn over a list with a hard concurrency cap). They are what keep the skill off Suno's rate limiter. Do not strip them out or replace them with bare `Promise.all` over all IDs.

### `CONVERT_AND_POLL`  — replace `CLIP_IDS_JSON` with a JS array literal e.g. `["id1","id2"]`

> Pass **all** selected clip IDs in one call. Conversions and polling each run at **≤5 concurrent** requests with 429 backoff. Return is just `{id, wav_url}` pairs (tiny).

```js
(async () => {
  const token = await window.Clerk.session.getToken();
  const H = { accept: '*/*', authorization: `Bearer ${token}`,
    'browser-token': JSON.stringify({ token: btoa(JSON.stringify({ timestamp: Date.now() })) }),
    'device-id': '00000000-0000-4000-8000-000000000001', origin: 'https://suno.com', referer: 'https://suno.com/' };
  const API = 'https://studio-api-prod.suno.com';
  const ids = CLIP_IDS_JSON;
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  // 429-aware fetch: exponential backoff on rate-limit
  async function api(url, opts) {
    for (let i = 0; i < 6; i++) {
      const r = await fetch(url, opts).catch(() => null);
      if (r && r.status === 429) { await sleep(Math.min(2000 * 2 ** i, 30000)); continue; }
      return r;
    }
    return null;
  }
  // concurrency-limited map — never more than `limit` requests in flight
  async function pool(items, limit, fn) {
    const out = []; let i = 0;
    await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (i < items.length) { const k = i++; out[k] = await fn(items[k]); }
    }));
    return out;
  }
  // fire conversions, ≤5 concurrent
  await pool(ids, 5, id => api(`${API}/api/gen/${id}/convert_wav/`, { method: 'POST', headers: H }));
  // poll, ≤5 concurrent, every 5s
  const wav = {};
  const deadline = Date.now() + 240000;
  while (Object.keys(wav).length < ids.length && Date.now() < deadline) {
    const pending = ids.filter(id => !wav[id]);
    await pool(pending, 5, async id => {
      const r = await api(`${API}/api/gen/${id}/wav_file/`, { headers: H });
      if (r && r.ok) { const d = await r.json(); if (d.wav_file_url) wav[id] = d.wav_file_url; }
    });
    if (Object.keys(wav).length < ids.length) await sleep(5000);
  }
  return ids.map(id => ({ id, wav_url: wav[id] || null }));
})()
```

### `FETCH_SIDECARS_BUNDLE`  — replace `FILEMAP_JSON` with a `{clipId: "filename.json"}` object literal

> Fetches every clip's metadata, builds one bundle `[{file, json}]`, and **triggers a browser download** of it. Returns only a tiny status object — the metadata itself never crosses the tool channel, so its ~1KB string cap and depth limit do not apply. Pass **all** selected clips in one call.

```js
(async () => {
  const token = await window.Clerk.session.getToken();
  const H = { accept: '*/*', authorization: `Bearer ${token}`,
    'browser-token': JSON.stringify({ token: btoa(JSON.stringify({ timestamp: Date.now() })) }),
    'device-id': '00000000-0000-4000-8000-000000000001', origin: 'https://suno.com', referer: 'https://suno.com/' };
  const API = 'https://studio-api-prod.suno.com';
  const filemap = FILEMAP_JSON;            // { clipId: "final filename.json" }
  const ids = Object.keys(filemap);
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  async function api(url, opts) {
    for (let i = 0; i < 6; i++) {
      const r = await fetch(url, opts).catch(() => null);
      if (r && r.status === 429) { await sleep(Math.min(2000 * 2 ** i, 30000)); continue; }
      return r;
    }
    return null;
  }
  // fetch all metadata, batched 20 ids per call
  const meta = {};
  for (let i = 0; i < ids.length; i += 20) {
    const r = await api(`${API}/api/feed/?ids=${ids.slice(i, i + 20).join(',')}`, { headers: H });
    const j = (r && r.ok) ? await r.json() : [];
    (Array.isArray(j) ? j : (j.clips || [])).forEach(c => { meta[c.id] = c; });
  }
  // build bundle [{file, json}] — json is the pretty-printed full clip object
  const bundle = ids.map(id => ({
    file: filemap[id],
    json: JSON.stringify(meta[id] || { id, error: 'metadata not returned' }, null, 2),
  }));
  // trigger a browser download — bypasses the tool channel entirely
  const fname = '_suno_sidecars_' + Date.now() + '.json';
  const blob = new Blob([JSON.stringify(bundle)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = fname;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10000);
  return { count: bundle.length, filename: fname, bytes: blob.size, missing: ids.filter(id => !meta[id]) };
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
- **Rate limiting**: Suno's `studio-api` throttles aggressive clients (the exporter extensions ship 300ms spacing + exponential backoff for exactly this). `CONVERT_AND_POLL` caps at **5 concurrent** requests; both it and `FETCH_SIDECARS_BUNDLE` retry `429`s with backoff (2s→30s). If you still see repeated `429`s, lower the `pool` limit from `5` to `3`. WAV downloads from `cdn1.suno.ai` are **CDN** traffic — a separate system, not subject to the API limit, so `xargs -P 8` is safe there.
- **Why the sidecar uses a browser download**: the tool channel has *layered* limits — depth truncation on nested objects, a ~1KB cap on individual string values, base64 blocking, and a total output size limit. They were discovered one at a time across test runs. A browser file download bypasses all of them at once and is the stable answer — do not "optimise" it back into tool-channel chunks.
- This skill is **read-only on Suno** (convert_wav only triggers a render of an existing clip — no new generations, no extra credits beyond the WAV entitlement).
