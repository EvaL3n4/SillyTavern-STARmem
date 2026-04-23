/**
 * Thin HTTP client for the Fireworks Batch Inference API.
 *
 * Five operations: create dataset, upload JSONL, create batch job, poll job,
 * download results.  All operations retry 5xx / network errors with exponential
 * backoff; 4xx fails fast.  Built on global fetch + FormData — no external
 * npm packages.
 *
 * @module bench/harness/warmup/fireworks-batch
 * @see docs/plans/phase-12-task-6-fireworks-batch.md Task 2
 */

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { basename } from 'node:path';

const FIREWORKS_BASE = 'https://api.fireworks.ai/v1';

/**
 * @typedef {object} FireworksAuth
 * @property {string} accountId
 * @property {string} apiKey
 */

/**
 * Shared request helper with retry logic.
 *
 * Retry policy (mirrors llmExtractor.js):
 *   - 4xx HTTP → fail fast (err.retryable = false)
 *   - 5xx HTTP → retry up to maxRetries with exponential backoff
 *   - Network errors (fetch throws) → same retry
 *   - Backoff: 200 ms × 2^attempt, capped at 5 s
 *   - Final error message includes attempt count for triage
 *
 * @param {FireworksAuth} auth
 * @param {string} path          - API path (e.g. /accounts/{a}/datasets)
 * @param {object} [opts]
 * @param {string} [opts.method='GET']
 * @param {Record<string,string>} [opts.headers]
 * @param {BodyInit|null} [opts.body]
 * @param {number} [opts.maxRetries=3]
 * @returns {Promise<any>}
 */
async function _request(auth, path, opts = {}) {
    const { method = 'GET', body, headers = {}, maxRetries = 3 } = opts;

    if (!auth?.accountId || !auth?.apiKey) {
        throw new Error('fireworks-batch: auth must include accountId and apiKey');
    }

    const url = `${FIREWORKS_BASE}${path}`;
    /** @type {Error|null} */
    let lastError = null;

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
        try {
            const res = await fetch(url, {
                method,
                headers: {
                    Authorization: `Bearer ${auth.apiKey}`,
                    ...headers,
                },
                body,
            });

            if (!res.ok) {
                const text = await res.text().catch(() => '');
                const err = /** @type {any} */ (new Error(
                    `fireworks-batch: ${method} ${path} → ${res.status} ${res.statusText} — ${text.slice(0, 200)}`,
                ));
                if (res.status >= 400 && res.status < 500) {
                    err.retryable = false;
                    throw err;
                }
                lastError = err;
            } else {
                const ct = res.headers.get('content-type') || '';
                return ct.includes('application/json') ? await res.json() : await res.text();
            }
        } catch (err) {
            const e = /** @type {any} */ (err);
            if (e?.retryable === false) {
                throw e;
            }
            lastError = /** @type {Error} */ (err);
        }

        if (attempt < maxRetries) {
            const delayMs = Math.min(5000, 200 * 2 ** attempt);
            await new Promise(r => setTimeout(r, delayMs));
        }
    }

    const finalMsg = lastError?.message ?? 'unknown failure';
    throw new Error(`fireworks-batch: failed after ${maxRetries + 1} attempts — ${finalMsg}`);
}

/**
 * Create a user-uploaded dataset placeholder.
 *
 * @param {FireworksAuth} auth
 * @param {string} datasetId
 * @returns {Promise<any>}
 */
/**
 * Create a user-uploaded dataset placeholder that a subsequent uploadJsonl
 * call will populate.
 *
 * Fireworks requires `exampleCount` on dataset create (confirmed via 400
 * `error validating dataset: example_count is required for uploaded datasets`
 * on 2026-04-24). The count must match the number of JSONL rows uploaded
 * next, or validation during the batch job's VALIDATING state fails.
 *
 * @param {{accountId: string, apiKey: string}} auth
 * @param {string} datasetId
 * @param {object} [opts]
 * @param {number} [opts.exampleCount]  Required for user-uploaded datasets; the
 *     JSONL row count. Fireworks rejects the create otherwise.
 */
export async function createDataset(auth, datasetId, opts = {}) {
    const { exampleCount } = opts;
    if (exampleCount !== undefined
        && (!Number.isInteger(exampleCount) || exampleCount <= 0)) {
        throw new Error(
            `fireworks-batch.createDataset: exampleCount must be a positive integer, got ${exampleCount}`,
        );
    }
    /** @type {Record<string, unknown>} */
    const dataset = { userUploaded: {} };
    /** @type {Record<string, unknown>} */
    const body = { datasetId, dataset };
    if (exampleCount !== undefined) {
        // `example_count` nests INSIDE the dataset object (gatewayDataset
        // proto), not at the top level of the request body. The Fireworks
        // gateway preserves proto field names on the wire (snake_case),
        // despite the OpenAPI docs rendering camelCase. Int64 fields travel
        // as strings per proto3 JSON convention.
        //
        // Two prior smoke-time 400s (2026-04-24) ruled out the alternatives:
        //   - `{ ..., exampleCount: "42" }` at top level → unknown field
        //   - `{ ..., example_count: "42" }` at top level → unknown field
        dataset.example_count = String(exampleCount);
    }
    return _request(auth, `/accounts/${auth.accountId}/datasets`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
    });
}

