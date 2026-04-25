/**
 * CLI orchestrator for Fireworks Batch warmup.
 *
 * Usage:
 *   node bench/harness/fireworks-warmup.js submit --corpora locomo,longmemeval-s [--model ...] [--submission-id ...]
 *   node bench/harness/fireworks-warmup.js resume <submission-id>
 *   node bench/harness/fireworks-warmup.js continue <submission-id>
 *
 * @module bench/harness/fireworks-warmup
 * @see docs/plans/phase-12-task-6-fireworks-batch.md Task 4
 */

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdir, readFile, writeFile, rename } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';

import { enumerateWarmupBatches } from './warmup/enumerate.js';
import { createDataset, uploadJsonl, createJob, getJob, downloadResults } from './warmup/fireworks-batch.js';
import { ingestResults } from './warmup/cache-ingest.js';
import { getAdapter } from '../corpora/index.js';
import { EXTRACT_MAX_TOKENS } from '../../src/consolidation/extractFacts.js';
import { CONSOLIDATION } from '../../src/core/constants.js';

const DEFAULT_MODEL = 'accounts/fireworks/models/llama-v3p3-70b-instruct';
const DEFAULT_VLLM_MODEL = 'Qwen/Qwen3.6-35B-A3B-FP8';
const CACHE_DIR = path.resolve(
    fileURLToPath(new URL('.', import.meta.url)),
    '..', '.cache', 'extractions',
);
const SUBMISSION_ROOT = path.resolve(
    fileURLToPath(new URL('.', import.meta.url)),
    '..', '.cache', 'fireworks-warmup',
);

// ============================================================
// Pure exports for unit testing
// ============================================================

/**
 * Parse CLI argv into a structured object.
 *
 * @param {string[]} argv
 * @returns {{command: string, corpora?: string[], model?: string, submissionId?: string}}
 */
export function parseArgv(argv) {
    if (!Array.isArray(argv) || argv.length === 0) {
        throw new Error('unknown command');
    }

    const command = argv[0];
    if (command === 'submit') {
        const out = { command: 'submit', model: DEFAULT_MODEL };
        let i = 1;
        while (i < argv.length) {
            const flag = argv[i];
            if (flag === '--corpora') {
                const val = argv[++i];
                if (!val) throw new Error('submit requires --corpora <csv>');
                out.corpora = val.split(',').map(s => s.trim()).filter(Boolean);
            } else if (flag === '--model') {
                const val = argv[++i];
                if (!val) throw new Error('--model requires a value');
                out.model = val;
            } else if (flag === '--submission-id') {
                const val = argv[++i];
                if (!val) throw new Error('--submission-id requires a value');
                out.submissionId = val;
            } else {
                throw new Error(`unknown flag: ${flag}`);
            }
            i++;
        }
        if (!out.corpora || out.corpora.length === 0) {
            throw new Error('submit requires --corpora');
        }
        return out;
    }

    if (command === 'resume' || command === 'continue') {
        const submissionId = argv[1];
        if (!submissionId) {
            throw new Error(`${command} requires a submission-id positional argument`);
        }
        return { command, submissionId };
    }

    if (command === 'enumerate') {
        const outPath = argv[1];
        if (!outPath || outPath.startsWith('--')) {
            throw new Error('enumerate requires <out-path> as positional argument');
        }
        const out = { command: 'enumerate', outPath, model: DEFAULT_VLLM_MODEL };
        let i = 2;
        while (i < argv.length) {
            const flag = argv[i];
            if (flag === '--corpora') {
                const val = argv[++i];
                if (!val) throw new Error('enumerate requires --corpora <csv>');
                out.corpora = val.split(',').map(s => s.trim()).filter(Boolean);
            } else if (flag === '--model') {
                const val = argv[++i];
                if (!val) throw new Error('--model requires a value');
                out.model = val;
            } else if (flag === '--limit') {
                const val = Number(argv[++i]);
                if (!Number.isInteger(val) || val <= 0) {
                    throw new Error('--limit must be a positive integer');
                }
                out.limit = val;
            } else {
                throw new Error(`unknown flag: ${flag}`);
            }
            i++;
        }
        if (!out.corpora || out.corpora.length === 0) {
            throw new Error('enumerate requires --corpora');
        }
        return out;
    }

    throw new Error(`unknown command: ${command}`);
}

/**
 * State-machine transition for manifest.state.
 *
 * @param {string} state
 * @param {{jobState?: string}} [extras]
 * @returns {string}
 */
