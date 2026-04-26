#!/usr/bin/env node
/**
 * Graph sweep entry point — coordinate descent over 5 graph-construction knobs.
 *
 * Usage:
 *   node bench/sweeps/graph.js [--conversations N] [--primary NAME] [--synthetic]
 *
 * @see docs/plans/phase-9-benchmarking.md §Task 5
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
 * Build a markdown table row for a single point, including Δ vs baseline.
 *
 * @param {import('./_driver.js').SweepPoint} point
 * @param {string} knobName
 * @param {string} primaryMetric
 * @param {number} baselineVal
 * @returns {string}
 */
function pointRow(point, knobName, primaryMetric, baselineVal) {
    const kv = point.overrides[knobName];
    const r5 = point.metrics.recallAtK[5].toFixed(4);
    const p3 = point.metrics.precisionAtK[3].toFixed(4);
    const mrr = point.metrics.mrr.toFixed(4);
    const p50 = point.latencyMs.p50.toFixed(2);
    const p95 = point.latencyMs.p95.toFixed(2);
    const primaryVal = METRIC_ACCESSORS[primaryMetric](point.metrics);
    const delta = (primaryVal - baselineVal).toFixed(4);
    return `| ${kv} | ${r5} | ${p3} | ${mrr} | ${p50} | ${p95} | ${delta} |`;
}

/**
 * Render a Markdown report from all sweep results.
 *
 * @param {{baselineResult: import('./_driver.js').SweepResult, roundResults: Array<{round: object, result: import('./_driver.js').SweepResult, committedValue: number}>}} result
 * @param {import('../loaders/locomo.js').CorpusConversation[]} corpus
 * @param {string} primaryMetric
 * @returns {string}
 */
function renderReport(result, corpus, primaryMetric) {
    const { baselineResult, roundResults } = result;
    const today = new Date().toISOString().slice(0, 10);
    const accessor = METRIC_ACCESSORS[primaryMetric];
    const baselineMetrics = baselineResult.points[0].metrics;
    const baselineVal = accessor(baselineMetrics);

    // Count QA items
    const qaCount = corpus.reduce((sum, c) => sum + c.qa.length, 0);

    // Baseline table
    const baselineRow = (() => {
        const m = baselineMetrics;
        return `| ${m.recallAtK[5].toFixed(4)} | ${m.precisionAtK[3].toFixed(4)} | ${m.mrr.toFixed(4)} | ${baselineResult.points[0].latencyMs.p50.toFixed(2)} | ${baselineResult.points[0].latencyMs.p95.toFixed(2)} |`;
    })();

    // Round sections
    const roundSections = roundResults.map(({ round, result, committedValue }, idx) => {
        // Build base overrides from previous rounds only
        const prevOverrides = {};
        for (let i = 0; i < idx; i++) {
            prevOverrides[roundResults[i].round.knob] = roundResults[i].committedValue;
        }

        const header = `| ${round.knob} | recallAt5 | precisionAt3 | mrr | p50 | p95 | Δ ${primaryMetric} vs baseline |`;
        const separator = '|---|---|---|---|---|---|---|';
        const rows = result.points.map(p => pointRow(p, round.knob, primaryMetric, baselineVal));

        const bestMetric = Math.max(...result.points.map(p => accessor(p.metrics)));
        const lift = bestMetric - baselineVal;
        const structuralCheck = lift >= 0.05
            ? `PASS (lift=${lift.toFixed(4)} ≥ 0.05)`
            : `FLAG (lift=${lift.toFixed(4)} < 0.05)`;

        return `## Round — ${round.knob}

**Base overrides:** \`${JSON.stringify(prevOverrides)}\`

${header}
${separator}
${rows.join('\n')}

**Elbow:** ${round.knob} = ${committedValue}
**Rationale:** ${result.elbow.rationale}
**Structural-bug check:** ${structuralCheck}`;
    });

    // Final recommendation
    const finalOverrides = {};
    for (const { round, committedValue } of roundResults) {
        finalOverrides[round.knob] = committedValue;
    }

    // Final lift: compute from last round's best point
    const lastRound = roundResults[roundResults.length - 1];
    const finalBestMetric = Math.max(...lastRound.result.points.map(p => accessor(p.metrics)));
    const finalLift = finalBestMetric - baselineVal;
    const finalCheck = finalLift >= 0.05 ? 'PASS' : 'FLAG';

    // Env snapshot from last round's first point
    const envSnapshotPoint = lastRound.result.points[0];
    const envBlock = envSnapshotPoint
        ? '```json\n' + JSON.stringify({ overrides: envSnapshotPoint.overrides, metrics: envSnapshotPoint.metrics, latencyMs: envSnapshotPoint.latencyMs }, null, 2) + '\n```'
        : 'No points recorded.';

    return `# Graph sweep — ${today}

**Corpus:** ${corpus.length} conversations, ${qaCount} QA items
**Primary metric:** ${primaryMetric}
**Baseline mechanism:** TIER2_TAU_CONFIDENCE=0.01 (forces Tier 2 exit; no Tier 3 fallthrough)

## Baseline (Tier-2-only)

| recallAt5 | precisionAt3 | mrr | p50 | p95 |
|---|---|---|---|---|
${baselineRow}

${roundSections.join('\n\n')}

## Final recommendation

\`\`\`json
${JSON.stringify(finalOverrides, null, 2)}
\`\`\`

## Graph contribution vs baseline

Final (all knobs at elbow) primary-metric lift: ${finalLift.toFixed(4)} over Tier-2-only baseline.
(Threshold: 0.05 MRR. ${finalCheck}.)

## envSnapshot

${envBlock}
`;
}

