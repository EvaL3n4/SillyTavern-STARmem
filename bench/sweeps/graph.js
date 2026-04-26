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
import { sweep } from './_driver.js';
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
 * Build a markdown table row for a single point.
 *
 * @param {import('./_driver.js').SweepPoint} point
 * @param {string} knobName
 * @param {string} primaryMetric
 * @returns {string}
 */
function pointRow(point, knobName, primaryMetric) {
    const kv = point.overrides[knobName];
    const r5 = point.metrics.recallAtK[5].toFixed(4);
    const p3 = point.metrics.precisionAtK[3].toFixed(4);
    const mrr = point.metrics.mrr.toFixed(4);
    const p50 = point.latencyMs.p50.toFixed(2);
    const p95 = point.latencyMs.p95.toFixed(2);
    return `| ${kv} | ${r5} | ${p3} | ${mrr} | ${p50} | ${p95} |`;
}

/**
 * Render a Markdown report from all sweep results.
 *
 * @param {{roundResults: Array<{round: object, result: import('./_driver.js').SweepResult, committedValue: number}>}} result
 * @param {import('../loaders/locomo.js').CorpusConversation[]} corpus
 * @param {string} primaryMetric
 * @returns {string}
 */
function renderReport(result, corpus, primaryMetric) {
    const { roundResults } = result;
    const today = new Date().toISOString().slice(0, 10);

    // Count QA items
    const qaCount = corpus.reduce((sum, c) => sum + c.qa.length, 0);

    // Round sections
    const roundSections = roundResults.map(({ round, result, committedValue }, idx) => {
        // Build base overrides from previous rounds only
        const prevOverrides = {};
        for (let i = 0; i < idx; i++) {
            prevOverrides[roundResults[i].round.knob] = roundResults[i].committedValue;
        }

        const header = `| ${round.knob} | recallAt5 | precisionAt3 | mrr | p50 | p95 |`;
        const separator = '|---|---|---|---|---|---|';
        const rows = result.points.map(p => pointRow(p, round.knob, primaryMetric));

        return `## Round \u2014 ${round.knob}

**Base overrides:** \`${JSON.stringify(prevOverrides)}\`

${header}
${separator}
${rows.join('\n')}

**Elbow:** ${round.knob} = ${committedValue}
**Rationale:** ${result.elbow.rationale}`;
    });

    // Final recommendation
    const finalOverrides = {};
    for (const { round, committedValue } of roundResults) {
        finalOverrides[round.knob] = committedValue;
    }

    // Env snapshot from last round's first point
    const lastRound = roundResults[roundResults.length - 1];
    const envSnapshotPoint = lastRound.result.points[0];
    const envBlock = envSnapshotPoint
        ? '```json\n' + JSON.stringify({ overrides: envSnapshotPoint.overrides, metrics: envSnapshotPoint.metrics, latencyMs: envSnapshotPoint.latencyMs }, null, 2) + '\n```'
        : 'No points recorded.';

    return `# Graph sweep \u2014 ${today}

**Corpus:** ${corpus.length} conversations, ${qaCount} QA items
**Primary metric:** ${primaryMetric}
**Note:** Phase 14 Task 2 demolished the Tier-2-only baseline row \u2014 the post-Phase-12 ladder always falls through to Tier 3 (TIER2_TAU_CONFIDENCE/_GAP runtime branch removed in Phase 12 Task 1). Graph contribution is measured statically via baseline.json::structuralInvariants.ladderVsBm25Only.

${roundSections.join('\n\n')}

## Final recommendation

\`\`\`json
${JSON.stringify(finalOverrides, null, 2)}
\`\`\`

## envSnapshot

${envBlock}
`;
}

/**
 * Write the Markdown report to disk.
 *
 * @param {object} params
 * @param {Array<{round: object, result: import('./_driver.js').SweepResult, committedValue: number}>} params.roundResults
 * @param {import('../loaders/locomo.js').CorpusConversation[]} params.corpus
 * @param {string} params.primaryMetric
 */
async function writeReport({ roundResults, corpus, primaryMetric }) {
    const today = new Date().toISOString().slice(0, 10);
    const outDir = path.join('docs', 'bench', 'sweeps');
    const outPath = path.join(outDir, `${today}-graph.md`);

    await mkdir(outDir, { recursive: true });
    const result = { roundResults };
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

    // Phase 14 Task 2: Tier-2-only baseline row demolished (TIER2_TAU_CONFIDENCE
    // runtime branch removed in Phase 12 Task 1). Coordinate descent runs
    // directly. Graph-vs-BM25 contribution is measured statically via
    // baseline.json::structuralInvariants.ladderVsBm25Only.
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
    }

    await writeReport({ roundResults, corpus, primaryMetric });
}

main().catch(err => {
    console.error(err);
    process.exit(1);
});
