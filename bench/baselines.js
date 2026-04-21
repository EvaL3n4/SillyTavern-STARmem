#!/usr/bin/env node
/**
 * Baseline comparison entry point.
 *
 * Runs the harness four times (default ladder + bm25only + recency + random)
 * over the same corpus and emits a comparison report.
 *
 * Usage:
 *   node bench/baselines.js [--conversations N] [--synthetic]
 *
 * @see docs/plans/phase-9-benchmarking.md §Task 8
 */

import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { runHarness } from './runner.js';
import { bm25only, recency, random } from './baselines/index.js';
import { loadLocomo } from './loaders/index.js';
import { computeMetrics } from './metrics/retrieval.js';

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
 *
 * @returns {import('./loaders/locomo.js').CorpusConversation[]}
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
 * Compute p50 and p95 latencies from an array of numbers.
 *
 * @param {number[]} values
 * @returns {{ p50: number, p95: number }}
 */
function latencyStats(values) {
    if (values.length === 0) return { p50: 0, p95: 0 };
    const sorted = [...values].sort((a, b) => a - b);
    const p50Idx = Math.floor(sorted.length * 0.5);
    const p95Idx = Math.min(sorted.length - 1, Math.floor(sorted.length * 0.95));
    return { p50: sorted[p50Idx], p95: sorted[p95Idx] };
}

/**
 * Run a single retriever and return metrics + latencies.
 *
 * @param {import('./loaders/locomo.js').CorpusConversation[]} corpus
 * @param {Function} [retriever]
 * @returns {Promise<{ metrics: import('./metrics/retrieval.js').MetricsResult, latencies: number[] }>}
 */
async function runOne(corpus, retriever) {
    const result = await runHarness({ corpus, retriever });
    const metrics = computeMetrics(result.runs);
    const latencies = result.runs.map(r => r.latencyMs);
    return { metrics, latencies, envSnapshot: result.envSnapshot };
}

/**
 * Compute metrics for a subset of runs filtered by category.
 *
 * @param {import('./loaders/locomo.js').CorpusConversation[]} corpus
 * @param {Function} [retriever]
 * @param {string} category
 * @returns {Promise<{ metrics: import('./metrics/retrieval.js').MetricsResult, latencies: number[] }>}
 */
async function runOneCategory(corpus, retriever, category) {
    const result = await runHarness({ corpus, retriever });
    const filtered = result.runs.filter(r => r.qa.category === category);
    const metrics = computeMetrics(filtered);
    const latencies = filtered.map(r => r.latencyMs);
    return { metrics, latencies };
}

/**
 * Format a number to 4 decimal places.
 *
 * @param {number} n
 * @returns {string}
 */
function f4(n) {
    return n.toFixed(4);
}

/**
 * Format a number to 2 decimal places.
 *
 * @param {number} n
 * @returns {string}
 */
function f2(n) {
    return n.toFixed(2);
}

/**
 * Render the comparison Markdown report.
 *
 * @param {object} results
 * @param {import('./loaders/locomo.js').CorpusConversation[]} corpus
 * @param {object} envSnapshot
 * @returns {string}
 */
