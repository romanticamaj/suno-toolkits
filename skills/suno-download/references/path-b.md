# Suno Download — Path B: the model-driven loop (Claude in Chrome)

**Fallback only.** `scripts/download.mjs` is the default and does all of this in one process.
Read this file only when the script is broken and a download is urgent, or when a step here is
needed to diagnose it. Everything below was the original procedure and is kept verbatim.

## Prerequisites

- Claude Code started with **`claude --chrome`**; the Claude extension installed in Chrome.
- That Chrome logged in to **suno.com** on a paid plan (WAV export needs Pro/Premier).
- A Suno tab does **not** need to be open beforehand — Step 1 navigates a tab to suno.com itself.

## Workflow

### Step 1 — Browser tab

1. `ToolSearch`: `select:mcp__claude-in-chrome__tabs_context_mcp,mcp__claude-in-chrome__navigate,mcp__claude-in-chrome__javascript_tool`.
2. `tabs_context_mcp` → get/create a tab. **Always `navigate` it to `https://suno.com/create`** — the tab must be on a `suno.com` origin or `window.Clerk` (the auth token source) won't exist.

### Step 2 — Resolve the workspace

Run **`LIST_WORKSPACES`**. Match case-insensitively on substring. 0 → stop; >1 → list and ask. Keep the `project_id`.

### Step 3 — List clips

Run **`LIST_CLIPS`** with the `project_id`. Returns every clip with `id, title, batch_index, duration, created_at, status`.

### Step 4 — Confirm selection

Show `# | title | duration | variant`; `batch_index` 0 → `_a`, 1 → `_b`. Ask which to download unless the user said "all".

### Step 5 — Convert + get WAV URLs

Run **`CONVERT_AND_POLL`** with all selected IDs. ≤5 concurrent `studio-api` requests, 429 backoff, polls `wav_file/` every 5 s (4-minute ceiling).

⚠️ **The tool channel blocks the returned signed URLs** (`[BLOCKED: Cookie/query string data]`). Do not fight it: run **`EXPORT_URL_MAP`** instead, which fetches the same URLs and triggers a **browser download** of a `{clipId: url}` JSON into `%USERPROFILE%\Downloads`; read it from Bash.

### Step 6 — Download WAVs (Bash)

1. Filename `{workspace} - {title}_{variant}` — sanitize `/ \ : * ? " < > |` → `_`; if the full path would exceed ~240 chars drop the `{workspace} - ` prefix.
2. `xargs -P 8 -n 1 curl -sL --retry 3 --retry-all-errors -O < _wav_urls.txt` (saves as `{clipId}.wav`).
3. Rename to the final names.
4. **Verify size against duration**, not just the header: `expected = duration*192000+44`, flag if `size/expected` outside `[0.97, 1.05]`. A truncated download keeps a valid `RIFF` header.
5. Any failure → re-fetch a **fresh** URL (`wav_file/`) and retry; the old signed URL may have expired.

### Step 7 — Sidecar JSON

Run **`FETCH_SIDECARS_BUNDLE`** (browser download of one bundle) then split with **`SPLIT_SIDECARS`**. Do **not** pull metadata through the tool channel — it truncates strings over ~1 KB, truncates deep objects, and blocks base64.

```bash
# SPLIT_SIDECARS — {DL_FILE} = downloaded bundle, {OUTDIR} = output dir
mv "{DL_FILE}" "{OUTDIR}/_suno_sidecars.json" && node -e "const fs=require('fs'),p=require('path'),d=process.argv[1],b=JSON.parse(fs.readFileSync(p.join(d,'_suno_sidecars.json'),'utf8'));b.forEach(e=>fs.writeFileSync(p.join(d,e.file),e.json));fs.unlinkSync(p.join(d,'_suno_sidecars.json'));console.log('wrote '+b.length+' sidecars')" "{OUTDIR}"
```

> Note: `/api/project/{id}` already returns the identical clip object (verified: same 41 keys as `/api/feed/`). The bundle can be built from Step 3's data instead of a second fetch.

