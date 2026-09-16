# CLAUDE.md

Guidance for Claude Code working in this repo.

## What this repo is for

`suno-toolkits` automates Suno AI from Claude Code: batch-submit `prompts.json` files, then download the results as lossless WAV + metadata sidecars.

## The design rule: keep the model out of the loop

**Every skill here is a script you launch, not a procedure you perform.** The model's job is to prepare arguments, launch one Node process, and report from its result file. That is the entire reason this repo exists.

| Task | Scripted | Model-driven |
|---|---|---|
| Submit 36 prompts | ~4 model turns | ~110 |
| Download a 60-clip workspace | ~2 model turns | ~25 |

Roughly **a fifteenth of the tokens for identical work**, because a turn-by-turn UI loop re-sends the whole conversation on every click.

So: **never step through Suno's UI by hand because it feels more controllable.** It is not more reliable either — the model-driven path has never survived a Suno redesign; it just fails less visibly. The worst recorded case pasted a full lyric into the Styles box, reported success, and spent a generation on garbage. A script that throws `no "Exclude styles" anchor` is the safer failure.

`references/path-b.md` documents the Claude-in-Chrome loop as a **fallback**, for three cases only:
- a prompt sets `audio_reference` (the script refuses those — the Browse/Remix modal is not automated)
- the script is broken by a UI change and a batch is urgent
- the user explicitly asks to watch it step by step

Reaching for Path B for any other reason is a bug in your judgement, not a preference.

## Check the environment before spending anything

In order, before any run that costs credits or minutes:

1. **First use on a machine** — `npm install && npx playwright install chrome`.
2. **`--doctor`** — ~15s, opens Chrome, probes every selector, creates nothing. If it reports `sign-in required (no TTY)` you *cannot* fix it from the Bash tool: give the user the exact `--login` command and ask them to run it with a `!` prefix.
3. **`--dry-run`** on an unfamiliar batch — fills and verifies the entire form, stops short of Create. Costs nothing.

Only then submit. A failed `--doctor` means Suno's UI drifted: the runner writes `_submit_failure_<ts>.json` + `.png` containing the full current form shape, which is enough to repair the selector **without a second browser run**.

## Tests

`npm test` — `node:test`, zero dependencies, runs in about a second.

Covers `skills/suno-submit/scripts/lib/queue-core.mjs`, the pure logic (title construction, `NO ` stripping, `--only` resolution tiers, `resolveModel`). That file is small but it is where silent regressions land — a model shorthand missing from `resolveModel` downgrades the batch to v5.5 **without failing**. Add a test with any change there, and when Suno ships a new model, add it to the known list *and* to the test.

The browser-driving scripts are deliberately not unit-tested; `--doctor` and `--dry-run` are their live smoke tests.

## Conventions

- **Never `git add -A` or `git add .`** — this checkout is often shared with another session working in it. Stage explicit paths only. (Broad globs have twice swept another session's uncommitted work, and once moved `package.json` out of the repo.)
- `--out` on `download.mjs` **defaults to the current directory**. Always pass it explicitly.
- Bump `version` in `.claude-plugin/plugin.json` per change — that is the number `/reload-plugins` shows.
- The Chrome profile lives outside the repo on purpose: it holds real credentials. Never point `--profile` inside a checkout, and never commit one.
