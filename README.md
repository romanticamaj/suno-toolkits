# suno-toolkits

A Claude Code plugin that automates [Suno AI](https://suno.com) — batch-submit prompts and download lossless WAV + full metadata. It drives a real logged-in Suno session, so there are no API keys and no anti-bot workarounds.

## Skills

| Skill | Does |
|-------|------|
| **`suno-submit`** | Batch-submits a folder of `prompts.json` — creates the workspace, fills Suno's Advanced create form per prompt (style, lyrics, exclude, model, Weirdness/Style Influence), clicks Create. Runs as a **single Playwright script** by default; falls back to a model-driven Claude in Chrome loop. `--only` submits a subset. |
| **`suno-download`** | Downloads a whole workspace as lossless WAV (48kHz/16-bit/stereo) plus a full-metadata sidecar JSON per track. |

## Install

```
/plugin marketplace add romanticamaj/suno-toolkits
/plugin install suno-toolkits@romanticamaj
```

## Requirements

- **Google Chrome** installed, and a **paid Suno plan** (WAV export and v5/v5.5 need it)
- For the scripted submit path: `npm install && npx playwright install chrome`, then one manual Suno sign-in on first run
- For `suno-download` and the fallback submit path: the **Claude extension** in Chrome, Claude Code started with **`claude --chrome`**, and that Chrome logged in to suno.com

## Usage

```
/suno-toolkits:suno-submit    <folder>     → creates a workspace, runs the create form
        ⋯ wait for Suno to render ⋯
/suno-toolkits:suno-download  <workspace>  → WAV + metadata JSON to disk
```

Or drive the submit directly, with no model in the loop at all:

```bash
npm install && npx playwright install chrome                     # once

node skills/suno-submit/scripts/submit.mjs "<folder>" --dry-run   # fill + verify, never Create
node skills/suno-submit/scripts/submit.mjs "<folder>"             # for real
```

The script keeps its own Chrome profile (outside this repo) and asks you to sign in once. It
writes `_submit_result.json` next to the prompts and exits non-zero if anything failed
verification. **Run `--dry-run` first on a new batch** — it costs nothing and catches UI drift
before it can waste credits.

Input is a `prompts.json` (or a folder of them). Schema and full workflow detail live in each skill's `SKILL.md`.

## How it works

Suno has no public API; everything here calls its internal `studio-api` from a logged-in browser tab (auth via the page's Clerk token, which never leaves the browser). Bulk data stays out of the model context — WAVs download via `curl` from Suno's CDN, metadata via a browser download — and API calls are concurrency-capped with `429` backoff.

Submitting still needs the real UI: the create form has no clean submit endpoint, the lyrics box is a Lexical contenteditable that only accepts a genuine paste, and the sliders are Radix components that only move on real arrow keys. `scripts/submit.mjs` performs exactly that sequence from one Node process, which is why the scripted path costs roughly a fifteenth of the model-driven one on a large batch — the work is identical, the model just is not in the loop for it.

## Develop

```
claude --chrome --plugin-dir <path-to-this-repo>
```

Edit a `SKILL.md`, then `/reload-plugins`. Bump `version` in `.claude-plugin/plugin.json` per change — that is the number the reload shows.

## License

MIT — see [LICENSE](LICENSE).