/**
 * Upload a local JSONL file into a dataset.
 *
 * @param {FireworksAuth} auth
 * @param {string} datasetId
 * @param {string} localPath
 * @returns {Promise<any>}
 */
export async function uploadJsonl(auth, datasetId, localPath) {
    const buf = await readFile(localPath);
    const form = new FormData();
    form.append('file', new Blob([buf], { type: 'application/x-ndjson' }), basename(localPath));

    return _request(auth, `/accounts/${auth.accountId}/datasets/${datasetId}:upload`, {
        method: 'POST',
        body: form,
    });
}

/**
 * Create a batch inference job.
 *
 * @param {FireworksAuth} auth
 * @param {string} jobId
 * @param {object} opts
 * @param {string} opts.model
 * @param {string} opts.inputDatasetId
 * @param {string} opts.outputDatasetId
 * @param {object} [opts.inferenceParameters]
 * @param {string} [opts.continueFromJobId]
 * @returns {Promise<any>}
 */
export async function createJob(auth, jobId, opts) {
    const { model, inputDatasetId, outputDatasetId, inferenceParameters, continueFromJobId } = opts;

    const body = {
        model,
        inputDatasetId: `accounts/${auth.accountId}/datasets/${inputDatasetId}`,
        outputDatasetId: `accounts/${auth.accountId}/datasets/${outputDatasetId}`,
    };

    if (inferenceParameters) {
        body.inferenceParameters = inferenceParameters;
    }
    if (continueFromJobId) {
        body.continueFrom = `accounts/${auth.accountId}/batchInferenceJobs/${continueFromJobId}`;
    }

    return _request(auth, `/accounts/${auth.accountId}/batchInferenceJobs?batchInferenceJobId=${jobId}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
    });
}

/**
 * Poll a batch inference job.
 *
 * @param {FireworksAuth} auth
 * @param {string} jobId
 * @returns {Promise<any>}
 */
export async function getJob(auth, jobId) {
    return _request(auth, `/accounts/${auth.accountId}/batchInferenceJobs/${jobId}`);
}

/**
 * Download result files from a dataset.
 *
 * Fetches the signed download endpoint, then downloads each signed URL into
 * destDir.  Signed URLs do not carry the Authorization header.
 *
 * @param {FireworksAuth} auth
 * @param {string} datasetId
 * @param {string} destDir
 * @returns {Promise<{resultsPath: string, errorsPath: string|null}>}
 */
export async function downloadResults(auth, datasetId, destDir) {
    const endpoint = await _request(
        auth,
        `/accounts/${auth.accountId}/datasets/${datasetId}:getDownloadEndpoint`,
        {
            method: 'GET',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({}),
        },
    );

    const map = endpoint?.filenameToSignedUrls || {};
    const resultsKey = Object.keys(map).find(k => /results.*\.jsonl/i.test(k));
    const errorsKey = Object.keys(map).find(k => /errors.*\.jsonl/i.test(k));

    if (!resultsKey) {
        throw new Error('fireworks-batch: no results file found in download endpoint response');
    }

    await mkdir(destDir, { recursive: true });

    /** @type {string|null} */
    let resultsPath = null;
    /** @type {string|null} */
    let errorsPath = null;

    const resultsUrl = map[resultsKey];
    const resultsDest = `${destDir}/${resultsKey}`;
    const resRes = await fetch(resultsUrl);
    if (!resRes.ok) {
        throw new Error(`fireworks-batch: failed to download results — ${resRes.status} ${resRes.statusText}`);
    }
    await writeFile(resultsDest, Buffer.from(await resRes.arrayBuffer()));
    resultsPath = resultsDest;

    if (errorsKey) {
        const errorsUrl = map[errorsKey];
        const errorsDest = `${destDir}/${errorsKey}`;
        const errRes = await fetch(errorsUrl);
        if (!errRes.ok) {
            throw new Error(`fireworks-batch: failed to download errors — ${errRes.status} ${errRes.statusText}`);
        }
        await writeFile(errorsDest, Buffer.from(await errRes.arrayBuffer()));
        errorsPath = errorsDest;
    }

    return { resultsPath, errorsPath };
}