/**
 * Normalize Fireworks' job state to the bare form nextState() expects.
 *
 * Fireworks' batch jobs API returns proto enum strings in the
 * `JOB_STATE_COMPLETED` / `JOB_STATE_RUNNING` form (proto3 convention:
 * enum values include the enum type name as a prefix). The OpenAPI docs
 * render them bare (`COMPLETED`), matching the spec's state-machine
 * documentation. We accept both forms so we're robust regardless of
 * which the gateway returns in any given response.
 *
 * Observed on 2026-04-24: poll response had `"state": "JOB_STATE_COMPLETED"`;
 * our poll loop was comparing against `"COMPLETED"` and never transitioned.
 *
 * @param {string | undefined | null} raw
 * @returns {string}
 */
export function normalizeJobState(raw) {
    if (typeof raw !== 'string' || raw.length === 0) return 'UNKNOWN';
    return raw.startsWith('JOB_STATE_') ? raw.slice('JOB_STATE_'.length) : raw;
}

export function nextState(state, extras = {}) {
    switch (state) {
        case 'enumerated':
            return 'uploaded';
        case 'uploaded':
            return 'submitted';
        case 'submitted':
            return 'polling';
        case 'polling': {
            const jobState = extras.jobState;
            if (jobState === 'COMPLETED') return 'completed';
            if (jobState === 'RUNNING' || jobState === 'PENDING' || jobState === 'VALIDATING') return 'polling';
            if (jobState === 'EXPIRED') return 'expired';
            if (jobState === 'FAILED') return 'failed';
            throw new Error(`nextState: unhandled jobState '${jobState}' while polling`);
        }
        case 'completed':
            return 'ingested';
        case 'ingested':
        case 'failed':
            throw new Error(`nextState: terminal state '${state}'`);
        default:
            throw new Error(`nextState: unknown state '${state}'`);
    }
}

// ============================================================
// Manifest persistence helpers
// ============================================================

function submissionDir(submissionId) {
    return path.join(SUBMISSION_ROOT, submissionId);
}

async function readManifest(submissionId) {
    const p = path.join(submissionDir(submissionId), 'manifest.json');
    const raw = await readFile(p, 'utf8');
    return JSON.parse(raw);
}

async function writeManifest(manifest) {
    const dir = submissionDir(manifest.submissionId);
    await mkdir(dir, { recursive: true });
    // Atomic write: stage to tmp, then rename. Prevents a half-written
    // manifest.json surviving a SIGINT mid-serialization, which would
    // break JSON.parse on the next `resume`.
    const final = path.join(dir, 'manifest.json');
    const tmp = `${final}.tmp`;
    await writeFile(tmp, JSON.stringify(manifest, null, 2), 'utf8');
    await rename(tmp, final);
}

function generateSubmissionId() {
    const d = new Date();
    const yyyymmdd = `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`;
    const rand = randomBytes(3).toString('hex');
    return `starmem-${yyyymmdd}-${rand}`;
}

// ============================================================
// main() — only runs when invoked directly, not when imported
// ============================================================

async function main() {
    let parsed;
    try {
        parsed = parseArgv(process.argv.slice(2));
    } catch (err) {
        console.error(`fireworks-warmup: ${err.message}`);
        process.exit(2);
    }

    if (parsed.command === 'enumerate') {
        return runEnumerate(parsed);
    }

    // Validate env — only needed for Fireworks commands
    const apiKey = process.env.FIREWORKS_API_KEY;
    const accountId = process.env.FIREWORKS_ACCOUNT_ID;
    if (!apiKey || !accountId) {
        console.error('fireworks-warmup: FIREWORKS_API_KEY and FIREWORKS_ACCOUNT_ID required');
        process.exit(2);
    }
    const auth = { accountId, apiKey };

    if (parsed.command === 'submit') {
        await runSubmit(auth, parsed);
    } else if (parsed.command === 'resume') {
        await runResume(auth, parsed.submissionId);
    } else if (parsed.command === 'continue') {
        await runContinue(auth, parsed.submissionId);
    }
}

/**
 * Emit enumerated WarmupBatch entries as JSONL (no API calls).
 *
 * @param {{outPath: string, corpora: string[], model: string, limit?: number}} args
 */
