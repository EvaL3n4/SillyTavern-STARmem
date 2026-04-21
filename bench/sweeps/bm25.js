#!/usr/bin/env node
/**
 * BM25 boost sweep entry point — sweeps TAG_BOOST × SUBJECT_BOOST.
 *
 * Usage:
 *   node bench/sweeps/bm25.js [--conversations N] [--primary NAME] [--synthetic]
 *
 * @see docs/plans/phase-9-benchmarking.md §Task 7
 */

import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { sweep, METRIC_ACCESSORS } from './_driver.js';
import { loadLocomo } from '../loaders/index.js';
import { seedConversation } from '../harness/seeder.js';
import { loadState, _resetBackendForTests } from '../../src/core/state.js';
import { _resetLocksForTests } from '../../src/core/lock.js';
import { _resetLLMClientForTests } from '../../src/consolidation/llmClient.js';

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
 * Compute the fraction of seeded episodic entries that have non-empty tags.
 *
 * @param {import('../loaders/locomo.js').CorpusConversation[]} corpus
 * @returns {Promise<{rate: number, n: number}>}
 */
async function computeTagsPopulatedRate(corpus) {
    try {
        const { chatId } = await seedConversation(corpus[0], {
            chatIdPrefix: 'bm25-probe',
            keepBackend: true,
        });
        const state = await loadState(chatId);
        const episodic = Object.values(state.entries).filter(e => e.scope === 'episodic');
        if (episodic.length === 0) return { rate: 0, n: 0 };
        const withTags = episodic.filter(e => Array.isArray(e.tags) && e.tags.length > 0);
        return { rate: withTags.length / episodic.length, n: episodic.length };
    } finally {
        _resetBackendForTests();
        _resetLocksForTests();
        _resetLLMClientForTests();
    }
}

/**
 * Render a Markdown report from a SweepResult.
 *
 * @param {import('./_driver.js').SweepResult} result
 * @param {import('../loaders/locomo.js').CorpusConversation[]} corpus
 * @param {{rate: number, n: number}} tagsStats
 * @returns {string}
 */
