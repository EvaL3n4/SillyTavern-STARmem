#!/usr/bin/env node
/**
 * τ sweep entry point — sweeps TIER2_TAU_CONFIDENCE × TIER2_TAU_GAP.
 *
 * Usage:
 *   node bench/sweeps/tau.js [--conversations N] [--primary NAME] [--synthetic]
 *
 * @see docs/plans/phase-9-benchmarking.md §Task 4
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
 * Render a Markdown report from a SweepResult.
 *
 * @param {import('./_driver.js').SweepResult} result
 * @param {import('../loaders/locomo.js').CorpusConversation[]} corpus
 * @returns {string}
 */
function renderReport(result, corpus) {
    const today = new Date().toISOString().slice(0, 10);
    const primaryMetric = 'recallAt5'; // TODO: derive from caller if we generalise
    const accessor = METRIC_ACCESSORS[primaryMetric];

    // Count QA items
    const qaCount = corpus.reduce((sum, c) => sum + c.qa.length, 0);

    // Build points table
    const header = '| TIER2_TAU_CONFIDENCE | TIER2_TAU_GAP | recallAt5 | precisionAt3 | mrr | p50 | p95 |';
    const separator = '|---|---|---|---|---|---|---|';
    const rows = result.points.map(p => {
        const tc = p.overrides.TIER2_TAU_CONFIDENCE;
        const tg = p.overrides.TIER2_TAU_GAP;
        const r5 = p.metrics.recallAtK[5].toFixed(4);
        const p3 = p.metrics.precisionAtK[3].toFixed(4);
        const mrr = p.metrics.mrr.toFixed(4);
        const p50 = p.latencyMs.p50.toFixed(2);
        const p95 = p.latencyMs.p95.toFixed(2);
        return `| ${tc} | ${tg} | ${r5} | ${p3} | ${mrr} | ${p50} | ${p95} |`;
    });

    // Build heatmap (primary metric vs both knobs)
    const tauGapValues = [...new Set(result.points.map(p => p.overrides.TIER2_TAU_GAP))].sort((a, b) => a - b);
    const tauConfValues = [...new Set(result.points.map(p => p.overrides.TIER2_TAU_CONFIDENCE))].sort((a, b) => a - b);

    const heatmapHeader = '               ' + tauGapValues.map(v => v.toFixed(2).padStart(5)).join('  ');
    const heatmapRows = tauConfValues.map(tc => {
        const cells = tauGapValues.map(tg => {
            const point = result.points.find(p => p.overrides.TIER2_TAU_CONFIDENCE === tc && p.overrides.TIER2_TAU_GAP === tg);
            const val = point ? accessor(point.metrics).toFixed(2) : 'N/A';
            return val.padStart(5);
        });
        return `  ${String(tc).padEnd(4)}   ${cells.join('  ')}`;
    });

    // Spec amendment check
    const currentTauConf = 2.0;
    const currentTauGap = 0.5;
    const eConf = result.elbow.overrides.TIER2_TAU_CONFIDENCE;
    const eGap = result.elbow.overrides.TIER2_TAU_GAP;
    const confDeviation = Math.abs(eConf - currentTauConf) / currentTauConf;
    const gapDeviation = Math.abs(eGap - currentTauGap) / currentTauGap;
    const needsAmendment = confDeviation > 0.5 || gapDeviation > 0.5;

    const amendmentSection = needsAmendment
        ? `**Proposed amendment:**

- TIER2_TAU_CONFIDENCE: ${currentTauConf} → ${eConf}
- TIER2_TAU_GAP: ${currentTauGap} → ${eGap}

Rationale: elbow is >50% away from current spec values (${(confDeviation * 100).toFixed(0)}% / ${(gapDeviation * 100).toFixed(0)}% deviation).`
        : 'No amendment needed — elbow within 50% of current spec.';

    // Env snapshot from first point (all equal except constants)
    const firstPoint = result.points[0];
    const envBlock = firstPoint
        ? '```json\n' + JSON.stringify(firstPoint.metrics, null, 2) + '\n```'
        : 'No points recorded.';

    return `# τ sweep — ${today}

**Corpus:** ${corpus.length} conversations, ${qaCount} QA items
**Primary metric:** ${primaryMetric}

## Points

${header}
${separator}
${rows.join('\n')}

## Heatmap (primary = ${primaryMetric})

               TIER2_TAU_GAP
${heatmapHeader}
TIER2_TAU_CONFIDENCE
${heatmapRows.join('\n')}

## Elbow

**Recommended overrides:** \`${JSON.stringify(result.elbow.overrides)}\`
**Rationale:** ${result.elbow.rationale}

## Spec amendment proposal

${amendmentSection}

## Environment snapshot

${envBlock}
`;
}

/**
 * Write the Markdown report to disk.
 *
 * @param {import('./_driver.js').SweepResult} result
 * @param {import('../loaders/locomo.js').CorpusConversation[]} corpus
 */
async function writeReport(result, corpus) {
    const today = new Date().toISOString().slice(0, 10);
    const outDir = path.join('docs', 'bench', 'sweeps');
    const outPath = path.join(outDir, `${today}-tau.md`);

    await mkdir(outDir, { recursive: true });
    await writeFile(outPath, renderReport(result, corpus), 'utf8');
    console.log(`Report written to ${outPath}`);
}

async function main() {
    const args = parseArgs();
    const maxConversations = args.conversations ? Number(args.conversations) : undefined;
    const primaryMetric = args.primary ?? 'recallAt5';
    const synthetic = args.synthetic === 'true';

    const corpus = synthetic
        ? synthesizeSyntheticCorpus()
        : await loadLocomo({ maxConversations });

    const result = await sweep({
        name: 'tau',
        knobs: [
            { name: 'TIER2_TAU_CONFIDENCE', values: [0.5, 1.0, 1.5, 2.0, 2.5, 3.0, 4.0, 5.0] },
            { name: 'TIER2_TAU_GAP',        values: [0.1, 0.25, 0.5, 0.75, 1.0, 1.5] },
        ],
        corpus,
        primaryMetric,
    });

    await writeReport(result, corpus);
}

main().catch(err => {
    console.error(err);
    process.exit(1);
});