export async function runEnumerate(args) {
    const { outPath, corpora, model, limit } = args;

    /** @type {Array<import('./warmup/enumerate.js').WarmupBatch>} */
    let batches = [];
    for (const corpusName of corpora) {
        const adapter = getAdapter(corpusName);
        const items = await adapter.loadConversations({ offline: true });
        const corpusBatches = enumerateWarmupBatches(items, {
            model,
            extractMaxTokens: EXTRACT_MAX_TOKENS,
            batchSize: CONSOLIDATION.BATCH_SIZE,
        });
        // eslint-disable-next-line no-console
        console.error(`[enumerate] ${corpusName}: ${items.length} items → ${corpusBatches.length} batches`);
        batches = batches.concat(corpusBatches);
    }

    if (limit) {
        batches = batches.slice(0, limit);
        // eslint-disable-next-line no-console
        console.error(`[enumerate] --limit ${limit} applied → emitting ${batches.length} batches`);
    }

    await mkdir(path.dirname(outPath), { recursive: true });
    const lines = batches.map(b => JSON.stringify({
        customId: b.customId,
        model: b.model,
        messages: b.messages,
        maxTokens: b.maxTokens,
        itemId: b.itemId,
        batchIdxInItem: b.batchIdxInItem,
    }));
    await writeFile(outPath, lines.join('\n') + '\n', 'utf8');

    // eslint-disable-next-line no-console
    console.error(`[enumerate] wrote ${batches.length} batches → ${outPath}`);
    return { batchCount: batches.length, outPath };
}

async function runSubmit(auth, parsed) {
    // 1. Generate submissionId if not provided
    const submissionId = parsed.submissionId || generateSubmissionId();

    // 2. Load each corpus and concatenate items
    /** @type {Array<{id: string, turns: Array<{text: string}>}>} */
    const allItems = [];
    for (const name of parsed.corpora) {
        const adapter = getAdapter(name);
        const items = await adapter.loadConversations({ offline: true });
        allItems.push(...items);
    }

    // 3. Enumerate batches
    const batches = enumerateWarmupBatches(allItems, {
        model: parsed.model,
        extractMaxTokens: EXTRACT_MAX_TOKENS,
        batchSize: CONSOLIDATION.BATCH_SIZE,
    });

    // 4. Smoke limit gate
    const smokeLimit = Number(process.env.STARMEM_FIREWORKS_SMOKE_LIMIT || '0');
    let effectiveBatches = batches;
    if (smokeLimit > 0 && batches.length > smokeLimit) {
        console.error(`[smoke] truncated batches to ${smokeLimit}`);
        effectiveBatches = batches.slice(0, smokeLimit);
    }

    console.error(`[submit] submissionId=${submissionId} corpora=${parsed.corpora.join(',')} batches=${effectiveBatches.length}`);

    // 5. Write JSONL
    const dir = submissionDir(submissionId);
    await mkdir(dir, { recursive: true });
    const jsonlPath = path.join(dir, 'input.jsonl');
    const lines = effectiveBatches.map(batch => JSON.stringify({
        custom_id: batch.customId,
        body: {
            messages: batch.messages,
            max_tokens: batch.maxTokens,
            temperature: 0,
        },
    }));
    await writeFile(jsonlPath, lines.join('\n') + '\n', 'utf8');

    // 6. Create initial manifest
    const manifest = {
        submissionId,
        model: parsed.model,
        corpora: parsed.corpora,
        maxTokens: EXTRACT_MAX_TOKENS,
        batchSize: CONSOLIDATION.BATCH_SIZE,
        createdAt: new Date().toISOString(),
        state: 'enumerated',
        inputDatasetId: `${submissionId}-in`,
        jobChain: [],
        batchCount: effectiveBatches.length,
        lastPolledAt: null,
        lastPolledState: null,
        ingestStats: { written: 0, skipped: 0, errors: [] },
    };
    await writeManifest(manifest);
    console.error(`[submit] state=enumerated`);

    // 7. Drive the rest
    await advanceFromEnumerated(auth, manifest);
}

async function runResume(auth, submissionId) {
    let manifest;
    try {
        manifest = await readManifest(submissionId);
    } catch (err) {
        if (/** @type {any} */ (err).code === 'ENOENT') {
            console.error(`fireworks-warmup: submission ${submissionId} not found`);
            process.exit(3);
        }
        throw err;
    }

    if (manifest.state === 'ingested') {
        console.error(`fireworks-warmup: submission ${submissionId} already ingested`);
        process.exit(0);
    }
    if (manifest.state === 'expired') {
        console.error(`fireworks-warmup: submission ${submissionId} expired. Use \`continue <id>\` to create a new job from where it left off.`);
        process.exit(5);
    }
    if (manifest.state === 'failed') {
        console.error(`fireworks-warmup: submission ${submissionId} failed. Resume is blocked; rm -rf ${submissionDir(submissionId)} and resubmit.`);
        process.exit(4);
    }

    // Dispatch on current state
    if (manifest.state === 'enumerated') {
        await advanceFromEnumerated(auth, manifest);
    } else if (manifest.state === 'uploaded') {
        await advanceFromUploaded(auth, manifest);
    } else if (manifest.state === 'submitted') {
        await enterPollLoop(auth, manifest);
    } else if (manifest.state === 'polling') {
        await enterPollLoop(auth, manifest);
    } else if (manifest.state === 'completed') {
        await advanceFromCompleted(auth, manifest);
    }
}

