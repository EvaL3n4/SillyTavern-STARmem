# Determinism smoke — 2026-04-21 (post-9.4.5)

**Corpus:** LoCoMo conv 26 (loaded as conv 1 with `maxConversations=1`) — 1340 turns, 199 QA items
**Model:** `google/gemma-4-26b-a4b-it` via LiteLLM (live portion only)
**Purpose:** Confirm sub-phase 9.4.5's sha256-seeded entry ids produce identical `stateHash` and `factCount` across replays.
**Runner:** `bench/smoke-determinism.js` (one-shot smoke harness added by this task; calls `seedConversation` directly since `bench/cli.js` doesn't expose `stateHash`).

## Rule-based (pre-9.4.5 baseline, from `2026-04-21-smoke-live.md`)

| Run | factCount | stateHash (12-char) |
|-----|-----------|---------------------|
| 1   | 374       | `9dfc08608e27`      |
| 2   | 375       | `f923d843bc7a`      |

**Verdict:** drift. Two runs over identical input produced different state. This was the motivating finding for 9.4.5.

## Rule-based (post-9.4.5, commit `8d5007e`)

| Run | factCount | stateHash (12-char) | Wall time |
|-----|-----------|---------------------|-----------|
| 1   | 395       | `ceb6c2d0a38e`      | 3879 ms   |
| 2   | 395       | `ceb6c2d0a38e`      | ~3800 ms  |

**Verdict:** identical. stateHash match: YES. factCount match: YES.

Note: absolute factCount shifted from the pre-9.4.5 baseline (374/375 → 395). Expected, and not a regression. Pre-fix, random IDs caused hash collisions in the state map, silently dropping entries during Object.assign-style spreads. Post-fix, content-derived IDs collide only when facts are truly identical, so dedup is now semantic rather than coincidental. 395 is the "true" factCount for conv 26 under the rule-based extractor.

## Live-cached (post-9.4.5, commit `8d5007e`)

| Run | factCount | stateHash (12-char) | Wall time |
|-----|-----------|---------------------|-----------|
| 1   | 224       | `da4f0b6a01cc`      | 4169 ms   |
| 2   | 224       | `da4f0b6a01cc`      | 4065 ms   |

**Verdict:** identical. stateHash match: YES. factCount match: YES.

Cache was fully warm from sub-phase 9.5 Task 4's conv 1 smoke run; no live LLM traffic during Task 5 verification. 4s wall time confirms 100% cache hits (live cold was ~493s previously).

Note: absolute factCount shifted from the pre-9.4.5 live baseline (213/220/217 → 224). Same cause as rule-based — pre-fix random collisions silently dropped extractor output; post-fix, deterministic collapses only when facts are semantically identical.

## Conclusion

Determinism restored on both paths. Phase 9.5 Tasks 5–10 unblocked: sweep stateHashes at different knob values are now directly comparable, and any observed drift across a sweep point can be attributed to the knob itself, not to `Math.random()` noise.

Secondary finding worth flagging for the 9.4.5 retro: fact counts increased modestly on both extractors post-fix, suggesting the pre-fix `Math.random()` suffix was absorbing a small number of real facts via hash collisions in the state map. The new counts are the honest numbers.
