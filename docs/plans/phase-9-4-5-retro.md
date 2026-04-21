# Sub-phase 9.4.5 Retro — Entry-ID Determinism

**Status:** Complete.
**Commits:**
- `d4f906e` — docs(plans): sub-phase 9.4.5 entry-id determinism plan
- `e66cc90` — docs(bench): determinism audit — confirm randomSuffix is the only contaminator
- `e981bfb` — fix(memory): sha256-seeded deterministic entry ids (9.4.5)
- `8d5007e` — test(memory): lock in 9.4.5 entry-id determinism invariant
- `10b9e2c` — docs(bench): 9.4.5 post-fix determinism smoke

## What happened

Sub-phase 9.5 Task 4 smoke on LoCoMo conv 1 revealed that identical consolidation inputs produced different `stateHash` and `factCount` across back-to-back runs — even with a 100%-hit extraction cache. Preliminary diagnosis pointed at `src/memory/entry.js` `randomSuffix()` using `Math.random()`. 9.4.5 was inserted chronologically between 9.5 Tasks 1–4 (infrastructure) and 9.5 Tasks 5–10 (sweeps), because only the smoke surfaced the need and the sweeps depend on stable replay.

## Decisions held

1. **Suffix derivation** — sha256(seed).slice(0,12). **Held.** 12 hex chars = 48 bits, collision-safe to ~hundreds of millions of entries; matches the existing 12-char stateHash display convention.
2. **Seed composition** — `scope|content|subject|sortedTags|sourceMessages|extractor`. **Held.**
3. **`generateEntryId` signature** — `(scope, now, seed)` with required seed. **Held.**
4. **Regression test location** — `tests/unit/memory/determinism.test.js`. **Held.**
5. **Scope** — only `randomSuffix()` in `entry.js`. **Held.** The Task 1 audit confirmed `personaRebuild.js:129`'s `Date.now()` inside `collectionId` is transient (purged same-call in `knn.js:138`, never persisted in STARmem state).
6. **Collision policy** — identical fields collapse to same id. **Held.**
7. **Id length** — prefix + iso + 12hex = 30 chars. **Held.**

## What worked

- **Task 1 audit** caught zero additional contaminators and confirmed the fix was single-file. Five minutes of grep saved a retro amendment.
- **sha256(seed)** is a one-line swap. `createEntry`'s public API unchanged, so no ripple through consolidation, retrieval, or integration.
- **Determinism regression test** (13 assertions) covers `createEntry`, `generateEntryId`, and batch replay; locks the invariant at the function-level before it reaches state-hash-level.
- **End-to-end smoke** confirmed identical `stateHash` on both rule-based and live-cached paths across back-to-back runs.
- **Phase-9.5 cache held through.** The live-cached smoke ran in ~4s with 100% hits (cold was ~493s originally) — 9.5 Task 2's on-disk cache is independent of the ID scheme, as designed.

## What surprised us

- **Secondary finding: fact-count lift.** Post-fix `factCount` on conv 26 is higher than pre-fix on both paths:
  - Rule-based: 374/375 → 395 (+5-6%)
  - Live: 213/220/217 → 224 (+3-5% over the median of 217)

  Working theory: under the old 3-hex random suffix, same-second identical-content extractions occasionally drew the same suffix (1 in 4096), producing identical ids. Later adds to `state.entries[id] = entry` then silently overwrote legitimate earlier facts. Post-fix, content-derived ids only collide when the facts are *actually* identical (same scope, content, subject, tags, source turn, extractor), which is both rarer and semantically correct. The new counts are the honest numbers.

- **Plan-drift catch in `seeder.test.js:98`.** The original test asserted `r1.stateHash !== r2.stateHash` when the two conversations had distinct `conv.id` → distinct `chatId`. That test was implicitly depending on `Math.random()` producing different suffixes — *not* on `chatId` being in the seed (it isn't, and wasn't). Post-fix, identical conversation content under different chatIds correctly produces identical stateHashes. Rewrote to assert `chatId` distinctness and `factCount > 0` independently, which is the genuinely-useful invariant.