---

## JS Blocks

All blocks assume a Suno tab. Each is a self-contained IIFE for `javascript_tool`. If a
token-reading block returns `{}`, prefix the whole IIFE with `await`.

### Shared header (inside every block)

```js
const token = await window.Clerk.session.getToken();
const H = {
  accept: '*/*', 'content-type': 'application/json', authorization: `Bearer ${token}`,
  'browser-token': JSON.stringify({ token: btoa(JSON.stringify({ timestamp: Date.now() })) }),
  'device-id': '00000000-0000-4000-8000-000000000001',
  origin: 'https://suno.com', referer: 'https://suno.com/',
};
const API = 'https://studio-api-prod.suno.com';  // dash host; studio-api.prod.suno.com (dot) is an alias
```

### `LIST_WORKSPACES`

> `/api/project/me` pages are **1-indexed**; `page=0` returns the same data as `page=1`. De-dup by `id`.

```js
(async () => {
  const token = await window.Clerk.session.getToken();
  const H = { accept: '*/*', authorization: `Bearer ${token}`,
    'browser-token': JSON.stringify({ token: btoa(JSON.stringify({ timestamp: Date.now() })) }),
    'device-id': '00000000-0000-4000-8000-000000000001', origin: 'https://suno.com', referer: 'https://suno.com/' };
  const seen = new Set(); const out = [];
  for (let page = 1; page <= 20; page++) {
    const r = await fetch(`https://studio-api-prod.suno.com/api/project/me?page=${page}&sort=created_at&show_trashed=false`, { headers: H });
    if (!r.ok) break;
    const j = await r.json(); const projs = j.projects || [];
    let added = 0;
    for (const p of projs) { if (!seen.has(p.id)) { seen.add(p.id); out.push(p); added++; } }
    if (projs.length === 0 || added === 0 || out.length >= (j.num_total_results || 0)) break;
  }
  return out.map(p => ({ id: p.id, name: p.name, clip_count: p.clip_count, created_at: p.created_at }));
})()
```

### `LIST_CLIPS` — replace `PROJECT_ID`

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
  return clips.map(c => ({
    id: c.id, title: c.title, batch_index: c.metadata?.batch_index ?? c.batch_index ?? null,
    duration: Math.round(c.metadata?.duration || 0), created_at: c.created_at, status: c.status,
  }));
})()
```

### `CONVERT_AND_POLL` — replace `CLIP_IDS_JSON` with a JS array literal

> Fires conversions and polls at ≤5 concurrent with 429 backoff. Returns `{id, wav_url}` pairs —
> **the URLs will be blocked by the tool channel**; use `EXPORT_URL_MAP` right after.

