# 2026-04-24 — Fireworks Batch Warmup Smoke

**Submission:** `starmem-20260424-1a2a67`
**Scope:** 1 item (LongMemEval-S item[0]), 1 batch, `STARMEM_FIREWORKS_SMOKE_LIMIT=1`
**Extractor:** `accounts/fireworks/models/llama-v3p3-70b-instruct`
**Wall-clock:** ~9 min on Fireworks (submit → COMPLETED)
**Cost:** under $0.01 (dashboard pending)
**Outcome:** ✅ Task 5 done-when criteria met.

## Pipeline verification

| Check | Expected | Observed |
|---|---|---|
| submission reaches `state=ingested` | yes | yes |
| cache file written under `bench/.cache/extractions/` | 1 | 1 |
| `custom_id` in Fireworks output == `_cacheKey(...)` locally | match | match (`1c516a5f...59103`) |
| `wrapWithCache(inner).read()` hits on-disk file, inner not called | yes | yes |
| returned response byte-identical to on-disk `.response` | yes | yes |
| response JSON-parses with `entries: [...]` shape | yes | yes |
| `entries.length >= 1` (reasoning-model trap guard) | ≥ 1 | 6 |
| every entry has non-empty `content` string | yes | yes |
| every choice's `finish_reason` | `stop` | `stop` |
| on-disk JSON key insertion order | `[model, maxTokens, response, at]` | match |

All Design A byte-compat invariants proven against the ingested Fireworks
output.

## Extraction quality spot-check

Item 0 has 5 non-empty turns spanning fox/chicken/grain puzzle +
Fitbit-Inspire fitness conversation + yoga-for-sleep. Llama 3.3 70B
produced 6 durable facts, correctly partitioned across subjects (`null` for
puzzle content, `"user"` for personal facts) and tagged (`puzzle+logic`,
`puzzle+solution`, `fitness+tracker`, `fitness+workouts`, `fitness+tips`,
`yoga+sleep`). No extraction hallucinations, no reasoning-token budget
exhaustion.

## Fireworks doc-vs-reality drift caught on this smoke

The Fireworks Batch Inference API documentation diverged from reality in
six places. Each correction is committed; the full list is preserved here
for the Task 8 retro's skill patch:

| # | Drift | Symptom | Commit |
|---|---|---|---|
| 1 | `example_count` required on dataset create | 400 `example_count is required for uploaded datasets` | `b403974` |
| 2 | `example_count` nests under `dataset`, not top-level | 400 `unknown field "example_count"` at top | `b403974` |
| 3 | snake_case on the wire despite camelCase OpenAPI docs — affects `example_count`, `input_dataset_id`, `output_dataset_id`, `continue_from`, `inference_parameters` | 400 `unknown field "exampleCount"` then `"example_count"` (placement-fix + naming fix) | `7125fa4` |
| 4 | Batch job state returned as proto enum `JOB_STATE_COMPLETED`, not bare `COMPLETED` | poll loop stuck indefinitely after job completion | `b851e74` |
| 5 | `GET :getDownloadEndpoint` rejects body per fetch spec (Node undici ≥21), curl's `-d` silently promotes to POST | `Request with GET/HEAD method cannot have body` after 4 retries | `10dcc11` |
| 6 | Results filename is `BIJOutputSet.jsonl` + `error-data`, not `results.jsonl` + `errors.jsonl`; keys path-prefixed with `dataset/<id>/` | `no results file found in download endpoint response` | `543d4d5` |
| 7 | Per-row output is flat `{custom_id, response: {choices, usage, ...}}`, NOT the OpenAI Batch `{custom_id, response: {status_code, body: {choices}}}` wrapper | `status_code=undefined` on every ingested row | `cac9e53` |

Total: 6 Fireworks doc-vs-reality gaps + 1 OpenAI-vs-Fireworks wrapper
confusion the subagent inherited from the task-planning context.

## Design invariants that held

The manifest state machine recovered cleanly from every failure:

- `state=enumerated` across 3 iterations of `createDataset` 400s
- `state=polling` survived the "never transitions" bug (9 minutes stuck)
- `state=completed` survived two ingest failures
- Zero Fireworks spend wasted to rework; zero cache corruption; zero
  resubmissions required

Task 4's atomic `writeManifest` (temp + rename) and the `resume`
subcommand's state-based dispatch both earned their weight.

## Done-when checklist (Task 5)

- [x] Smoke submission completes state=ingested
- [x] Cache file has `entries | length ≥ 1` (observed: 6)
- [x] Content sanity check passes (subjects, tags, finish_reason, JSON validity)
- [x] Byte-compat regression check passes (wrapWithCache read hit on local file)
- [x] Audit note committed

## Handoff to Task 6

Fixes carried forward — every Task 6 dispatch benefits from commits
`b403974` through `cac9e53`. No outstanding known bugs in
`bench/harness/warmup/` or `bench/harness/fireworks-warmup.js`.

Task 6 expected shape: ~10,800 batches across LongMemEval-S (500 items)
+ LoCoMo (10 convs). Wall-clock forecast ~2–6h. Cost forecast $5–8. Any
per-batch anomaly >= $0.001 at scale would be the canary — dashboard
check at the 30-minute mark.

Tasks 1–5 shipped across 14 commits from `00b6845` (plan) to `cac9e53`
(final Task 5 bug fix). Seven of those were post-dispatch API-alignment
fixes against the Fireworks + Node-fetch surface; seven were
infrastructure landings from the TDD tasks themselves.
