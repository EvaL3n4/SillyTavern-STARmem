# STARmem Sub-phase 9.4.7 — Ladder Inversion Diagnosis Implementation Plan

> **For Hermes:** Use subagent-driven-development skill to implement this plan task-by-task.

**Goal:** Diagnose why the retrieval ladder's MRR (0.1118) is 0.58 below bm25only (0.6909) and 0.19 below random (0.3028) on LoCoMo-10, identify the single inversion stage, and apply a narrow fix if the root cause is one scorer / one stage. If multi-file structural, retro with findings and escalate to Phase 11.

**Architecture:** Diagnostic-first sub-phase. Task 1 instruments per-candidate factor logging in `src/retrieval/tier2-bm25.js`. Task 2 runs a 10–20 query diff-audit comparing ladder vs bm25only rank orders, producing a markdown audit doc. A hard decision gate (controller call) determines whether the finding is narrow-fixable. Task 3 applies the conditional fix. Task 4 adds a regression test. Task 5 retro documents findings and hands off sweep refresh to 9.4.8.

**Tech Stack:** Node.js ES modules, Jest, vanilla JS. No new dependencies.

**Decisions locked before writing this plan (see `/tmp/9-4-7-9-4-8-locked-decisions.md` and conversation 2026-04-22):**

1. **9.4.7 is diagnostic-first with a hard decision gate.** Instrument → diff-audit → gate → narrow fix (conditional) → regression test → retro. NO sweep re-run in 9.4.7.
2. **Day-budget enforcement on 9.4.7:** if diagnostic + fix doesn't close in ~90 min of controller work, retro 9.4.7 with findings and open Phase 11. 9.4.8 ships regardless.
3. **Fix scope (if conditional fires):** narrow — the one inversion stage. No scorer-chain rewrite in 9.4.7.
4. **9.4.8 ships regardless of 9.4.7 verdict.** Even if 9.4.7 escalates to Phase 11, the Modal substrate is reusable infra Phase 11 will need.
5. **Three hypothesis candidates for Task 1 instrumentation (from locked decisions):**
   - **H1 (recency dominance):** `recencyAt(now, createdAt)` has large dynamic range (exponential decay, τ = 30 days, half-life ≈ 21 days) and dominates BM25 ordering. LoCoMo QAs span many sessions; older gold entries get crushed by recency boost on newer distractors.
   - **H2 (maturity compression):** `maturityBoost` returns `{draft: 0.85, validated: 1.0, core: 1.2}` (from `LIFECYCLE.MATURITY_BOOST` in `src/core/constants.js`). Draft entries take a 15% score penalty vs validated and a 29% penalty vs core. In LoCoMo, newly-extracted entries start as `draft`; if gold entries skew draft while distractors skew validated/core, the rank-order shifts systematically in favor of older, higher-tier entries. Note: `maturityBoost` never returns 0, so the `.filter(r => r.score > 0)` at `tier2-bm25.js:57` only drops `bm25 === 0` entries — H2 is a compression effect, not a zeroing effect.
   - **H3 (pool mismatch):** Candidate-pool mismatch. `tier2-bm25.js:37-39` filters `scope !== 'working'` before scoring; `bench/baselines/bm25only.js:23` uses `Object.values(state.entries)` unfiltered. Not the scorer's fault — different pools before ranking.
6. **Instrumentation target:** per query, per tier-2 candidate: `entry.id, bm25, importance, recencyFactor, maturityFactor, finalScore`.
7. **Regression test location:** `tests/unit/retrieval/` if fix touches `src/retrieval/` code; `tests/unit/bench/` if fix touches `bench/` code. Decision deferred to Task 3 based on gate verdict.
8. **Retro MUST hand off sweep refresh to 9.4.8** with explicit validation checklist.

---

## Task 0: Commit the plan

**Objective:** Stabilize the plan reference for subagents and future sessions.

**Files:**
- Create: `docs/plans/phase-9-4-7-ladder-diagnosis.md`

**Step 1: Verify plan exists**

Run: `ls -la docs/plans/phase-9-4-7-ladder-diagnosis.md`
Expected: file exists with non-zero size.

**Step 2: Commit**

```bash
git add docs/plans/phase-9-4-7-ladder-diagnosis.md
git commit -m "docs(plans): sub-phase 9.4.7 ladder inversion diagnosis plan"
```

---

## Task 1: Instrument tier scores in tier2-bm25.js

**Objective:** Add per-candidate factor decomposition to the Tier-2 scoring path so Task 2 can distinguish H1 (recency dominance), H2 (maturity zeroing), and H3 (pool mismatch) from the actual rank-order inversion.

**Files:**
- Modify: `src/retrieval/tier2-bm25.js`
- Test: `tests/unit/retrieval/tier2-bm25.test.js`

**Context:** The default scorer at `src/retrieval/scorer.js:41-49` computes:

```js
bm25 * (1 + importance / 100) * recencyAt(now, createdAt) * maturityBoost(maturity)
```

The `tier2` function applies this scorer to every BM25 result, filters `score > 0`, and sorts descending. We need to expose the four factor values (bm25, importanceFactor, recencyFactor, maturityFactor) alongside the final score for diagnostic queries without changing the production return shape.

**Step 1: Write failing test for diagnostic factor exposure**

Add to `tests/unit/retrieval/tier2-bm25.test.js` (append after the last test):

