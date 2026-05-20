# suno-toolkits

Claude Code plugin that automates the [Suno AI](https://suno.com) music workflow through the Claude in Chrome browser tools — no API keys, no anti-bot fights. It drives a real logged-in Suno session.

**Plugin `0.3.0`** · `suno-submit` v1.0.0 · `suno-download` v1.3.0

## Skills

| Skill | What it does |
|-------|--------------|
| **`suno-submit`** | Batch-submit `prompts.json` files. Creates/switches to a named workspace, fills the Advanced create form per prompt (style, lyrics, exclude, title, model, Weirdness/Style Influence sliders), clicks Create with paced timing. An `--only` selector submits just specific prompts (by id, name, or BGM group). |
| **`suno-download`** | Download every song in a workspace as lossless **WAV** (48kHz/16-bit/stereo PCM) plus a complete-metadata sidecar **JSON** per track. Parallel convert / poll / download with rate-limit backoff. |

## Pipeline

```
(generate prompts.json — by hand, or a prompt-design skill)
        │
        ▼
/suno-toolkits:suno-submit  <folder>      ─ creates workspace, runs the Suno create form
        │
   (wait ~1-3 min/song for Suno to render)
        │
        ▼
/suno-toolkits:suno-download  <workspace> ─ pulls WAV + metadata JSON to disk
```

## Requirements

- **Chrome with the Claude extension** ("Claude in Chrome") installed.
- **Claude Code launched with `--chrome`** — `claude --chrome`. This connects Claude Code to the extension; without it the skills cannot drive the browser at all.
- Logged in to **suno.com** in that Chrome, on a **paid plan** (WAV export and v5/v5.5 models require it). Both skills depend on your logged-in session — Suno has no public API and your songs are private, so the auth from your browser session is mandatory (the same way the official-style exporter extensions work).
- No Suno tab needs to be open — the skills navigate there themselves.

## How it works

Suno has no public API. Both skills call Suno's internal `studio-api` from inside the logged-in browser tab (auth via the page's Clerk session token), and use real UI interaction only where there is no API (the create form, the custom slider components).

The Claude-in-Chrome tool channel can't carry bulk data — it truncates long string values (~1KB) and deep objects, blocks base64, and is size-limited. So each kind of data takes the right path:

- **WAV files** — downloaded with `curl` from the public Suno CDN, 8-way parallel. The bytes never touch the tool channel.
- **Sidecar metadata** — exported as **one browser file download**, then split into per-clip JSON by a single inline `node` command. The download bypasses the tool channel entirely.
- **`studio-api` calls** (list / convert / poll) — run through a concurrency pool (≤5 requests in flight) with `429` exponential backoff, to stay under Suno's rate limits.

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

`null` = use Suno's default (model → v5.5; weirdness / style_influence → 50). `suno-submit` strips a leading `NO ` from each `negative_tags` item, since Suno's Exclude field wants bare tags.

## Local testing

This is a plugin folder. To load it during development, start Claude Code with **both** flags —
`--chrome` (so the skills can drive the browser) and `--plugin-dir` (so the plugin loads):

```bash
claude --chrome --plugin-dir D:\ulovemusic\suno-toolkits
```

Skills are then available as `/suno-toolkits:suno-submit` and `/suno-toolkits:suno-download`.
After editing a `SKILL.md`, run `/reload-plugins` — no restart needed.

> Omit `--chrome` and the skills load but can't operate Chrome. Omit `--plugin-dir` and the skills aren't loaded at all. Local testing needs both.
>
> `/reload-plugins` shows the **plugin** version (`.claude-plugin/plugin.json`). Bump that on each meaningful change so the reload gives a visible confirmation — the per-skill `version` in each `SKILL.md` is separate and does not show there.

## Status

- **Plugin `0.3.0`** — pre-1.0, still iterating.
- **`suno-download` v1.3.0** — verified end-to-end against a real Suno Pro account: 30 songs (973 MB WAV + 30 sidecar JSON) in ~8 minutes, zero failures.
- **`suno-submit` v1.0.0** — verified with a single-prompt test (workspace create/switch, Advanced form fill, Weirdness/Style Influence sliders landing exactly).

Roadmap: full submit→download pipeline test, standalone marketplace listing, a `prompts.json` JSON Schema, and future skills (`suno-extend`, `suno-stems`, `suno-cleanup`).
