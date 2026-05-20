# suno-toolkits

A Claude Code plugin that automates [Suno AI](https://suno.com) — batch-submit prompts and download lossless WAV + full metadata. It drives a real logged-in Suno session through Claude in Chrome, so there are no API keys and no anti-bot workarounds.

## Skills

| Skill | Does |
|-------|------|
| **`suno-submit`** | Batch-submits a folder of `prompts.json` — creates the workspace, fills Suno's Advanced create form per prompt (style, lyrics, exclude, model, Weirdness/Style Influence), clicks Create. `--only` submits a subset. |
| **`suno-download`** | Downloads a whole workspace as lossless WAV (48kHz/16-bit/stereo) plus a full-metadata sidecar JSON per track. |

## Install

```
/plugin marketplace add romanticamaj/suno-toolkits
/plugin install suno-toolkits@romanticamaj
```

## Requirements

- Chrome with the **Claude extension** installed
- Claude Code started with **`claude --chrome`**
- Logged in to **suno.com** on a paid plan (WAV export and v5/v5.5 need it)

## Usage

```
/suno-toolkits:suno-submit    <folder>     → creates a workspace, runs the create form
        ⋯ wait for Suno to render ⋯
/suno-toolkits:suno-download  <workspace>  → WAV + metadata JSON to disk
```

Input is a `prompts.json` (or a folder of them). Schema and full workflow detail live in each skill's `SKILL.md`.

## How it works

Suno has no public API; both skills call its internal `studio-api` from the logged-in browser tab (auth via the page's Clerk token). Bulk data stays out of the model context — WAVs download via `curl` from Suno's CDN, metadata via a browser download — and API calls are concurrency-capped with `429` backoff.

## Develop

```
claude --chrome --plugin-dir <path-to-this-repo>
```

Edit a `SKILL.md`, then `/reload-plugins`. Bump `version` in `.claude-plugin/plugin.json` per change — that is the number the reload shows.

## License

MIT — see [LICENSE](LICENSE).