```js
test('diagnostic mode exposes per-candidate factor breakdown', () => {
    const s = state([
        ep('a', 'alice marseille', 'alice', ['location'], {
            lifecycle: { importance: 50, maturity: 'validated', createdAt: new Date('2026-04-20T12:00:00Z') },
        }),
        ep('b', 'bob paris', 'bob', ['location'], {
            lifecycle: { importance: 10, maturity: 'draft', createdAt: new Date('2026-04-19T12:00:00Z') },
        }),
    ]);
    const r = tier2(s, 'alice marseille', { now, intent: 'factual', diagnostic: true });
    expect(r.scored.length).toBeGreaterThanOrEqual(1);
    const first = r.scored[0];
    expect(first.factors).toBeDefined();
    expect(typeof first.factors.bm25).toBe('number');
    expect(typeof first.factors.importance).toBe('number');
    expect(typeof first.factors.recencyFactor).toBe('number');
    expect(typeof first.factors.maturityFactor).toBe('number');
    expect(typeof first.factors.importanceFactor).toBe('number');
    expect(typeof first.score).toBe('number');
    // Score should equal the product of factors
    const expectedScore = first.factors.bm25
        * first.factors.importanceFactor
        * first.factors.recencyFactor
        * first.factors.maturityFactor;
    expect(first.score).toBeCloseTo(expectedScore, 10);
});
```

**Step 2: Run test to verify failure**

Run: `npm test -- tests/unit/retrieval/tier2-bm25.test.js -t "diagnostic mode exposes"`
Expected: FAIL — `Cannot read properties of undefined (reading 'bm25')` or similar because `factors` is undefined.

**Step 3: Implement diagnostic factor decomposition in tier2**

Modify `src/retrieval/tier2-bm25.js`:

1. Add imports at the top (after existing imports):

```js
import { recencyAt } from '../lifecycle/recency.js';
import { maturityBoost } from '../lifecycle/maturity.js';
```

2. Update the `ScoredEntry` typedef to include the optional `factors` field:

```js
/**
 * @typedef {{
 *   entry: import('../core/schema.js').Entry,
 *   bm25: number,
 *   score: number,
 *   factors?: {
 *     bm25: number,
 *     importance: number,
 *     importanceFactor: number,
 *     recencyFactor: number,
 *     maturityFactor: number,
 *   },
 * }} ScoredEntry
 */
```

3. Update the `tier2` function signature to accept `diagnostic`:

```js
export function tier2(state, queryStr, ctx) {
    const { now, intent, k = 10, diagnostic = false } = ctx;
```

4. Replace the scorer application block (lines 51-58) with:

```js
    const scorer = getScorer();
    const scored = raw
        .map(r => {
            const importance = r.entry.lifecycle.importance;
            const importanceFactor = 1 + importance / 100;
            const recencyFactor = recencyAt(now, r.entry.lifecycle.createdAt);
            const maturityFactor = maturityBoost(r.entry.lifecycle.maturity);
            const score = r.bm25 * importanceFactor * recencyFactor * maturityFactor;
            /** @type {ScoredEntry} */
            const out = {
                entry: r.entry,
                bm25: r.bm25,
                score,
            };
            if (diagnostic) {
                out.factors = {
                    bm25: r.bm25,
                    importance,
                    importanceFactor,
                    recencyFactor,
                    maturityFactor,
                };
            }
            return out;
        })
        .filter(r => r.score > 0)
        .sort((a, b) => b.score - a.score);
```

**Important:** The score computation above must match the default scorer exactly. Do NOT call `scorer()` here — the default scorer is `(entry, _query, context) => bm25 * (1 + importance/100) * recencyAt(now, createdAt) * maturityBoost(maturity)`. Replicating it inline ensures the diagnostic factors are consistent with the actual score. The `scorer` variable is still fetched for trace correctness (scorerId is recorded elsewhere), but the diagnostic path computes deterministically.

**Step 4: Run test to verify pass**

Run: `npm test -- tests/unit/retrieval/tier2-bm25.test.js -t "diagnostic mode exposes"`
Expected: PASS.

**Step 5: Run full tier2 suite to verify no regressions**

Run: `npm test -- tests/unit/retrieval/tier2-bm25.test.js`
Expected: all 7+ tests PASS.

**Step 6: Commit**

```bash
git add src/retrieval/tier2-bm25.js tests/unit/retrieval/tier2-bm25.test.js
git commit -m "feat(retrieval): diagnostic factor breakdown in tier2 (Task 1)"
```

---

## Task 2: Diff-audit 10–20 queries producing docs/bench/audits/2026-04-22-ladder-inversion.md

**Objective:** Run 10–20 representative QA queries through both the ladder and bm25only baseline on the same seeded state, capture per-candidate factor breakdowns, and produce a markdown audit that identifies which hypothesis (H1/H2/H3) explains the rank-order inversion.

**Files:**
- Create: `bench/diagnose/ladder-inversion.js`
- Create: `docs/bench/audits/2026-04-22-ladder-inversion.md`
- Modify: `bench/diagnose/.gitkeep` (if directory is new)

**Step 1: Create the diagnostic runner script**

Create `bench/diagnose/ladder-inversion.js`:

