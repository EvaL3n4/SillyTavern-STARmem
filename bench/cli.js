/**
 * Benchmark CLI entry point.
 *
 * node bench/cli.js [--corpus locomo] [--conversations N] [--scorer default]
 *                   [--overrides "TAU_CONFIDENCE=2.5,TAU_GAP=0.8"]
 *                   [--out docs/bench/runs/YYYY-MM-DD-HH-MM-SS.jsonl]
 *                   [--metrics-out docs/bench/runs/YYYY-MM-DD-HH-MM-SS.metrics.json]
 *                   [--offline]
 *
 * @module bench/cli
 * @see docs/plans/phase-9-benchmarking.md §Task 3 Step 6
 */

import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { runHarness } from './runner.js';
import { getAdapter } from './corpora/index.js';
import { initWeave } from './harness/trace.js';

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
 * Build an ISO-ish timestamp string for filenames.
 *
 * @returns {string}
 */
function timestamp() {
    const d = new Date();
    const pad = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}-${pad(d.getHours())}-${pad(d.getMinutes())}-${pad(d.getSeconds())}`;
}

/**
 * Parse an overrides string into a number-valued object.
 *
 * @param {string} str
 * @returns {Record<string, number>}
 */
function parseOverrides(str) {
    const out = {};
    for (const pair of str.split(',')) {
        const [key, val] = pair.split('=');
        if (key && val !== undefined) {
            out[key.trim()] = Number(val.trim());
        }
    }
    return out;
}

async function main() {
    const args = parseArgs();

    const corpusName = args.corpus ?? 'locomo';
    const maxConversations = args.conversations ? Number(args.conversations) : undefined;
    const scorerId = args.scorer ?? undefined;
    const overrides = args.overrides ? parseOverrides(args.overrides) : undefined;
    const offline = args.offline === 'true';

    const defaultOut = path.join('docs', 'bench', 'runs', `${timestamp()}.jsonl`);
    const outPath = args.out ?? defaultOut;
    const metricsPath = args['metrics-out'] ?? outPath.replace(/\.jsonl$/, '.metrics.json');

    const adapter = getAdapter(corpusName);  // throws with known-list on typos
    const corpus = await adapter.loadConversations({
        maxConversations,                                               // LoCoMo legacy
        maxItems: args['max-items'] ? Number(args['max-items']) : undefined,  // LongMemEval
        offline,
    });

    // Opt-in Weave tracing. No-op when WANDB_API_KEY / ~/.netrc absent,
    // or when WEAVE_DISABLED=1 is set. See bench/harness/trace.js.
    await initWeave('STARmem');

    const result = await runHarness({
        corpus,
        scorerId,
        overrides,
    });

    // Ensure parent directories exist
    await mkdir(path.dirname(outPath), { recursive: true });

    // Write JSONL — one line per run
    const jsonl = result.runs.map(run => JSON.stringify(run)).join('\n') + '\n';
    await writeFile(outPath, jsonl, 'utf8');

    // Write metrics + envSnapshot
    const metricsPayload = {
        metrics: result.metrics,
        envSnapshot: result.envSnapshot,
    };
    await writeFile(metricsPath, JSON.stringify(metricsPayload, null, 2), 'utf8');

    console.log('metrics:', JSON.stringify(result.metrics, null, 2));
    console.log('envSnapshot:', JSON.stringify(result.envSnapshot, null, 2));
}

main().catch(err => {
    console.error(err);
    process.exit(1);
});
