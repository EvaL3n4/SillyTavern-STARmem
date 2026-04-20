# STARmem—repository notes for AI assistants

This is **STARmem v2**, a clean-break rewrite. If you were trained on or have seen v1 (`SillyTavern-STARmem` at `/home/opus/SillyTavern/...`), forget its architecture—this is a different project.

## Start here

1. **Read the spec first:** `docs/specs/2026-04-20-starmem-v2-design.md`—it is approved and authoritative.
2. **Wiki for paper references:** `docs/wiki/`—per-paper notes with our adaptation/rejection rationale.
3. **Implementation plan:** `docs/plans/`—when present, execute task-by-task.

## Core rules (from spec §2)

1. **Deterministic retrieval, always.** No LLM call on the query path. Ever.
2. **One path per responsibility.** One extraction function, one consolidation function, one retrieval ladder, one write lock. Many readers, single mutator.
3. **Honest instrumentation.** Every retrieval produces a replayable trace. Benchmarks are a v2.0 subsystem, not an afterthought.

## What exists right now

Scaffold only. Manifest, package.json, gitignore, README, license, index.js stub, style.css stub, this file. `src/` and `tests/` do not exist yet—they'll be created by the implementation plan.

## How SillyTavern loads this extension (critical)

**SillyTavern installs extensions via `git clone` only.** The user clones this repo into `public/scripts/extensions/third-party/SillyTavern-STARmem/` and ST loads `index.js` directly in the browser. **There is no build step. There is no `npm install` at install time.**

This means:

- **`package.json` is development-only.** `eslint`, `jest`, `typescript`, and anything in `devDependencies` exist solely for lint/typecheck/test at development time. **They are not available at runtime.**
- **`dependencies` must stay empty** (or at most contain libraries we've bundled into a single file via rollup and committed — we have not opted into this yet).
- **Runtime code (`index.js`, `src/**/*.js`) cannot `import` from `node_modules`.** Only valid imports are: relative paths inside this repo (`./src/...`), and SillyTavern's own exposed modules (`../../../../script.js`, `../../../extensions.js`, etc.).
- **No transpilation.** The code that runs in the browser is the code in the repo, as-is. Target: modern ES2022 modules, no TypeScript emit, no Babel.

If you find yourself wanting to `npm install <runtime-lib>`, stop. Either find a pure-JS implementation to vendor in `src/vendor/`, or implement it yourself. BM25, Jaccard, graph traversal, Leiden clustering—all of it gets hand-written in vanilla JS.

## Conventions

- **Internal identifier:** `STARmem` (capital STAR). Used in `chatMetadata['STARmem']`, `STARmemInterceptor`, etc. The package name (`starmem`) and repo slug (`SillyTavern-STARmem`) are the only lowercased exceptions—npm convention and ST naming convention.
- **Scope tags on entries:** `working | episodic | persona`. The graph is infrastructure, not a scope.
- **Edge types:** `mentions | supports | same_topic | temporal_next`. `contradicts` is reserved but not produced in v2.0.
- **Latency budgets live in the spec.** Tier 0 <1ms, Tier 1 <5ms, Tier 2 <50ms, Tier 3 <100ms, Floor <5ms.

## What NOT to do

- **Do not add embeddings or vector search.** The entire project is deterministic BM25 + typed graph. If you think you need embeddings somewhere, you don't.
- **Do not add LLM calls to the retrieval path.** Not even as a "fallback tier." Rejected by design.
- **Do not add consolidation triggers beyond the one rule** (buffer ≥ 10 or idle ≥ 60s). v1 had four. We collapsed them. Don't un-collapse.
- **Do not write migration code from v1.** Clean break. See spec §11.
- **Do not add a setup wizard, health checks, or debug console.** Explicitly cut in spec §8.