```js
#!/usr/bin/env node
/**
 * Ladder inversion diagnostic runner.
 *
 * Seeds 1–2 LoCoMo conversations (or the synthetic corpus if LoCoMo is
 * unavailable), replays 10–20 QA queries through both ladder and bm25only,
 * and emits a JSON factor dump for audit rendering.
 *
 * Usage:
 *   node bench/diagnose/ladder-inversion.js [--conversations N] [--out path.json]
 */

import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runHarness } from '../runner.js';
import { bm25only } from '../baselines/bm25only.js';
import { loadLocomo } from '../loaders/index.js';
import { retrieve } from '../../src/retrieval/ladder.js';
import { tier2 } from '../../src/retrieval/tier2-bm25.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function parseArgs() {
    const args = process.argv.slice(2);
    const opts = { conversations: 2, out: '' };
    for (let i = 0; i < args.length; i++) {
        if (args[i] === '--conversations' && args[i + 1]) {
            opts.conversations = parseInt(args[i + 1], 10);
            i++;
        } else if (args[i] === '--out' && args[i + 1]) {
            opts.out = args[i + 1];
            i++;
        }
    }
    return opts;
}

async function main() {
    const opts = parseArgs();
    const corpus = await loadLocomo({ maxConversations: opts.conversations });
    if (corpus.length === 0) {
        console.error('No corpus loaded. Ensure LoCoMo data is available.');
        process.exit(1);
    }

    // Run ladder harness with diagnostic tier2 injection
    const ladderResult = await runHarness({
        corpus,
        retriever: (state, query, opts) => {
            // Inject diagnostic tier2 to capture factor breakdowns
            const origTier2 = tier2;
            // We can't easily intercept tier2 inside retrieve() without monkey-patching,
            // so we run tier2 standalone AFTER retrieve() for the same state/query.
            return retrieve(state, query, opts);
        },
    });

    // Run bm25only baseline on same corpus
    const bm25Result = await runHarness({
        corpus,
        retriever: bm25only,
    });

    // For each run, also run diagnostic tier2 standalone to get factor breakdowns
    const audits = [];
    for (let i = 0; i < ladderResult.runs.length; i++) {
        const ladderRun = ladderResult.runs[i];
        const bm25Run = bm25Result.runs[i];

        // Re-run tier2 in diagnostic mode on the same seeded state
        // Note: we can't easily recover the exact seeded state here without
        // re-seeding. Instead, we capture the tier2 diagnostic from the
        // trace data and bm25only ranking from its run.
        // Simplification: the audit doc will be built from the harness runs
        // plus a separate diagnostic pass.

        audits.push({
            conversationId: ladderRun.conversationId,
            question: ladderRun.qa.question,
            ladderTop10: ladderRun.retrieved.slice(0, 10).map(r => ({
                id: r.id,
                score: r.score,
                tier: r.tier,
            })),
            bm25Top10: bm25Run.retrieved.slice(0, 10).map(r => ({
                id: r.id,
                score: r.score,
            })),
            goldTurns: ladderRun.goldTurns.map(g => g.turnIndex),
        });
    }

    // Diagnostic tier2 pass: re-seed one conversation and run tier2 with diagnostic=true
    // This gives us the factor breakdown for the top candidates.
    const { seedConversation } = await import('../harness/seeder.js');
    const { loadState } = await import('../../src/core/state.js');
    const diagnosticDetails = [];
    for (const conv of corpus.slice(0, opts.conversations)) {
        const seedResult = await seedConversation(conv, { chatIdPrefix: 'diag', keepBackend: true });
        const seededState = await loadState(seedResult.chatId);
        for (const qa of conv.qa.slice(0, 10)) {
            const t2 = tier2(seededState, qa.question, {
                now: new Date(),
                intent: 'factual',
                k: 10,
                diagnostic: true,
            });
            diagnosticDetails.push({
                conversationId: conv.id,
                question: qa.question,
                tier2Top10: t2.scored.slice(0, 10).map(s => ({
                    id: s.entry.id,
                    bm25: s.bm25,
                    score: s.score,
                    factors: s.factors ?? null,
                })),
                goldEvidenceTurns: qa.evidenceTurns,
            });
        }
    }

    const payload = {
        meta: {
            generatedAt: new Date().toISOString(),
            conversations: corpus.length,
            queriesAudited: audits.length,
            nodeVersion: process.version,
        },
        audits,
        diagnosticDetails,
    };

    const outPath = opts.out || path.join(__dirname, '..', '..', 'docs', 'bench', 'audits', 'ladder-inversion-raw.json');
    await mkdir(path.dirname(outPath), { recursive: true });
    await writeFile(outPath, JSON.stringify(payload, null, 2));
    console.log(`Wrote raw audit data to ${outPath}`);
}

main().catch(e => {
    console.error(e);
    process.exit(1);
});
```

**Step 2: Run the diagnostic script**

Run:
```bash
node bench/diagnose/ladder-inversion.js --conversations 2 --out /tmp/ladder-inversion-raw.json
```

Expected: script completes without error, writes JSON file with audit data.

If LoCoMo data is not available locally, fall back to the synthetic corpus:

```bash
node bench/diagnose/ladder-inversion.js --conversations 2 --out /tmp/ladder-inversion-raw.json
# If loadLocomo fails, modify the script temporarily to use synthesizeSyntheticCorpus()
# from bench/baselines.js, or run bench/baselines.js --synthetic and extract runs.
```

**Step 3: Render the markdown audit doc**

Create `docs/bench/audits/2026-04-22-ladder-inversion.md` by analyzing the raw JSON. The subagent should write a Node.js render script or manually construct the markdown. The audit MUST contain:

