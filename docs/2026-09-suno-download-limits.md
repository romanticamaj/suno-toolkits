# Suno download limits (Sept 2026) — what changed, how the client counts, what it means for `download.mjs`

Research notes, 2026-09-04 → 2026-09-06. Everything below was read from Suno's help centre,
the account's `/api/billing/info/`, and the web app's Next.js bundles (read-only scan). Nothing
here was learned by hammering endpoints; the one live experiment is documented at the end.

## 1. The policy

Effective **2026-09-03**, retroactive to all songs (including ones created earlier).

| Plan | Downloads |
|---|---|
| Free | 7 lifetime (personal, non-commercial) |
| Pro | 20 / month |
| Premier | 60 / month |
| Premier + Suno Studio | "users will still be able to download their work from Studio **without limitation**" |

Counting rules, quoted from the FAQ:

- "One song counts as one download, regardless of format." All stems of a song are part of that
  single download.
- "Once you've downloaded a song, downloading it again in any format, doesn't count against
  your quota."
- "Failed or interrupted downloads don't count against your quota."
- Allowances reset on the billing date; unused ones don't carry over. Top-ups are purchasable.

Stated purpose (blog): "limiting downloads will make it harder for bad actors to mass-export music."

Sources: [help.suno.com/en/articles/13614785](https://help.suno.com/en/articles/13614785) ·
[suno.com/blog/suno-updates-tos](https://suno.com/blog/suno-updates-tos)

## 2. What the account API exposes

`GET /api/billing/info/` (studio-api-prod.suno.com) now carries:

```
download_usage.current_period_downloads_limit              60      (Premier)
download_usage.current_period_downloads_used               0
download_usage.additional_download_remaining               7
download_usage.current_period_download_top_ups_purchased   0
download_usage.current_period_download_top_up_purchase_limit 60
download_credit_packs   1 → $2.99 · 3 → $8.95 · 5 → $14.95 · 10 → $29.90
accessible_features     … "studio" …
```

Each clip object (both `/api/project/{id}` and `/api/feed/`) has a new boolean
**`is_download_unlocked`** — true once a song has been "downloaded" under the new rules, after
which re-downloads are free.

## 3. Four download paths in the web client

Decoded from the bundles (`createClipDownloadHandler`, `downloadClipAudio/M4a/Wav`,
`downloadSelectedClipsAsZip`, the Studio download menu).

| # | Path | Endpoints | Who counts it |
|---|---|---|---|
| **A** | Legacy WAV — **what `download.mjs` uses** | `POST /api/gen/{id}/convert_wav/` → `GET /api/gen/{id}/wav_file/` → signed S3 URL (1 h TTL) | **Client-reported.** After the file is saved the web app POSTs `/api/gen/{id}/increment_action_count/` with `{action: "audio-wav", download_source}` (bulk variant: `/api/gen/increment_action_counts/` with `gen_ids[]`). |
| **B** | New single-clip | `GET /api/download/clip/{id}?format=mp3\|m4a` — polled until `status:"ready"` → `download_url`; handles `processing`, `rate_limited`, `error` | Server-side. This is what the UI's Download button uses for mp3/m4a. A feature gate `use-presigned-audio-download-url` is migrating audio downloads onto this path. |
| **C** | Official bulk | `POST /api/download/clips/zip/prepare` `{clip_ids (≤200), workspace_name, format (default m4a), batch_id?}` → one zip `download_url`; returns `failed_clips`, `substituted_clips` | Server-side (presumably per clip). Entry surfaces: `/create` ("create") and `/me` ("library"). |
| **D** | Suno Studio | `GET /api/studio/clip/{id}/download?format=…` (same ready/processing/rate_limited polling as B); selection renders via `POST /api/studio/render-state` / `render-state-multitrack` with `format:"wav"`, `render_engine:"v2"` | Per the FAQ, not limited for Premier Studio users. Formats seen in the Studio bundle: `wav`, `mp3`, `m4a`. |

UI flow for a counted download: the Download menu opens `DOWNLOAD_RESTRICTIONS` modal with
`isClipDownloadUnlocked`; on confirm `createClipDownloadHandler` runs A/B; the client then calls
`markClipDownloadUnlocked` (cache) — the server flag flips via the count call.

Related Studio endpoints: `POST /api/studio/create-or-load-project-for-clip/{clip_id}`,
`GET /api/studio/clips/{clip_id}/projects`, `/api/studio/project/{project_id}`, …

## 4. Where `download.mjs` stands

- It runs path **A** and does **not** send `increment_action_count`. Consequence observed on
  2026-09-04: 42 WAVs fetched after the policy started, `downloads_used` still `0`, all 60 clips
  `is_download_unlocked: false`.
- That is a gap in Suno's accounting, not an exemption. The migration gate on path B suggests
  `wav_file/` will be retired; the tool must not depend on A.
- A longform project = 30 prompts × 2 takes = **60 clips = the whole Premier month** if every
  take is counted. Under the new rules the economical workflow is *audition (streaming is
  unlimited) → pick takes → download only the chosen 30*.

## 5. Options

1. **Path D (Studio)** — the sanctioned unlimited route for this plan. Open question: does
   `GET /api/studio/clip/{id}/download?format=wav` work on a plain workspace clip (or only after
   `create-or-load-project-for-clip`), and is it truly uncounted? → experiment below.
2. **Quota guard** regardless of path: read `download_usage` at start, print `used/limit`, refuse
   to start a batch larger than the remaining allowance.
3. **Honest counted path** if D is not viable: use B/C (or send `increment_action_count` after A
   the way the UI does) plus a "download only `order.txt` takes" mode so a project costs 30, not 60.

## 6. Live experiment (2026-09-06)

Approved by the owner. One clip only: `Camping Night_01 Emberlight_a`
(`859c3009-fdd1-4391-88e8-29d0783ecd0c`), which already exists locally via path A.

Protocol:
1. read `download_usage` + `is_download_unlocked` (before)
2. `GET /api/studio/clip/{id}/download?format=wav`, poll as the client does
3. if the file is served, save it through a browser download and verify its embedded clip id
   and format with ffprobe
4. read `download_usage` + `is_download_unlocked` (after)

### Result

| Measurement | Value |
|---|---|
| `download_usage.current_period_downloads_used` before / after two Studio calls (one of which actually served the file to the browser) | **0 → 0** |
| `is_download_unlocked` on the clip before / after | **false → false** |
| First poll on a clip that already had a WAV rendered | `{ok: true, status: "ready", download_url}` immediately |
| First poll on a clip never converted (`01 Emberlight_b`) | `{ok: true, status: "processing"}` — the endpoint **triggers the conversion itself**; no separate `convert_wav` needed |
| `download_url` | `https://suno-data-uploads.s3.amazonaws.com/studio/uploads/<clip id>.wav?…Expires=…` — **the same S3 object path A hands out**, Signature V2, TTL 3599 s |
| Studio project required? | **No.** Works on a plain workspace clip; `create-or-load-project-for-clip` was never called |

Response contract: `{ ok: boolean, status: "processing" | "ready" | "error", download_url?, reason?
("rate_limited" seen in the client), detail? }`. The client polls every 2 s up to 90 times.

Two procedural notes: (1) a cross-origin `<a download>` on the signed URL is treated as
navigation, not a download — the tab left suno.com and Chrome played the WAV inline; save it
from Node/curl instead. (2) Polling `format=wav` on an unconverted clip starts a server-side
conversion as a side effect, exactly like `convert_wav`.

### Interpretation

Path **D** is the endpoint Suno's own Studio UI uses, and the FAQ states Studio downloads are
unlimited for Premier. Measured: it does not touch `download_usage` or `is_download_unlocked`.
That makes it the **sanctioned** unlimited route for this plan — unlike path A, whose zero count
is an accounting gap (the UI reports A downloads via `increment_action_count`; the script does
not). Both resolve to the same S3 object, so switching costs nothing in output.

Caveat kept honest: server-side exemption vs. "also not counted" cannot be distinguished from the
client; what is verifiable is that D is the documented-unlimited path and behaves as documented.

### Decision for `download.mjs` (v0.7.0)

1. Replace `convert_wav` + `wav_file/` with `GET /api/studio/clip/{id}/download?format=wav`
   polled to `ready` (handle `processing` / `rate_limited` / `error`; ≤5 in flight).
2. Add a **quota guard**: read `download_usage` at start, print `used/limit`, and — for any
   counted path — refuse a batch larger than the remaining allowance.
3. Keep the legacy path behind `--legacy-wav` for one release in case the Studio endpoint is
   gated for non-Studio plans (`accessible_features` lacks `"studio"` → fall back with a warning).