async function runContinue(auth, submissionId) {
    let manifest;
    try {
        manifest = await readManifest(submissionId);
    } catch (err) {
        if (/** @type {any} */ (err).code === 'ENOENT') {
            console.error(`fireworks-warmup: submission ${submissionId} not found`);
            process.exit(3);
        }
        throw err;
    }

    const last = manifest.jobChain[manifest.jobChain.length - 1];
    if (!(manifest.state === 'expired' || manifest.state === 'failed')) {
        console.error(`fireworks-warmup: continue requires state=expired or state=failed; got ${manifest.state}`);
        process.exit(2);
    }

    // New jobId = `${submissionId}-c${N}` where N = existing chain length.
    // First continuation is -c1, second is -c2. Preserves chronology + keeps
    // the audit trail tied to the original submission rather than producing
    // a fresh-looking id on each continue.
    const continueN = manifest.jobChain.length;
    const newJobId = `${manifest.submissionId}-c${continueN}`;
    const newOutputDatasetId = `${newJobId}-out`;

    // Do NOT pre-create the output dataset — Fireworks creates it when the
    // continuation job completes. See advanceFromUploaded comment.

    // Create job with continueFrom. Same inferenceParameters pinning as
    // advanceFromUploaded — the continuation job is a fresh job on Fireworks
    // and carries its own job-level defaults.
    await createJob(auth, newJobId, {
        model: manifest.model,
        inputDatasetId: manifest.inputDatasetId,
        outputDatasetId: newOutputDatasetId,
        continueFromJobId: last.jobId,
        inferenceParameters: {
            max_tokens: manifest.maxTokens,
            temperature: 0,
        },
    });

    // Append to jobChain
    manifest.jobChain.push({
        jobId: newJobId,
        outputDatasetId: newOutputDatasetId,
        state: 'PENDING',
        continueFrom: last.jobId,
        submittedAt: new Date().toISOString(),
        terminalAt: null,
    });

    manifest.state = 'submitted';
    await writeManifest(manifest);
    console.error(`[continue] newJobId=${newJobId} continueFrom=${last.jobId}`);

    await enterPollLoop(auth, manifest);
}

// ============================================================
// Advance helpers
// ============================================================

async function advanceFromEnumerated(auth, manifest) {
    // Upload JSONL
    const jsonlPath = path.join(submissionDir(manifest.submissionId), 'input.jsonl');
    // exampleCount is required by Fireworks on dataset create for userUploaded
    // datasets and must match the JSONL row count of the subsequent upload.
    await createDataset(auth, manifest.inputDatasetId, { exampleCount: manifest.batchCount });
    await uploadJsonl(auth, manifest.inputDatasetId, jsonlPath);

    manifest.state = nextState('enumerated');
    await writeManifest(manifest);
    console.error(`[submit] state=enumerated → uploaded`);

    await advanceFromUploaded(auth, manifest);
}

async function advanceFromUploaded(auth, manifest) {
    const jobId = manifest.submissionId;
    const outputDatasetId = `${jobId}-out`;

    // Do NOT pre-create the output dataset. Fireworks batch jobs create it
    // themselves on successful completion; pre-creating as userUploaded-empty
    // fails validation later. We just reserve the name.
    //
    // inferenceParameters pins temperature=0 at the JOB level as defense in
    // depth. Our per-row body already sets max_tokens + temperature=0, but
    // the job-level defaults surface in the Fireworks dashboard as "Not set"
    // if omitted, and any future code path that drops the per-row override
    // would fall back to Fireworks' default (~1.0) — silently breaking the
    // deterministic-extraction contract. Proto-shape keys (snake_case).
    await createJob(auth, jobId, {
        model: manifest.model,
        inputDatasetId: manifest.inputDatasetId,
        outputDatasetId,
        inferenceParameters: {
            max_tokens: manifest.maxTokens,
            temperature: 0,
        },
    });

    manifest.jobChain.push({
        jobId,
        outputDatasetId,
        state: 'PENDING',
        continueFrom: null,
        submittedAt: new Date().toISOString(),
        terminalAt: null,
    });

    manifest.state = nextState('uploaded');
    await writeManifest(manifest);
    console.error(`[submit] state=uploaded → submitted`);

    await enterPollLoop(auth, manifest);
}