function renderReport(result, corpus, tagsStats) {
    const today = new Date().toISOString().slice(0, 10);
    const primaryMetric = 'mrr';
    const accessor = METRIC_ACCESSORS[primaryMetric];

    // Count QA items
    const qaCount = corpus.reduce((sum, c) => sum + c.qa.length, 0);

    const tagsRatePct = (tagsStats.rate * 100).toFixed(1);
    const tagsLine = `**Tags populated rate:** ${tagsRatePct}% of ${tagsStats.n} episodic entries have non-empty tags.`;
    const tagsInterpretation = tagsStats.rate < 0.05
        ? '(If <5%, TAG_BOOST axis is meaningless on this corpus; treat tag-axis results as structural, not signal.)'
        : '';

    // Build points table
    const header = '| TAG_BOOST | SUBJECT_BOOST | recallAt5 | precisionAt3 | mrr | p50 | p95 |';
    const separator = '|---|---|---|---|---|---|---|';
    const rows = result.points.map(p => {
        const tb = p.overrides.TAG_BOOST;
        const sb = p.overrides.SUBJECT_BOOST;
        const r5 = p.metrics.recallAtK[5].toFixed(4);
        const p3 = p.metrics.precisionAtK[3].toFixed(4);
        const mrr = p.metrics.mrr.toFixed(4);
        const p50 = p.latencyMs.p50.toFixed(2);
        const p95 = p.latencyMs.p95.toFixed(2);
        return `| ${tb} | ${sb} | ${r5} | ${p3} | ${mrr} | ${p50} | ${p95} |`;
    });

    // Build heatmap (primary metric vs both knobs)
    const subjectValues = [...new Set(result.points.map(p => p.overrides.SUBJECT_BOOST))].sort((a, b) => a - b);
    const tagValues = [...new Set(result.points.map(p => p.overrides.TAG_BOOST))].sort((a, b) => a - b);

    const heatmapHeader = '               ' + subjectValues.map(v => String(v).padStart(5)).join('  ');
    const heatmapRows = tagValues.map(tb => {
        const cells = subjectValues.map(sb => {
            const point = result.points.find(p => p.overrides.TAG_BOOST === tb && p.overrides.SUBJECT_BOOST === sb);
            const val = point ? accessor(point.metrics).toFixed(2) : 'N/A';
            return val.padStart(5);
        });
        return `  ${String(tb).padEnd(4)}   ${cells.join('  ')}`;
    });

    // Flatness check for Branch C
    const allPrimary = result.points.map(p => accessor(p.metrics));
    const maxPrimary = Math.max(...allPrimary);
    const minPrimary = Math.min(...allPrimary);
    const isFlat = (maxPrimary - minPrimary) < 0.01;

    // Elbow interpretation branches
    const eTag = result.elbow.overrides.TAG_BOOST;
    const eSub = result.elbow.overrides.SUBJECT_BOOST;

    let interpretationBranch;
    if (isFlat) {
        interpretationBranch = `### Branch C — flat heatmap (max - min of primary metric < 0.01 across all 16 cells)
Rule-based extractor can't exercise tag/subject asymmetry on this corpus. Defer to sub-phase 9.5 for meaningful numbers. Tags populated rate of ${tagsRatePct}% confirms the mechanism.`;
    } else if (eSub > eTag) {
        interpretationBranch = `### Branch A — subject > tag (elbow has SUBJECT_BOOST > TAG_BOOST)
As-expected: subject matches dominate in well-formed retrievals.
Consider accepting SUBJECT_BOOST=${eSub} as a spec amendment if >50% from current default.`;
    } else {
        interpretationBranch = `### Branch B — tag > subject (elbow has TAG_BOOST > SUBJECT_BOOST)
Investigate: suggests entries have bogus tags or subject-extraction is weak. Do NOT amend spec without root-cause inspection.`;
    }

    // Spec amendment check
    const currentTagBoost = 2;
    const currentSubjectBoost = 2;
    const tagDeviation = Math.abs(eTag - currentTagBoost) / currentTagBoost;
    const subjDeviation = Math.abs(eSub - currentSubjectBoost) / currentSubjectBoost;
    const needsAmendment = tagDeviation > 0.5 || subjDeviation > 0.5;

    const amendmentSection = needsAmendment
        ? `**Proposed amendment:**

- TAG_BOOST: ${currentTagBoost} → ${eTag}
- SUBJECT_BOOST: ${currentSubjectBoost} → ${eSub}

Rationale: elbow is >50% away from current spec values (${(tagDeviation * 100).toFixed(0)}% / ${(subjDeviation * 100).toFixed(0)}% deviation).`
        : 'No amendment needed — elbow within 50% of current spec.';

    // Env snapshot from first point
    const firstPoint = result.points[0];
    const envBlock = firstPoint
        ? '```json\n' + JSON.stringify(firstPoint.metrics, null, 2) + '\n```'
        : 'No points recorded.';

    return `# BM25 boost sweep — ${today}

**Corpus:** ${corpus.length} conversations, ${qaCount} QA items
**Primary metric:** ${primaryMetric}
${tagsLine}
${tagsInterpretation}

## Per-pair metrics table

${header}
${separator}
${rows.join('\n')}

## Heatmap (primary = ${primaryMetric})

              SUBJECT_BOOST
${heatmapHeader}
TAG_BOOST
${heatmapRows.join('\n')}

## Elbow

**Recommended overrides:** \`${JSON.stringify(result.elbow.overrides)}\`
**Rationale:** ${result.elbow.rationale}

## Interpretation

${interpretationBranch}

## v2.1 tokenizer refactor note

If the elbow suggests fractional values would help (any "would like X.5"
indication from Phase 3's retro), a v2.1 refactor is warranted at
\`src/retrieval/bm25.js:62-63\`:

\`\`\`js
// Current (integer-only):
...repeat(subjectTokens, RETRIEVAL.SUBJECT_BOOST),
...repeat(tagTokens, RETRIEVAL.TAG_BOOST),

// Proposed (fractional-capable): per-token weight multiplier into the
// BM25 scoring matrix instead of token replication. Requires bm25.js
// interface change; downstream effect on tier2-bm25.js scoring path.
\`\`\`

Not in scope for Phase 9 — note only.

## Spec amendment proposal

${amendmentSection}

## envSnapshot

${envBlock}
`;
}

/**
 * Write the Markdown report to disk.
 *
 * @param {import('./_driver.js').SweepResult} result
 * @param {import('../loaders/locomo.js').CorpusConversation[]} corpus
 * @param {{rate: number, n: number}} tagsStats
 */
async function writeReport(result, corpus, tagsStats) {
    const today = new Date().toISOString().slice(0, 10);
    const outDir = path.join('docs', 'bench', 'sweeps');
    const outPath = path.join(outDir, `${today}-bm25.md`);

    await mkdir(outDir, { recursive: true });
    await writeFile(outPath, renderReport(result, corpus, tagsStats), 'utf8');
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

    const tagsStats = await computeTagsPopulatedRate(corpus);
    console.log(`Tags populated rate: ${(tagsStats.rate * 100).toFixed(1)}% (${tagsStats.n} episodic entries)`);

    const result = await sweep({
        name: 'bm25',
        knobs: [
            { name: 'TAG_BOOST',     values: [1, 2, 3, 4] },
            { name: 'SUBJECT_BOOST', values: [1, 2, 3, 4] },
        ],
        corpus,
        primaryMetric,
    });

    await writeReport(result, corpus, tagsStats);
}

main().catch(err => {
    console.error(err);
    process.exit(1);
});
