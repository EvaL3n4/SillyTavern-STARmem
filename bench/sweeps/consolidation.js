#!/usr/bin/env node
/**
 * Consolidation sweep entry point — sweeps DEDUP_JACCARD_THRESHOLD.
 *
 * Usage:
 *   node bench/sweeps/consolidation.js [--conversations N] [--primary NAME] [--synthetic]
 *
 * @see docs/plans/phase-9-benchmarking.md §Task 6
 */

import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { sweep, METRIC_ACCESSORS } from './_driver.js';
import { loadLocomo } from '../loaders/index.js';

/**
 * Parse process.argv into a simple key/value map.
 *
 * @returns {Record<string, string>}
 */
function parseArgs() {
    const args = process.argv.slice(2);
    const opts = {};
    for (let i = 0; i < args.length; i++) {
        const arg = args[i];
        if (arg.startsWith('--')) {
            const key = arg.slice(2);
            const next = args[i + 1];
            if (next && !next.startsWith('--')) {
                opts[key] = next;
                i++;
            } else {
                opts[key] = 'true';
            }
        }
    }
    return opts;
}

/**
 * Synthetic 2-conversation corpus for offline smoke runs.
 * Matches the integration-test fixture shape.
 *
 * @returns {import('../loaders/locomo.js').CorpusConversation[]}
 */
function synthesizeSyntheticCorpus() {
    return [
        {
            id: 'synth-a',
            turns: [
                { speaker: 'Alice', text: 'Alice likes coffee. She drinks it every morning.', sessionId: 1, turnIndex: 0 },
                { speaker: 'Bob',   text: 'Bob works at Acme. He is an engineer there.', sessionId: 1, turnIndex: 1 },
                { speaker: 'Alice', text: 'Charlie moved to Seattle. The rain is constant.', sessionId: 1, turnIndex: 2 },
                { speaker: 'Bob',   text: 'Diana loves hiking. She climbs mountains every weekend.', sessionId: 1, turnIndex: 3 },
                { speaker: 'Alice', text: 'Emma adopted a dog. The dog is very playful.', sessionId: 1, turnIndex: 4 },
                { speaker: 'Bob',   text: 'Frank plays guitar. He practices in the garage.', sessionId: 1, turnIndex: 5 },
            ],
            qa: [
                {
                    question: 'What does Alice like to drink?',
                    answer: 'Coffee',
                    evidenceTurns: [0],
                    category: 'factual',
                },
                {
                    question: 'Where does Bob work?',
                    answer: 'Acme',
                    evidenceTurns: [1],
                    category: 'factual',
                },
            ],
        },
        {
            id: 'synth-b',
            turns: [
                { speaker: 'Carol', text: 'Grace moved to Berlin. The Brandenburg Gate is iconic.', sessionId: 1, turnIndex: 0 },
                { speaker: 'Dave',  text: 'Henry studied art in Berlin. He loves museums.', sessionId: 1, turnIndex: 1 },
                { speaker: 'Carol', text: 'Irene visited Madrid. The Prado museum has masterpieces.', sessionId: 1, turnIndex: 2 },
                { speaker: 'Dave',  text: 'Jack enjoys tapas in Madrid. The nightlife is vibrant.', sessionId: 1, turnIndex: 3 },
                { speaker: 'Carol', text: 'Kate moved to Lisbon. The trams are charming.', sessionId: 1, turnIndex: 4 },
                { speaker: 'Dave',  text: 'Liam surfs every morning in Lisbon. The coast is beautiful.', sessionId: 1, turnIndex: 5 },
            ],
            qa: [
                {
                    question: 'Where did Grace move?',
                    answer: 'Berlin',
                    evidenceTurns: [0],
                    category: 'factual',
                },
                {
                    question: 'What does Jack enjoy in Madrid?',
                    answer: 'Tapas',
                    evidenceTurns: [3],
                    category: 'factual',
                },
            ],
        },
    ];
}

/**
 * Compute min/p50/p95/max from an array of numbers.
 *
 * @param {number[]} arr
 * @returns {{min: number, p50: number, p95: number, max: number}}
 */
function percentiles(arr) {
    if (arr.length === 0) return { min: 0, p50: 0, p95: 0, max: 0 };
    const sorted = [...arr].sort((a, b) => a - b);
    const n = sorted.length;
    const idx50 = Math.floor((n - 1) * 0.5);
    const idx95 = Math.floor((n - 1) * 0.95);
    return {
        min: sorted[0],
        p50: sorted[idx50],
        p95: sorted[idx95],
        max: sorted[n - 1],
    };
}

/**
 * Render a Markdown report from a SweepResult.
 *
 * @param {import('./_driver.js').SweepResult} result
 * @param {import('../loaders/locomo.js').CorpusConversation[]} corpus
 * @param {string} primaryMetric
 * @returns {string}
 */