1. **Executive summary** — which hypothesis (H1/H2/H3 or combination) is supported.
2. **Per-query diff tables** — for each of the 10–20 queries:
   - Ladder top-10 IDs + scores
   - BM25-only top-10 IDs + scores
   - Gold entry position in each (or `MISSING`)
   - Factor breakdown for the gold entry if it appears in tier2 diagnostic top-10
3. **Factor distribution analysis** — histogram or table of:
   - `recencyFactor` range across all tier2 candidates (min, max, p50, p95)
   - `maturityFactor` distribution (how many candidates have 0.85 vs 1.0 vs 1.2)
   - `importanceFactor` range
   - Ratio of `finalScore / bm25` (the "multiplier distortion")
4. **Hypothesis verdict** — explicit call for each:
   - H1: supported / not supported — with evidence (e.g., "gold entry recencyFactor = 0.03 while top-5 distractors average 0.85")
   - H2: supported / not supported — with evidence (e.g., "47% of tier2 candidates are draft with maturityFactor 0.85; gold entry is draft and filtered at `.score > 0`")
   - H3: supported / not supported — with evidence (e.g., "bm25only pool size = 1,247; tier2 pool size = 1,198 (working entries excluded). Gold entry is working-scope in 0/20 queries — pool mismatch does not explain inversion.")
5. **Gate recommendation** — one of:
   - `NARROW_FIX`: single file, single stage, one-scorer change. Recommend which file and what change.
   - `STRUCTURAL`: multi-file or requires scorer-chain redesign. Recommend Phase 11.

A minimal render script (create `bench/diagnose/render-audit.js`):

```js
#!/usr/bin/env node
import { readFile, writeFile } from 'node:fs/promises';

async function main() {
    const raw = JSON.parse(await readFile(process.argv[2] || '/tmp/ladder-inversion-raw.json', 'utf8'));
    const lines = [];
    lines.push('# Ladder Inversion Audit — 2026-04-22');
    lines.push('');
    lines.push(`**Generated:** ${raw.meta.generatedAt}`);
    lines.push(`**Conversations:** ${raw.meta.conversations}`);
    lines.push(`**Queries audited:** ${raw.meta.queriesAudited}`);
    lines.push('');

    // Factor distribution from diagnosticDetails
    const allFactors = [];
    for (const d of raw.diagnosticDetails) {
        for (const t of d.tier2Top10) {
            if (t.factors) allFactors.push(t.factors);
        }
    }
    if (allFactors.length > 0) {
        lines.push('## Factor Distribution (tier2 diagnostic top-10)');
        lines.push('');
        const recencyFactors = allFactors.map(f => f.recencyFactor).sort((a, b) => a - b);
        const maturityFactors = allFactors.map(f => f.maturityFactor);
        const importanceFactors = allFactors.map(f => f.importanceFactor);
        const ratios = allFactors.map(f => (f.recencyFactor * f.maturityFactor * f.importanceFactor));
        lines.push(`| factor | min | p50 | max |`);
        lines.push(`|---|---|---|---|`);
        lines.push(`| recencyFactor | ${recencyFactors[0].toFixed(4)} | ${recencyFactors[Math.floor(recencyFactors.length / 2)].toFixed(4)} | ${recencyFactors[recencyFactors.length - 1].toFixed(4)} |`);
        lines.push(`| maturityFactor | ${Math.min(...maturityFactors).toFixed(2)} | — | ${Math.max(...maturityFactors).toFixed(2)} |`);
        lines.push(`| importanceFactor | ${Math.min(...importanceFactors).toFixed(2)} | ${importanceFactors.sort((a, b) => a - b)[Math.floor(importanceFactors.length / 2)].toFixed(2)} | ${Math.max(...importanceFactors).toFixed(2)} |`);
        lines.push(`| total multiplier | ${Math.min(...ratios).toFixed(4)} | ${ratios.sort((a, b) => a - b)[Math.floor(ratios.length / 2)].toFixed(4)} | ${Math.max(...ratios).toFixed(4)} |`);
        lines.push('');
    }

    // Per-query diffs
    lines.push('## Per-Query Rank Diff (ladder vs bm25only)');
    lines.push('');
    for (let i = 0; i < Math.min(raw.audits.length, 20); i++) {
        const a = raw.audits[i];
        lines.push(`### Q${i + 1}: ${a.question}`);
        lines.push('');
        lines.push(`**Conversation:** ${a.conversationId} | **Gold turns:** ${a.goldTurns.join(', ')}`);
        lines.push('');
        lines.push('| rank | ladder (id / score / tier) | bm25only (id / score) |');
        lines.push('|---|---|---|');
        for (let r = 0; r < 10; r++) {
            const l = a.ladderTop10[r];
            const b = a.bm25Top10[r];
            const lStr = l ? `${l.id} / ${l.score.toFixed(4)} / ${l.tier}` : '—';
            const bStr = b ? `${b.id} / ${b.score.toFixed(4)}` : '—';
            lines.push(`| ${r + 1} | ${lStr} | ${bStr} |`);
        }
        lines.push('');
    }

    // Hypothesis verdict section (subagent fills in after analysis)
    lines.push('## Hypothesis Verdict');
    lines.push('');
    lines.push('> **Subagent:** After analyzing the tables above, fill in the verdict below.');
    lines.push('');
    lines.push('### H1 — Recency Dominance');
    lines.push('');
    lines.push('- **Verdict:** <!-- supported / not supported / partial -->');
    lines.push('- **Evidence:** <!-- e.g., "Gold entry recencyFactor = 0.03 vs top-5 average = 0.85" -->');
    lines.push('');
    lines.push('### H2 — Maturity Compression');
    lines.push('');
    lines.push('- **Verdict:** <!-- supported / not supported / partial -->');
    lines.push('- **Evidence:** <!-- e.g., "63% of tier2 candidates are draft (maturityFactor 0.85); gold entries skew draft in 14/20 queries, distractors skew validated in 12/20, producing systematic rank advantage for non-draft entries" -->');
    lines.push('');
    lines.push('### H3 — Pool Mismatch');
    lines.push('');
    lines.push('- **Verdict:** <!-- supported / not supported / partial -->');
    lines.push('- **Evidence:** <!-- e.g., "bm25only pool = 1247, tier2 pool = 1198; gold entry is episodic in all 20 queries" -->');
    lines.push('');
    lines.push('## Gate Recommendation');
    lines.push('');
    lines.push('> **Subagent:** After filling in the verdicts above, set ONE of the following:');
    lines.push('');
    lines.push('```');
    lines.push('GATE_VERDICT = NARROW_FIX');
    lines.push('GATE_TARGET_FILE = src/retrieval/scorer.js  // or tier2-bm25.js, ladder.js, etc.');
    lines.push('GATE_FIX_DESCRIPTION = "Reduce recency tau from 30 days to 90 days"  // example');
    lines.push('```');
    lines.push('');
    lines.push('OR');
    lines.push('');
    lines.push('```');
    lines.push('GATE_VERDICT = STRUCTURAL');
    lines.push('GATE_RECOMMENDATION = "Phase 11: redesign scorer chain to use additive combination instead of multiplicative"  // example');
    lines.push('```');
    lines.push('');

    await writeFile('docs/bench/audits/2026-04-22-ladder-inversion.md', lines.join('\n'));
    console.log('Wrote docs/bench/audits/2026-04-22-ladder-inversion.md');
}

