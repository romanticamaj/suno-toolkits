# suno-toolkits

Claude Code plugin that automates the [Suno AI](https://suno.com) music workflow through the Claude in Chrome browser tools — no API keys, no anti-bot fights. It drives a real logged-in Suno session.

Two skills:

| Skill | What it does |
|-------|--------------|
| **`suno-submit`** | Batch-submit `prompts.json` files. Creates/switches to a named workspace, fills the Advanced create form per prompt (style, lyrics, exclude, title, model, Weirdness/Style Influence), clicks Create with paced timing. Supports an `--only` selector to submit just specific prompts. |
| **`suno-download`** | Download every song in a workspace as lossless **WAV** (48kHz/16-bit/stereo PCM) plus a complete-metadata sidecar **JSON** per track. Triggers Suno's `convert_wav` flow, polls, fetches from CDN. |

## Pipeline

```
(generate prompts.json — e.g. by hand or another skill)
        │
        ▼
/suno-submit  <folder>        ─ creates workspace, runs the Suno create form
        │
   (wait ~1-3 min/song for Suno to render)
        │
        ▼
/suno-download  <workspace>   ─ pulls WAV + metadata JSON to disk
```

## Requirements

- **Chrome with the Claude extension installed** — the "Claude in Chrome" browser extension.
- **Claude Code launched with `--chrome`**: `claude --chrome`. This flag connects Claude Code to the Chrome extension; without it the skills cannot drive the browser at all.
- Logged in to **suno.com** in that Chrome, on a **paid plan** (WAV export and v5/v5.5 models require it).
- No Suno tab needs to be open beforehand — the skills navigate to suno.com themselves.

## How it works

Suno has no public API. Both skills call Suno's internal `studio-api` endpoints from inside the logged-in browser tab (auth via the page's Clerk session token), and use real UI interaction only where there is no API (the create form, custom slider components). Heavy file transfer (WAV download) is done with `curl` against the public CDN, so large files never pass through the model context.

See each skill's `SKILL.md` for the full endpoint reference and JS blocks.

## prompts.json schema

```json
{
  "project": "project name",
  "short_name": "short name used in Suno song titles",
  "creator": "you",
  "date": "YYYY.MM.DD",
  "prompts": [
    {
      "id": "01",
      "name": "EnglishName",
      "name_zh": "中文名",
      "style": "concise genre/arrangement tags",
      "lyrics": "[Intro]...  or null",
      "negative_tags": "NO vocals, NO drums",
      "instrumental": true,
      "model": "v5.5",
      "weirdness": null,
      "style_influence": null
    }
  ]
}
```

`null` = use Suno's default (model → v5.5; weirdness/style_influence → 50).

## Local testing

This is a plugin folder. To load it during development, start Claude Code with **both** flags —
`--chrome` (so the skills can drive the browser) and `--plugin-dir` (so the plugin loads):

```bash
claude --chrome --plugin-dir D:\ulovemusic\suno-toolkits
```

Skills are then available as `/suno-toolkits:suno-submit` and `/suno-toolkits:suno-download`.
After editing a `SKILL.md`, run `/reload-plugins` — no restart needed.

> Omit `--chrome` and the skills load but can't operate Chrome. Omit `--plugin-dir` and the skills aren't loaded at all. Local testing needs both.

## Status

`v0.1.0` — both skills built and verified end-to-end against a real Suno Pro account. Roadmap: standalone marketplace, `prompts.json` JSON Schema, future skills (`suno-extend`, `suno-stems`, `suno-cleanup`).