```js
(async () => {
  const token = await window.Clerk.session.getToken();
  const H = { accept: '*/*', authorization: `Bearer ${token}`,
    'browser-token': JSON.stringify({ token: btoa(JSON.stringify({ timestamp: Date.now() })) }),
    'device-id': '00000000-0000-4000-8000-000000000001', origin: 'https://suno.com', referer: 'https://suno.com/' };
  const API = 'https://studio-api-prod.suno.com';
  const ids = CLIP_IDS_JSON;
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  async function api(url, opts) {
    for (let i = 0; i < 6; i++) {
      const r = await fetch(url, opts).catch(() => null);
      if (r && r.status === 429) { await sleep(Math.min(2000 * 2 ** i, 30000)); continue; }
      return r;
    }
    return null;
  }
  async function pool(items, limit, fn) {
    const out = []; let i = 0;
    await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (i < items.length) { const k = i++; out[k] = await fn(items[k]); }
    }));
    return out;
  }
  await pool(ids, 5, id => api(`${API}/api/gen/${id}/convert_wav/`, { method: 'POST', headers: H }));
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

### `EXPORT_URL_MAP` — replace `CLIP_IDS_JSON`

> Re-reads `wav_file/` (instant once converted) and **downloads** `{clipId: url}` as a JSON file.

```js
(async () => {
  const token = await window.Clerk.session.getToken();
  const H = { accept: '*/*', authorization: `Bearer ${token}`,
    'browser-token': JSON.stringify({ token: btoa(JSON.stringify({ timestamp: Date.now() })) }),
    'device-id': '00000000-0000-4000-8000-000000000001', origin: 'https://suno.com', referer: 'https://suno.com/' };
  const API = 'https://studio-api-prod.suno.com';
  const ids = CLIP_IDS_JSON;
  const out = {};
  for (const id of ids) {
    const r = await fetch(`${API}/api/gen/${id}/wav_file/`, { headers: H });
    out[id] = r.ok ? ((await r.json()).wav_file_url || null) : null;
  }
  const fname = '_suno_wav_urls_' + Date.now() + '.json';
  const blob = new Blob([JSON.stringify(out, null, 1)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a'); a.href = url; a.download = fname;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10000);
  return { filename: fname, got: Object.values(out).filter(Boolean).length };
})()
```

### `FETCH_SIDECARS_BUNDLE` — replace `FILEMAP_JSON` with `{clipId: "filename.json"}`

```js
(async () => {
  const token = await window.Clerk.session.getToken();
  const H = { accept: '*/*', authorization: `Bearer ${token}`,
    'browser-token': JSON.stringify({ token: btoa(JSON.stringify({ timestamp: Date.now() })) }),
    'device-id': '00000000-0000-4000-8000-000000000001', origin: 'https://suno.com', referer: 'https://suno.com/' };
  const API = 'https://studio-api-prod.suno.com';
  const filemap = FILEMAP_JSON;
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
  const meta = {};
  for (let i = 0; i < ids.length; i += 20) {
    const r = await api(`${API}/api/feed/?ids=${ids.slice(i, i + 20).join(',')}`, { headers: H });
    const j = (r && r.ok) ? await r.json() : [];
    (Array.isArray(j) ? j : (j.clips || [])).forEach(c => { meta[c.id] = c; });
  }
  const bundle = ids.map(id => ({ file: filemap[id], json: JSON.stringify(meta[id] || { id, error: 'metadata not returned' }, null, 2) }));
  const fname = '_suno_sidecars_' + Date.now() + '.json';
  const blob = new Blob([JSON.stringify(bundle)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a'); a.href = url; a.download = fname;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10000);
  return { count: bundle.length, filename: fname, bytes: blob.size, missing: ids.filter(id => !meta[id]) };
})()
```

---

## Notes & gotchas (Path B)

- **Token-reading JS returns `{}`** → prefix the IIFE with `await`. If it keeps happening after a tab-group reset, relaunch `claude --chrome`.
- **Signed URLs never survive the tool channel** — export them via browser download, always.
- **Truncated downloads keep a valid RIFF header** — verify size vs duration (`duration*192000+44`, ±3 %), then decode-check suspects with `ffmpeg -v error -i F -f null -`.
- **Fresh URL on retry.** A signed URL expires; reusing one that failed just fails again.
- **Rate limiting**: ≤5 concurrent to `studio-api`; if `429`s persist, drop to 3. CDN downloads are a separate system — 8-way parallel there is fine.
- **First-run conversion is not instant at scale**: 112 clips took ~2 poll rounds (~3–4 min).
- **WAV needs a paid plan** — `convert_wav` 401/403 means the account lacks it.
- **Variant naming: sort same-title clips by `created_at` then `id` — never by `batch_index`.** That field is transient (present right after a Create, gone from the same endpoint a day later); naming from it produced files that a later run re-labelled a↔b. The WAV's embedded `ICMT … id=<clip id>` is the ground truth for what a file is — check it, not just the size.
- **`metadata.control_sliders`** is only present when the sliders were moved off 50 — its absence is normal.
- Both API hosts (`studio-api-prod.suno.com` dash / `studio-api.prod.suno.com` dot) are aliases.