function renderReport(results, corpus, envSnapshot) {
    const today = new Date().toISOString().slice(0, 10);
    const qaCount = corpus.reduce((sum, c) => sum + c.qa.length, 0);

    const retrievers = ['ladder', 'bm25only', 'recency', 'random'];

    // Overall metrics table
    const overallHeader = '| retriever | recallAt1 | recallAt3 | recallAt5 | recallAt10 | precisionAt1 | precisionAt3 | precisionAt5 | precisionAt10 | mrr | p50 (ms) | p95 (ms) |';
    const overallSep = '|---|---|---|---|---|---|---|---|---|---|---|---|';
    const overallRows = retrievers.map(id => {
        const r = results[id];
        const lat = latencyStats(r.latencies);
        return `| ${id} | ${f4(r.metrics.recallAtK[1])} | ${f4(r.metrics.recallAtK[3])} | ${f4(r.metrics.recallAtK[5])} | ${f4(r.metrics.recallAtK[10])} | ${f4(r.metrics.precisionAtK[1])} | ${f4(r.metrics.precisionAtK[3])} | ${f4(r.metrics.precisionAtK[5])} | ${f4(r.metrics.precisionAtK[10])} | ${f4(r.metrics.mrr)} | ${f2(lat.p50)} | ${f2(lat.p95)} |`;
    });

    // Discover categories at runtime
    const categories = [...new Set(corpus.flatMap(c => c.qa.map(q => q.category)))];

    // Per-category sections
    const categorySections = categories.map(cat => {
        const catItems = corpus.reduce((sum, c) => sum + c.qa.filter(q => q.category === cat).length, 0);
        const catHeader = '| retriever | recallAt5 | mrr | p50 |';
        const catSep = '|---|---|---|---|';
        const catRows = retrievers.map(id => {
            const r = results[id].categories[cat];
            if (!r) return `| ${id} | N/A | N/A | N/A |`;
            const lat = latencyStats(r.latencies);
            return `| ${id} | ${f4(r.metrics.recallAtK[5])} | ${f4(r.metrics.mrr)} | ${f2(lat.p50)} |`;
        });

        return `### Category: ${cat} (${catItems} items)

${catHeader}
${catSep}
${catRows.join('\n')}`;
    });

    // Interpretation
    const ladderMrr = results.ladder.metrics.mrr;
    const randomMrr = results.random.metrics.mrr;
    const bm25onlyMrr = results.bm25only.metrics.mrr;
    const recencyMrr = results.recency.metrics.mrr;

    let interpretation;
    if (Math.abs(ladderMrr - randomMrr) <= 0.02) {
        interpretation = '**STOP flag:** ladder ≈ random on this corpus (MRR diff ≤ 0.02). This indicates a structural bug — the scorer chain is not producing meaningful ranking signal. Do not proceed to retro without investigation.';
    } else if (Math.abs(ladderMrr - bm25onlyMrr) <= 0.02) {
        interpretation = '**Note:** ladder > random but ladder ≈ bm25only (MRR diff ≤ 0.02). The scorer chain (importance × recency × maturity) is not earning its keep on this corpus. File for sub-phase 9.5 investigation with real LLM extraction.';
    } else if (ladderMrr > bm25onlyMrr && bm25onlyMrr > recencyMrr && recencyMrr > randomMrr) {
        interpretation = '**Proceed:** ladder > bm25only > recency > random. The ladder is adding value over all baselines. Scorer chain and graph expansion are earning their keep.';
    } else {
        interpretation = '**Mixed signal:** ladder outperforms random, but the ordering among bm25only/recency is unexpected. Review corpus size and extraction quality before drawing conclusions.';
    }

    // Structural note for synthetic
    const isSynthetic = corpus.some(c => c.id.startsWith('synth-'));
    const structuralNote = isSynthetic
        ? '> Rule-based extractor + tiny corpus: expect flat metrics across all four retrievers. The ladder-vs-random invariant is the only structural signal here. Real LoCoMo numbers will come from the controller\'s follow-up run.'
        : '';

    const envBlock = '```json\n' + JSON.stringify(envSnapshot, null, 2) + '\n```';

    return `# Baseline comparison — ${today}

**Corpus:** ${corpus.length} conversations, ${qaCount} QA items
**Retrievers:** ladder (default), bm25only, recency, random

## Overall metrics

${overallHeader}
${overallSep}
${overallRows.join('\n')}

## Per-category breakdown

${categorySections.join('\n\n')}

## Interpretation

${interpretation}

## Structural notes

${structuralNote}

## envSnapshot

${envBlock}
`;
}

async function main() {
    const args = parseArgs();
    const maxConversations = args.conversations ? Number(args.conversations) : undefined;
    const synthetic = args.synthetic === 'true';

    const corpus = synthetic
        ? synthesizeSyntheticCorpus()
        : await loadLocomo({ maxConversations });

    console.log(`Running baseline comparison over ${corpus.length} conversations...`);

    // Run all four retrievers
    const retrievers = [
        { id: 'ladder', fn: undefined },
        { id: 'bm25only', fn: bm25only },
        { id: 'recency', fn: recency },
        { id: 'random', fn: random },
    ];

    /** @type {Record<string, { metrics: any, latencies: number[], categories: Record<string, { metrics: any, latencies: number[] }> }>} */
    const results = {};

    for (const { id, fn } of retrievers) {
        console.log(`  → ${id}...`);
        const { metrics, latencies, envSnapshot } = await runOne(corpus, fn);

        // Per-category breakdown
        const categories = [...new Set(corpus.flatMap(c => c.qa.map(q => q.category)))];
        /** @type {Record<string, { metrics: any, latencies: number[] }>} */
        const catResults = {};
        for (const cat of categories) {
            const { metrics: catMetrics, latencies: catLatencies } = await runOneCategory(corpus, fn, cat);
            catResults[cat] = { metrics: catMetrics, latencies: catLatencies };
        }

        results[id] = { metrics, latencies, categories: catResults, envSnapshot };
    }

    // Use ladder's envSnapshot as the canonical one
    const envSnapshot = results.ladder.envSnapshot;

    const today = new Date().toISOString().slice(0, 10);
    const outDir = path.join('docs', 'bench', 'baselines');
    const outPath = path.join(outDir, `${today}-comparison.md`);

    await mkdir(outDir, { recursive: true });
    await writeFile(outPath, renderReport(results, corpus, envSnapshot), 'utf8');
    console.log(`Report written to ${outPath}`);
}

main().catch(err => {
    console.error(err);
    process.exit(1);
});