main().catch(e => { console.error(e); process.exit(1); });
```

Run:
```bash
node bench/diagnose/render-audit.js /tmp/ladder-inversion-raw.json
```

**Step 4: Verify audit doc exists and is non-empty**

Run:
```bash
wc -l docs/bench/audits/2026-04-22-ladder-inversion.md
head -50 docs/bench/audits/2026-04-22-ladder-inversion.md
```

Expected: > 100 lines, contains factor distribution table and per-query diffs.

**Step 5: Commit**

```bash
git add bench/diagnose/ docs/bench/audits/2026-04-22-ladder-inversion.md
git commit -m "feat(bench): ladder inversion diagnostic runner + audit doc (Task 2)"
```

---

## DECISION GATE: Controller Call

**Objective:** The subagent executing Tasks 1–2 MUST pause here and report findings to the controller (Eva / Hanami). The controller makes a go/no-go decision before Task 3.

**Gate input required:**
1. The rendered `docs/bench/audits/2026-04-22-ladder-inversion.md` with H1/H2/H3 verdicts filled in.
2. A one-paragraph summary: "The inversion is caused by X. The fix is a Y-line change in Z.js."
3. Estimated fix time (subagent's honest estimate).

**Gate rules:**

| Verdict | Condition | Next action |
|---|---|---|
| **NARROW_FIX** | Root cause is ONE file, ONE function, ONE stage (e.g., scorer formula, tau threshold, filter predicate). Fix ≤ 20 lines. | Proceed to Task 3. |
| **STRUCTURAL** | Root cause spans multiple files (scorer + tier2 + ladder), requires algorithmic redesign (e.g., additive vs multiplicative scoring), or the subagent cannot isolate a single cause within 30 min of analysis. | Skip Task 3 and Task 4. Go directly to Task 5 (retro) with findings and open Phase 11. |
| **TIMEOUT** | 90 min of controller work elapsed since Task 0 commit and no clear verdict. | Same as STRUCTURAL — retro with partial findings, open Phase 11. |

**Gate output (document in audit doc footer):**

Append to `docs/bench/audits/2026-04-22-ladder-inversion.md`:

```markdown
---

## Decision Gate Record

**Date:** 2026-04-22
**Controller:** <!-- Eva or Hanami -->
**Verdict:** <!-- NARROW_FIX or STRUCTURAL -->
**Rationale:** <!-- one paragraph -->
**If NARROW_FIX:**
- Target file: `<!-- e.g., src/retrieval/scorer.js -->`
- Fix description: `<!-- one sentence -->`
- Estimated lines changed: `<!-- N -->`
**If STRUCTURAL:**
- Recommended next phase: Phase 11
- Key findings for Phase 11 plan: `<!-- bullet list -->`
```

**Important:** The subagent MUST NOT proceed past this gate without controller approval. If the controller is unavailable, the subagent's default action is to treat the verdict as STRUCTURAL and proceed to Task 5.

---

## Task 3: CONDITIONAL narrow fix

**Objective:** Apply the narrow fix identified at the Decision Gate. This task is ONLY executed if the gate verdict is `NARROW_FIX`.

**Files:**
- Modify: `<!-- gate-determined, e.g., src/retrieval/scorer.js -->`
- Test: `<!-- gate-determined, see Step 5 for location logic -->`

**Step 1: Write failing test that captures the inversion**

The test must fail BEFORE the fix and pass AFTER. It should use the synthetic corpus or a minimal state fixture that reproduces the exact inversion pattern found in Task 2.

If the fix touches `src/retrieval/scorer.js`, create `tests/unit/retrieval/scorer-inversion.test.js`:

```js
import { defaultScorer, _resetScorerForTests } from '../../../src/retrieval/scorer.js';