/**
 * Write the Markdown report to disk.
 *
 * @param {object} params
 * @param {import('./_driver.js').SweepResult} params.baselineResult
 * @param {Array<{round: object, result: import('./_driver.js').SweepResult, committedValue: number}>} params.roundResults
 * @param {import('../loaders/locomo.js').CorpusConversation[]} params.corpus
 * @param {string} params.primaryMetric
 */
async function writeReport({ baselineResult, roundResults, corpus, primaryMetric }) {
    const today = new Date().toISOString().slice(0, 10);
    const outDir = path.join('docs', 'bench', 'sweeps');
    const outPath = path.join(outDir, `${today}-graph.md`);

    await mkdir(outDir, { recursive: true });
    const result = { baselineResult, roundResults };
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

    // 1. Baseline row (Tier 2 only)
    const baselineResult = await sweep({
        name: 'graph-baseline',
        knobs: [{ name: 'TIER2_TAU_CONFIDENCE', values: [0.01] }],
        baseOverrides: {},
        corpus,
        primaryMetric,
    });
    const baselineMetrics = baselineResult.points[0].metrics;

    // 2. Coordinate descent in order
    const rounds = [
        { name: 'lambda_1',     knob: 'TIER3_LAMBDA_1',      values: [0.5, 0.75, 1.0, 1.25, 1.5] },
        { name: 'lambda_2',     knob: 'TIER3_LAMBDA_2',      values: [0.1, 0.2, 0.3, 0.4, 0.5] },
        { name: 'beam',         knob: 'TIER3_BEAM_WIDTH',    values: [3, 5, 8, 10] },
        { name: 'edge_cap',     knob: 'EDGE_CAP_PER_ENTRY',  values: [10, 15, 20, 30, 50] },
        { name: 'cooccurrence', knob: 'COOCCURRENCE_WEIGHT', values: [0.25, 0.5, 0.75, 1.0] },
    ];

    let baseOverrides = {};
    const roundResults = [];
    for (const round of rounds) {
        const result = await sweep({
            name: `graph-${round.name}`,
            knobs: [{ name: round.knob, values: round.values }],
            baseOverrides,
            corpus,
            primaryMetric,
        });
        const elbowValue = result.elbow.overrides[round.knob];
        baseOverrides = { ...baseOverrides, [round.knob]: elbowValue };
        roundResults.push({ round, result, committedValue: elbowValue });

        // Structural-bug check (spec §Phase 5 invariant)
        const bestMetric = Math.max(...result.points.map(p => METRIC_ACCESSORS[primaryMetric](p.metrics)));
        const baselineVal = METRIC_ACCESSORS[primaryMetric](baselineMetrics);
        const lift = bestMetric - baselineVal;
        if (primaryMetric === 'mrr' && lift < 0.05) {
            console.warn(`STOP SIGNAL: Round ${round.name} best ${primaryMetric}=${bestMetric.toFixed(4)} only lifts ${lift.toFixed(4)} over Tier-2-only baseline (threshold 0.05). Flagging for controller — structural bug suspected.`);
        }
    }

    await writeReport({ baselineResult, roundResults, corpus, primaryMetric });
}

main().catch(err => {
    console.error(err);
    process.exit(1);
});
