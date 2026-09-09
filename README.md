# suno-toolkits

A Claude Code plugin that automates [Suno AI](https://suno.com) — batch-submit prompts and download lossless WAV + full metadata. It drives a real logged-in Suno session, so there are no API keys and no anti-bot workarounds.

## Skills

| Skill | Does |
|-------|------|
| **`suno-submit`** | Batch-submits a folder of `prompts.json` — creates the workspace, fills Suno's Advanced create form per prompt (style, lyrics, exclude, model, Weirdness/Style Influence), clicks Create. Runs as a **single Playwright script** by default; falls back to a model-driven Claude in Chrome loop. `--only` submits a subset. |
| **`suno-download`** | Downloads a whole workspace as lossless WAV (48kHz/16-bit/stereo) plus a full-metadata sidecar JSON per track. Also a **single Playwright script** on the same profile: waits for rendering clips, verifies every file's size against its duration, resumes partial runs. `--only` for a subset. |

## Install

```
/plugin marketplace add romanticamaj/suno-toolkits
/plugin install suno-toolkits@romanticamaj
```

## Requirements

- **Google Chrome** installed, and a **paid Suno plan** (WAV export and v5/v5.5 need it)
- `npm install && npx playwright install chrome` once, then one manual Suno sign-in on first run — both skills share that profile
- Only for the fallback (model-driven) paths: the **Claude extension** in Chrome, Claude Code started with **`claude --chrome`**, and that Chrome logged in to suno.com

## Usage

```
/suno-toolkits:suno-submit    <folder>     → creates a workspace, runs the create form
        ⋯ wait for Suno to render ⋯
/suno-toolkits:suno-download  <workspace>  → WAV + metadata JSON to disk
```

Both skills run a Playwright script for you. `/suno-submit` builds the queue, confirms the
credit spend, health-checks the selectors, launches the batch in the background and reports from
`_submit_result.json`. `/suno-download` resolves the workspace, waits for anything still
rendering, converts, downloads with size verification and reports from `_download_result.json`.
You do not type the script paths.

To drive them yourself instead:

```bash
npm install && npx playwright install chrome                     # once

node skills/suno-submit/scripts/submit.mjs --login                 # one-time sign-in (serves both)
node skills/suno-submit/scripts/submit.mjs "<folder>" --doctor     # ~15s selector health check
node skills/suno-submit/scripts/submit.mjs "<folder>" --dry-run    # fill + verify, never Create
node skills/suno-submit/scripts/submit.mjs "<folder>"              # for real

node skills/suno-download/scripts/download.mjs "<workspace>" --out "<dir>" --dry-run   # list + planned names
node skills/suno-download/scripts/download.mjs "<workspace>" --out "<dir>"             # WAV + JSON, resumable
```

The scripts share one Chrome profile (outside this repo) and ask you to sign in once. Each
writes its `_*_result.json` and exits non-zero if anything failed verification. **Run
`--dry-run` first on a new batch** — it costs nothing and catches UI drift before it can waste
credits. Re-running `download.mjs` skips files already on disk that pass the size check.

Input is a `prompts.json` (or a folder of them). Schema and full workflow detail live in each skill's `SKILL.md`.

## How it works

Suno has no public API; everything here calls its internal `studio-api` from a logged-in browser tab (auth via the page's Clerk token, which never leaves the browser — `lib/session.mjs` runs each call inside the page). API calls are concurrency-capped with `429` backoff.

Lossless audio is not sitting on a CDN: Suno renders the WAV on demand and hands back a short-lived signed S3 URL. The public `media_urls` are an encrypted opus stream for the web player. Since Suno's September 2026 download caps, `download.mjs` resolves WAVs through the **Suno Studio download endpoint** — the route Suno documents as unlimited for Premier + Studio, measured not to touch the account's `download_usage` — and falls back to the legacy `convert_wav` + `wav_file/` pair for accounts without Studio (with an allowance guard). The full investigation is in [`docs/2026-09-suno-download-limits.md`](docs/2026-09-suno-download-limits.md). Each WAV is streamed straight to disk and verified by size against the clip's duration and by the clip id Suno embeds in the file.

Submitting still needs the real UI: the create form has no clean submit endpoint, the lyrics box is a Lexical contenteditable that only accepts a genuine paste, and the sliders are Radix components that only move on real arrow keys. `submit.mjs` performs exactly that sequence from one Node process. Either way the scripted path costs roughly a fifteenth of the model-driven one on a large batch — the work is identical, the model just is not in the loop for it.

## Develop

```
claude --chrome --plugin-dir <path-to-this-repo>
```

Edit a `SKILL.md`, then `/reload-plugins`. Bump `version` in `.claude-plugin/plugin.json` per change — that is the number the reload shows.

## License

MIT — see [LICENSE](LICENSE).