describe('scorer inversion regression', () => {
    afterEach(() => _resetScorerForTests());

    test('gold entry should not be outranked by unrelated distractors', () => {
        const now = new Date('2026-04-20T12:00:00Z');
        // Simulate a gold entry that is older but highly relevant (high bm25)
        const gold = {
            id: 'gold',
            lifecycle: {
                importance: 50,
                maturity: 'validated',
                createdAt: new Date('2026-04-01T12:00:00Z'), // 19 days old
            },
        };
        // Simulate a recent distractor with low bm25
        const distractor = {
            id: 'distractor',
            lifecycle: {
                importance: 10,
                maturity: 'draft',
                createdAt: new Date('2026-04-19T12:00:00Z'), // 1 day old
            },
        };

        const goldScore = defaultScorer(gold, 'query', { now, bm25: 5.0 });
        const distractorScore = defaultScorer(distractor, 'query', { now, bm25: 1.0 });

        // The gold entry has 5x the BM25 score of the distractor.
        // Even with recency and maturity penalties, it should still outrank
        // the distractor. If this fails, the multiplicative formula is
        // too heavily weighted toward recency.
        expect(goldScore).toBeGreaterThan(distractorScore);
    });
});
```

> **Note:** The exact test above is a TEMPLATE. The subagent MUST adjust the `bm25`, `importance`, `createdAt`, and `maturity` values to match the actual inversion found in Task 2. Do not copy-paste blindly — use the factor values from the audit.

**Step 2: Run test to verify failure**

Run: `npm test -- <test-file-path> -t "gold entry should not be outranked"`
Expected: FAIL.

**Step 3: Apply the narrow fix**

The fix is gate-determined. Common patterns based on the three hypotheses:

- **If H1 (recency dominance):** Adjust `LIFECYCLE.RECENCY_TAU_DAYS` or change the scorer to use additive combination: `bm25 + recencyWeight * recencyAt(...)` instead of multiplication. Or clamp recencyFactor to a minimum (e.g., 0.5) so older entries don't get crushed.
- **If H2 (maturity compression):** Adjust the compression factors in `src/core/constants.js` at `LIFECYCLE.MATURITY_BOOST` (e.g., raise `draft` from 0.85 → 0.95, or flatten the whole map to {0.95, 1.0, 1.05} to reduce maturity's ranking weight). NOTE: `maturityBoost()` in `src/lifecycle/maturity.js` is just a lookup into that constant — do NOT modify the function, modify the constant. Removing the `.filter(r => r.score > 0)` in tier2 does NOT help here because maturityBoost never returns 0; that filter only drops `bm25 === 0` entries.
- **If H3 (pool mismatch):** This is NOT a scorer fix — it's a baseline-vs-ladder alignment issue. If H3 is the sole cause, the "fix" is to make bm25only use the same pool filter as tier2, or to document that the mismatch is expected. H3 alone would not explain MRR 0.11 vs 0.69, but it may contribute.

The subagent must apply the EXACT fix described in the gate record, no more and no less.

**Step 4: Run test to verify pass**

Run: `npm test -- <test-file-path>`
Expected: PASS.

**Step 5: Run full suite to verify no regressions**

Run: `npm test`
Expected: all suites PASS (74 suites / 809 tests green as of 9.4.6 close).

If any test fails, the subagent must diagnose and fix before committing. Common regression: changing `maturityBoost` values breaks `tests/unit/lifecycle/maturity.test.js` assertions; changing `recencyAt` behavior breaks `tests/unit/lifecycle/recency.test.js`.

**Step 6: Commit**

```bash
git add <modified-files>
git commit -m "fix(retrieval): narrow fix for ladder inversion (Task 3)"
```

---

## Task 4: Regression test

**Objective:** Lock the inversion fix with a permanent regression test that will catch reintroduction of the same rank-order bug.

**Files:**
- Create: `tests/unit/retrieval/ladder-inversion.test.js` (if fix touched `src/retrieval/`) OR `tests/unit/bench/ladder-inversion.test.js` (if fix touched `bench/`)

**Step 1: Determine test location**

- If Task 3 modified `src/retrieval/scorer.js`, `src/retrieval/tier2-bm25.js`, or `src/retrieval/ladder.js`: test goes in `tests/unit/retrieval/ladder-inversion.test.js`.
- If Task 3 modified `bench/baselines/bm25only.js` or `bench/runner.js`: test goes in `tests/unit/bench/ladder-inversion.test.js`.
- If the gate verdict was STRUCTURAL and this task is skipped: no test file created.

**Step 2: Write the regression test**

The test must verify that, on a synthetic corpus with known gold entries, the ladder does not rank gold below random-scored distractors by more than a threshold.

Create `tests/unit/retrieval/ladder-inversion.test.js` (template — subagent MUST adjust values based on Task 2 findings):

```js
import { retrieve } from '../../../src/retrieval/ladder.js';
import { createEmptyState } from '../../../src/core/schema.js';
import { createEntry } from '../../../src/memory/entry.js';
import { _resetScorerForTests } from '../../../src/retrieval/scorer.js';
import { _resetBackendForTests } from '../../../src/core/state.js';
import { _resetLocksForTests } from '../../../src/core/lock.js';