function renderReport(result, corpus, primaryMetric) {
    const today = new Date().toISOString().slice(0, 10);
    const accessor = METRIC_ACCESSORS[primaryMetric];

    // Count QA items
    const qaCount = corpus.reduce((sum, c) => sum + c.qa.length, 0);

    // Aggregate consolidation stats per point
    for (const point of result.points) {
        const seen = new Set();
        const totals = { added: 0, updated: 0, drained: 0, batches: 0 };
        const allFactLengths = [];
        for (const run of point.runs) {
            if (seen.has(run.conversationId)) continue;
            seen.add(run.conversationId);
            totals.added   += run.consolidationStats.added;
            totals.updated += run.consolidationStats.updated;
            totals.drained += run.consolidationStats.drained;
            totals.batches += run.consolidationStats.batches;
            allFactLengths.push(...run.consolidationStats.factLengths);
        }

        const updateRate = totals.updated / Math.max(1, totals.added + totals.updated);
        const dedupHitRate = totals.updated / Math.max(1, totals.drained);

        point.aggStats = {
            ...totals,
            updateRate,
            dedupHitRate,
            factLengths: percentiles(allFactLengths),
        };
    }

    // Build per-threshold table
    const header = '| DEDUP_JACCARD_THRESHOLD | added | updated | drained | updateRate | dedupHitRate | recallAt5 | mrr | p50 | p95 |';
    const separator = '|---|---|---|---|---|---|---|---|---|---|';
    const rows = result.points.map(p => {
        const thresh = p.overrides.DEDUP_JACCARD_THRESHOLD;
        const a = p.aggStats.added;
        const u = p.aggStats.updated;
        const d = p.aggStats.drained;
        const ur = p.aggStats.updateRate.toFixed(4);
        const dhr = p.aggStats.dedupHitRate.toFixed(4);
        const r5 = p.metrics.recallAtK[5].toFixed(4);
        const mrr = p.metrics.mrr.toFixed(4);
        const p50 = p.latencyMs.p50.toFixed(2);
        const p95 = p.latencyMs.p95.toFixed(2);
        return `| ${thresh} | ${a} | ${u} | ${d} | ${ur} | ${dhr} | ${r5} | ${mrr} | ${p50} | ${p95} |`;
    });

    // Recommended threshold
    const allUpdateRates = result.points.map(p => p.aggStats.updateRate);
    const maxUpdateRate = Math.max(...allUpdateRates);
    let recommendation;
    if (maxUpdateRate < 0.1) {
        recommendation = `**Recommendation:** No threshold stands out under rule-based extraction.

> Rule-based seeder doesn't exercise realistic dedup pressure. Thresholds are under-stressed; revisit with live LLM consolidation in sub-phase 9.5.`;
    } else {
        const bestPoint = result.points.reduce((best, p) => {
            const ur = p.aggStats.updateRate;
            const bestUr = best.aggStats.updateRate;
            // Prefer updateRate in [0.2, 0.4]; if none, pick closest to 0.3
            const target = 0.3;
            const dist = Math.abs(ur - target);
            const bestDist = Math.abs(bestUr - target);
            return dist < bestDist ? p : best;
        });
        const recVal = bestPoint.overrides.DEDUP_JACCARD_THRESHOLD;
        const recUr = bestPoint.aggStats.updateRate;
        recommendation = `**Recommendation:** DEDUP_JACCARD_THRESHOLD = ${recVal}
**Rationale:** updateRate = ${recUr.toFixed(4)} falls closest to the target band [0.2, 0.4] (Phase 6 retro band rule).`;
    }

    // factLengths distribution (threshold-invariant)
    const firstPoint = result.points[0];
    const fl = firstPoint.aggStats.factLengths;
    const factLengthsTable = `| ${fl.min} | ${fl.p50} | ${fl.p95} | ${fl.max} |`;

    // Env snapshot from first point
    const envBlock = firstPoint
        ? '```json\n' + JSON.stringify(firstPoint.metrics, null, 2) + '\n```'
        : 'No points recorded.';

    return `# Consolidation sweep — ${today}

**Corpus:** ${corpus.length} conversations, ${qaCount} QA items
**Primary metric:** ${primaryMetric}
**Swept knob:** DEDUP_JACCARD_THRESHOLD

## Per-threshold aggregate table

${header}
${separator}
${rows.join('\n')}

## Recommended threshold

**Band rule (Phase 6 retro):** updateRate < 0.1 = too strict, > 0.5 = too lax.
Target: updateRate ∈ [0.2, 0.4].

${recommendation}

## EXTRACT_MAX_TOKENS inspection (read-only)

factLengths distribution across all points (should be threshold-invariant
since extraction happens before dedup):

| min | p50 | p95 | max |
|---|---|---|---|
${factLengthsTable}

Rule-based mock produces facts averaging ${fl.p50} chars; at ~4 chars/token
this implies median ~${Math.round(fl.p50 / 4)} tokens. Real-LLM extraction (sub-phase 9.5)
may differ. EXTRACT_MAX_TOKENS is defined in extractFacts.js (value redacted
in display output); if p95 < 0.5×cap, room to reduce; if p95 ≈ cap, consider raising.

## envSnapshot

${envBlock}
`;
}

/**
 * Write the Markdown report to disk.
 *
 * @param {import('./_driver.js').SweepResult} result
 * @param {import('../loaders/locomo.js').CorpusConversation[]} corpus
 * @param {string} primaryMetric
 */
async function writeReport(result, corpus, primaryMetric) {
    const today = new Date().toISOString().slice(0, 10);
    const outDir = path.join('docs', 'bench', 'sweeps');
    const outPath = path.join(outDir, `${today}-consolidation.md`);

    await mkdir(outDir, { recursive: true });
    await writeFile(outPath, renderReport(result, corpus, primaryMetric), 'utf8');
    console.log(`Report written to ${outPath}`);
}

async function main() {
    const args = parseArgs();
    const maxConversations = args.conversations ? Number(args.conversations) : undefined;
    const primaryMetric = args.primary ?? 'mrr';
    const synthetic = args.synthetic === 'true';

    const corpus = synthetic
        ? synthesizeSyntheticCorpus()
        : await loadLocomo({ maxConversations });

    const result = await sweep({
        name: 'consolidation',
        knobs: [
            { name: 'DEDUP_JACCARD_THRESHOLD', values: [0.5, 0.6, 0.7, 0.8, 0.9] },
        ],
        corpus,
        primaryMetric,
    });

    await writeReport(result, corpus, primaryMetric);
}

main().catch(err => {
    console.error(err);
    process.exit(1);
});