async function enterPollLoop(auth, manifest) {
    const activeJob = manifest.jobChain[manifest.jobChain.length - 1];
    const t0 = Date.now();

    // Ensure state is at least polling
    if (manifest.state === 'submitted') {
        manifest.state = nextState('submitted');
        await writeManifest(manifest);
    }

    // eslint-disable-next-line no-constant-condition
    while (true) {
        const job = await getJob(auth, activeJob.jobId);
        const jobState = normalizeJobState(job.state);
        const elapsedMs = Date.now() - t0;
        const elapsedStr = formatElapsed(elapsedMs);

        manifest.lastPolledAt = new Date().toISOString();
        manifest.lastPolledState = jobState;
        await writeManifest(manifest);

        console.error(`[poll] ${jobState} elapsed=${elapsedStr}`);

        if (jobState === 'COMPLETED') {
            manifest.state = nextState('polling', { jobState: 'COMPLETED' });
            activeJob.state = 'COMPLETED';
            activeJob.terminalAt = new Date().toISOString();
            await writeManifest(manifest);
            await advanceFromCompleted(auth, manifest);
            return;
        }

        if (jobState === 'EXPIRED') {
            manifest.state = nextState('polling', { jobState: 'EXPIRED' });
            activeJob.state = 'EXPIRED';
            activeJob.terminalAt = new Date().toISOString();
            await writeManifest(manifest);
            console.error(`fireworks-warmup: job ${activeJob.jobId} expired`);
            process.exit(5);
        }

        if (jobState === 'FAILED') {
            manifest.state = nextState('polling', { jobState: 'FAILED' });
            activeJob.state = 'FAILED';
            activeJob.terminalAt = new Date().toISOString();
            await writeManifest(manifest);
            console.error(`fireworks-warmup: job ${activeJob.jobId} failed`);
            process.exit(4);
        }

        // RUNNING, PENDING, VALIDATING — keep polling
        await sleep(60_000);
    }
}

async function advanceFromCompleted(auth, manifest) {
    const dir = submissionDir(manifest.submissionId);
    let totalWritten = 0;
    let totalSkipped = 0;
    const allErrors = [];

    for (let i = 0; i < manifest.jobChain.length; i++) {
        const entry = manifest.jobChain[i];
        let resultsPath;
        try {
            ({ resultsPath } = await downloadResults(auth, entry.outputDatasetId, dir));
        } catch (err) {
            const e = /** @type {any} */ (err);
            throw new Error(
                `fireworks-warmup: downloadResults failed on jobChain[${i}] ` +
                `(jobId=${entry.jobId} outputDatasetId=${entry.outputDatasetId}): ${e?.message ?? String(err)}`,
            );
        }
        const stats = await ingestResults(resultsPath, {
            cacheDir: CACHE_DIR,
            model: manifest.model,
            maxTokens: manifest.maxTokens,
        });
        totalWritten += stats.written;
        totalSkipped += stats.skipped;
        allErrors.push(...stats.errors);
        console.error(`[ingest] jobChain[${i}]=${entry.jobId} written=${stats.written} skipped=${stats.skipped}`);
    }

    manifest.state = nextState('completed');
    manifest.ingestStats = {
        written: totalWritten,
        skipped: totalSkipped,
        errors: allErrors.slice(0, 100), // cap persisted errors
    };
    await writeManifest(manifest);

    const summary = {
        submissionId: manifest.submissionId,
        state: manifest.state,
        jobChainLength: manifest.jobChain.length,
        written: totalWritten,
        skipped: totalSkipped,
        errorCount: allErrors.length,
    };
    console.log(JSON.stringify(summary));
}

// ============================================================
// Utilities
// ============================================================

function formatElapsed(ms) {
    const totalSeconds = Math.floor(ms / 1000);
    const m = Math.floor(totalSeconds / 60);
    const s = totalSeconds % 60;
    return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

function sleep(ms) {
    return new Promise(r => setTimeout(r, ms));
}

// Run main() only if invoked as the script entrypoint, not when imported.
const isMain = import.meta.url === `file://${process.argv[1]}`;
if (isMain) {
    main().catch(err => {
        console.error(err.message);
        process.exit(1);
    });
}