function makeState(entries, workingBuffer = []) {
    const s = createEmptyState();
    for (const e of entries) s.entries[e.id] = e;
    s.workingBuffer = workingBuffer;
    return s;
}

function entry(id, content, opts = {}) {
    const now = opts.now ?? new Date('2026-04-20T12:00:00Z');
    const e = createEntry({
        scope: opts.scope ?? 'episodic',
        content,
        subject: opts.subject ?? null,
        tags: opts.tags ?? [],
        provenance: { sourceMessages: opts.sourceMessages ?? [0], extractor: 'test' },
        now,
    });
    // Override lifecycle if specified
    if (opts.lifecycle) {
        return { ...e, id, lifecycle: { ...e.lifecycle, ...opts.lifecycle } };
    }
    return { ...e, id };
}

describe('ladder inversion regression', () => {
    afterEach(() => {
        _resetScorerForTests();
        _resetBackendForTests();
        _resetLocksForTests();
    });

    test('gold entry with high bm25 outranks recent low-bm25 distractor', () => {
        const now = new Date('2026-04-20T12:00:00Z');
        const gold = entry('gold', 'alice lives in marseille', {
            lifecycle: {
                importance: 50,
                maturity: 'validated',
                createdAt: new Date('2026-04-01T12:00:00Z'),
            },
            sourceMessages: [0],
        });
        const distractor = entry('distractor', 'random unrelated text', {
            lifecycle: {
                importance: 10,
                maturity: 'draft',
                createdAt: new Date('2026-04-19T12:00:00Z'),
            },
            sourceMessages: [1],
        });
        const state = makeState([gold, distractor]);
        const result = retrieve(state, 'alice marseille', { now, k: 5 });

        // Gold must appear before distractor in the final ranking
        const goldRank = result.entries.findIndex(e => e.id === 'gold');
        const distractorRank = result.entries.findIndex(e => e.id === 'distractor');

        // Both must be present (not filtered out)
        expect(goldRank).toBeGreaterThanOrEqual(0);
        expect(distractorRank).toBeGreaterThanOrEqual(0);
        // Gold must rank higher (lower index) than distractor
        expect(goldRank).toBeLessThan(distractorRank);
    });
});
```

> **Note:** The subagent MUST adjust the `content`, `lifecycle`, and `sourceMessages` values to match the actual inversion pattern from Task 2. The test should use the SAME relative values that caused the inversion in the audit (e.g., if gold had bm25 = 4.2 and recencyFactor = 0.15 while distractor had bm25 = 1.0 and recencyFactor = 0.95, encode those proportions in the fixture).

**Step 3: Run test to verify pass**

Run: `npm test -- tests/unit/retrieval/ladder-inversion.test.js`
Expected: PASS.

**Step 4: Run full suite to verify no regressions**

Run: `npm test`
Expected: all suites PASS.

**Step 5: Commit**

```bash
git add tests/unit/retrieval/ladder-inversion.test.js
git commit -m "test(retrieval): ladder inversion regression test (Task 4)"
```

---

## Task 5: Retro

**Objective:** Document what was found, what was fixed (or why it wasn't), and hand off sweep refresh to 9.4.8.

**Files:**
- Create: `docs/plans/phase-9-4-7-retro.md`

**Step 1: Write the retro document**

Create `docs/plans/phase-9-4-7-retro.md` with the following sections:

```markdown
# Sub-phase 9.4.7 Retro — Ladder Inversion Diagnosis

**Status:** <!-- Complete / Partial / Escalated to Phase 11 -->
**Commits:**
<!-- List all commits from this sub-phase -->

**Duration:** <!-- e.g., ~45 min end-to-end -->

---

## What happened

<!-- 2-3 paragraphs summarizing the diagnostic journey -->

## Hypothesis results

| Hypothesis | Verdict | Evidence |
|---|---|---|
| H1 — Recency dominance | <!-- supported / not supported --> | <!-- one sentence --> |
| H2 — Maturity zeroing | <!-- supported / not supported --> | <!-- one sentence --> |
| H3 — Pool mismatch | <!-- supported / not supported --> | <!-- one sentence --> |

## Decision gate record

<!-- Copy the gate record from docs/bench/audits/2026-04-22-ladder-inversion.md -->

## What was fixed (if NARROW_FIX)

<!-- File, function, lines changed, before/after summary -->

## What was NOT fixed (if STRUCTURAL or TIMEOUT)

<!-- Why the fix was deferred to Phase 11, key findings Phase 11 should know -->

## Metrics impact (if fix applied)

<!-- Do NOT run sweeps in 9.4.7. Leave this section with a placeholder: -->

> Sweep refresh deferred to 9.4.8. Expected validation:
> - Re-run `npm run bench:baselines` on LoCoMo-10
> - Verify `structuralInvariants.ladderVsRandom.measuredMrrDelta` crosses above 0.02 threshold
> - Verify `structuralInvariants.ladderVsBm25Only.measuredMrrDelta` crosses above 0.02 threshold
> - If thresholds are not met, Phase 11 is still required.

## Notes for 9.4.8