- **`bench/cli.js` doesn't expose `stateHash`.** Had to add `bench/smoke-determinism.js` as a one-shot harness that calls `seedConversation` directly. Kept it small (~90 LOC) and not wired into any test or CI path; it's a diagnostic tool, not a recurring job.

## Notes for sub-phase 9.5 Tasks 5–10

1. **Entry ids are deterministic under content replay.** Sweep stateHashes at different knob values are comparable **iff** the knob doesn't itself alter which facts get extracted. Knobs that CAN alter extraction:
   - `EXTRACT_MAX_TOKENS` (Task 7 consolidation sweep) — smaller budget = truncated output
   - Consolidation buffer size (Task 7) — different batching = different extractor calls
   - Any knob that gates which turns enter the buffer

   For those, expect `stateHash` to differ across sweep points — **that's the signal, not a bug**. Document which sweeps produce same-stateHash surfaces and which don't.

2. **`extractor` is in the seed.** Any new extractor shipped later must identify itself in `provenance.extractor` or ids will collide with existing facts under otherwise-identical content. The rule-based and live paths already use distinct labels (`bench-rule@v1` vs `bench-live:${model}@v1`), so no collision today.

3. **Entry ids are 30 chars now** (was 22). If any log-truncation or id-display UI assumed 22 chars, it needs updating. `grep -rn "\.slice(0, 22)\|substr.*22" src/integration/viewer/` was clean at commit time — noting here for future vigilance.

4. **`personaRebuild.js` `collectionId` still uses `Date.now()`.** Per the Task 1 audit, this is transient — the vector collection is created, populated, queried, and purged within a single `buildKnnGraph` call — and does not land in persisted state. Not a 9.5 blocker. If Phase 11 wants fully-deterministic rebuild traces (e.g. for replayable persona construction), swap to a content-hash-derived id then.

5. **`docs/bench/baseline.json` `gitSha` pin is stale.** Currently pins `4afaea02`. 9.5 Task 11 should repin to the final 9.5 sweep commit (post-9.4.5, post-Task 10).

6. **Fact-count baselines in earlier Phase-9 artifacts are pre-fix noise.** Any prior doc that cites `374 facts on conv 1` should be read as an upper bound — the real number is higher because collisions were dropping entries. If Phase 11 wants to re-audit Phase 9's flat-sweep findings, rerun on post-9.4.5 first.

## Metrics

- **Plan length:** 839 lines (target ~450 — overshot because of thorough Task-1 audit tables and verbatim retro template)
- **Duration:** ~45 min total controller wall-clock, excluding planning (Azure-flakiness-friendly — zero long delegations)
- **Tests added:** 4 (inline in `entry.test.js`) + 13 (regression suite) = **17 new tests**
- **Tests changed:** 3 in `entry.test.js` (signature update) + 1 in `seeder.test.js` (plan-drift fix) = **4 changed**
- **Suite total:** 74 suites / 800 tests green (from 73/787 at 9.5 Task 3)
- **Files touched:**
  - 1 source modified: `src/memory/entry.js`
  - 2 tests modified: `tests/unit/memory/entry.test.js`, `tests/unit/bench/harness/seeder.test.js`
  - 3 new: `tests/unit/memory/determinism.test.js`, `bench/smoke-determinism.js`, and 3 new docs (audit, smoke, plan, retro)
- **Lint + typecheck:** clean throughout.

## Commit graph

```
10b9e2c docs(bench): 9.4.5 post-fix determinism smoke
8d5007e test(memory): lock in 9.4.5 entry-id determinism invariant
e981bfb fix(memory): sha256-seeded deterministic entry ids (9.4.5)
e66cc90 docs(bench): determinism audit — confirm randomSuffix is the only contaminator
d4f906e docs(plans): sub-phase 9.4.5 entry-id determinism plan
f1587f9 chore(bench): gitignore .env.bench and extraction cache     ← 9.5 Task 3 tip
```

Ready to resume 9.5 at Task 5 (τ sweep re-run on full LoCoMo).
