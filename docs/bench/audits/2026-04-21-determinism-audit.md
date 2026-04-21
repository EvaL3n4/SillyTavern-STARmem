# Determinism Audit — 2026-04-21

Ran before Task 2 of sub-phase 9.4.5 to confirm the `randomSuffix` fix is sufficient.

## Randomness sources in `src/`

| File:Line | Call | Classification | Action |
|---|---|---|---|
| `src/memory/entry.js:23` | `Math.random()` → entry id suffix | **Contaminating** — embedded in `entry.id`, keys every state map, drives dedup / edge build | Fixed in Task 2 |

Exactly one hit, matching the preliminary diagnosis from `docs/bench/sweeps/2026-04-21-smoke-live.md` §Verdict.

## Time sources in write-path code

Scan: `grep -rn "new Date()\|Date\.now()" src/ --include='*.js' | grep -v "// " | grep -v "opts\.now\|= now ??"`

| File:Line | Call | Classification | Action |
|---|---|---|---|
| `src/retrieval/ladder.js:139` | `opts.now ?? new Date()` | Retrieval (read path); no state mutation | Deferred |
| `src/memory/entry.js:34` | `now = new Date()` default param | Consolidated into Task 2 (signature change makes `now` required) | Fixed in Task 2 |
| `src/lifecycle/importance.js:55` | `now = new Date()` default param | Called from `consolidate.js` with an injected `clock`; default only fires when callers omit — no production path omits | Deferred |
| `src/consolidation/extractFacts.js:56,198` | `now = new Date()` fallback | Same pattern — seeder/consolidate always inject; the default is defensive only | Deferred |
| `src/consolidation/personaRebuild.js:100` | `Date.now()` → `startTime` | Transient — local, consumed only by the duration metric at line 230 | Deferred |
| `src/consolidation/personaRebuild.js:129` | `Date.now()` inside `collectionId` | See classification below | Deferred |
| `src/consolidation/personaRebuild.js:230` | `Date.now() - startTime` | Transient duration metric, not persisted | Deferred |
| `src/integration/bootstrap.js:72,166` | `new Date()` | App-startup bootstrap, runs inside SillyTavern — not in bench path | Deferred |
| `src/integration/interceptor.js:108` | `new Date().toISOString()` | ST-side message metadata (`send_date`), user-facing; out of STARmem state | Deferred |
| `src/integration/interceptor.js:156` | `retrieve(state, query, { now: new Date() })` | Read path; no state mutation | Deferred |
| `src/integration/viewer/tabs/episodic.js:71` | `const now = new Date()` | UI render-time computation, not persisted | Deferred |
| `src/integration/viewer/tabs/persona.js:161` | `now: new Date()` | UI render-time, not persisted | Deferred |
| `src/integration/viewer/tabs/traces.js:61` | `new Date().toISOString()` | Export filename, user-facing artifact, not persisted in state | Deferred |

## `personaRebuild.js:129` collectionId classification

Line 129 builds `collectionId = \`starmem:${chatId}:${subject}:persona-rebuild:${depth}:${Date.now()}\`` and passes it to `buildKnnGraph(currentLeaves, depth, collectionId, signal)` at line 131.

Trace in `src/consolidation/raptor/knn.js`:
- Line 95: `await createCollection(collectionId)` — creates a transient vector store
- Line 97: `await insertChunks(collectionId, leaves.map(...))` — populates it
- Line 107: `await queryKNN(collectionId, leaf.text, k + 1)` — reads from it
- Line 138: `try { await purgeCollection(collectionId); } catch { /* swallow */ }` — **purges in finally**

The `collectionId` is a transient key for an external vector store; the rebuild creates → fills → queries → purges within a single `buildKnnGraph` call. It never lands in `state.entries`, `state.persona`, `state.graph`, or anywhere `persistState` would serialize.

`grep -rn "collectionId" src/ tests/` confirms: the only consumers are `embeddings.js` (the vector-store client), `knn.js` (the rebuild driver), and `personaRebuild.js` (the caller). No persistence layer touches it.

**Classification: transient. Deferred. Does not contaminate stateHash.**

## Summary

Exactly one contaminating source identified: `src/memory/entry.js:23`. Task 2 proceeds with a single-file fix. The `personaRebuild.js:129` `Date.now()` usage is transient (purged same-call) and safely deferred.

No amendment to Task 2 scope.