<!-- EXACT handoff checklist -->

9.4.8 MUST validate the following after the 9.4.7 fix (or after Phase 11 if 9.4.7 escalated):

1. **Sweep refresh:** Run full LoCoMo-10 baselines (`npm run bench:baselines -- --conversations 10`) with warm extraction cache.
2. **Baseline.json refresh:** Update `docs/bench/baseline.json` with new measured numbers.
3. **Structural invariant check:** Confirm both `ladderVsRandom` and `ladderVsBm25Only` show `status: "PASS"` (MRR delta ≥ 0.02).
4. **Tau sweep re-run:** Run `npm run bench:sweep:tau` to verify the flat surface from 9.4.6 is now a tunable surface.
5. **BM25 sweep re-run:** Run `npm run bench:sweep:bm25` to verify tag/subject boosts now influence rank order.
6. **Graph + consolidation sweeps stay deferred.** Per 9.4.6 retro and 9.4.8 MVP scope (decision #6), graph and consolidation sweeps are out of scope for 9.4.8. If the ladder-vs-bm25only invariant passes after 9.4.8, a later sub-phase (or Phase 11) can pick them up.
7. **If invariants still FAIL:** Document findings and open Phase 11 immediately. Do not run additional sweeps.

## Notes for Phase 11 (if escalated)

<!-- Only if gate verdict was STRUCTURAL or TIMEOUT -->

Key findings Phase 11 should incorporate into its plan:

1. <!-- Finding 1 -->
2. <!-- Finding 2 -->
3. <!-- Finding 3 -->

## Files touched

<!-- List all files created or modified in this sub-phase -->

## Lint + typecheck

<!-- clean / issues -->
```

**Step 2: Verify retro doc exists**

Run:
```bash
wc -l docs/plans/phase-9-4-7-retro.md
head -20 docs/plans/phase-9-4-7-retro.md
```

Expected: > 50 lines, contains all required sections.

**Step 3: Commit**

```bash
git add docs/plans/phase-9-4-7-retro.md
git commit -m "docs(plans): sub-phase 9.4.7 retro"
```

**Step 4: Verify no uncommitted changes**

Run: `git status`
Expected: working tree clean (or only untracked files that are not part of this sub-phase).

---

## Appendix A: File reference grounding

All paths below were verified with `ls -la` before being written into this plan:

| Path | Status |
|---|---|
| `src/retrieval/scorer.js` | exists (107 lines) |
| `src/retrieval/ladder.js` | exists (263 lines) |
| `src/retrieval/tier2-bm25.js` | exists (70 lines) |
| `src/retrieval/trace.js` | exists (55 lines) |
| `src/lifecycle/recency.js` | exists (46 lines) |
| `src/lifecycle/maturity.js` | exists (67 lines) |
| `src/core/constants.js` | exists (243 lines) |
| `bench/baselines/bm25only.js` | exists (60 lines) |
| `bench/runner.js` | exists (143 lines) |
| `bench/baselines.js` | exists (321 lines) |
| `tests/unit/retrieval/tier2-bm25.test.js` | exists (117 lines) |
| `tests/unit/retrieval/` | exists (12 test files) |
| `tests/unit/bench/` | exists (8 test files + subdirs) |
| `docs/bench/baseline.json` | exists (55 lines) |
| `docs/bench/audits/` | exists (2 audit files) |
| `docs/plans/` | exists (16 plan files + ROADMAP) |

## Appendix B: Baseline metrics (from docs/bench/baseline.json)

| retriever | recall@1 | recall@5 | recall@10 | MRR | p50 ms |
|---|---|---|---|---|---|
| ladder | 0.0007 | 0.0056 | 0.6074 | 0.1118 | 1.89 |
| bm25only | 0.3128 | 0.7932 | 1.0000 | 0.6909 | 5.84 |
| recency | 0.0000 | 0.5692 | 1.0000 | 0.2703 | 0.08 |
| random | 0.1032 | 0.5040 | 1.0000 | 0.3028 | 0.04 |

**Structural invariants (both FAIL):**
- `ladderVsRandom`: measuredMrrDelta = -0.1910 (threshold = 0.02)
- `ladderVsBm25Only`: measuredMrrDelta = -0.5791 (threshold = 0.02)

## Appendix C: Scorer formula (from src/retrieval/scorer.js:41-49)

```js
export const defaultScorer = (entry, _query, context) => {
    const { now, bm25 } = context;
    if (bm25 === 0) return 0;
    const { importance, maturity, createdAt } = entry.lifecycle;
    return bm25
        * (1 + importance / 100)
        * recencyAt(now, createdAt)
        * maturityBoost(maturity);
};
```

**Factor ranges on LoCoMo-10 (estimated from constants):**
- `bm25`: typically 0–10+ (unbounded, but most scores cluster 0–5)
- `(1 + importance / 100)`: 1.0–2.0 (importance in [0, 100])
- `recencyAt`: 1.0 down to ~0.03 (for entries 90+ days old at τ = 30)
- `maturityBoost`: 0.85 (draft), 1.0 (validated), 1.2 (core)

**Maximum possible distortion:** A 90-day-old draft entry gets `recencyFactor ≈ 0.05` × `maturityFactor = 0.85` = 0.0425 total multiplier, vs a fresh validated entry's `1.0 × 1.0 = 1.0`. A 23× score swing from non-BM25 factors alone.
