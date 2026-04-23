/**
 * Ingest Fireworks Batch results JSONL → extractionCache-compatible files.
 *
 * Byte-compatibility contract with bench/harness/extractionCache.js:
 *   - filename is `${customId}.json` under opts.cacheDir
 *   - content is JSON.stringify({model, maxTokens, response, at}, null, 2)
 *     where keys appear in that exact insertion order
 *
 * @module bench/harness/warmup/cache-ingest
 * @see docs/plans/phase-12-task-6-fireworks-batch.md Task 3
 */

import { createReadStream } from 'node:fs';
import { writeFile, mkdir } from 'node:fs/promises';
import { createInterface } from 'node:readline';
import path from 'node:path';

/**
 * @param {string} resultsJsonlPath
 * @param {object} opts
 * @param {string} opts.cacheDir
 * @param {string} opts.model
 * @param {number} opts.maxTokens
 * @returns {Promise<{written: number, skipped: number, errors: Array<{customId: string, reason: string}>}>}
 */
export async function ingestResults(resultsJsonlPath, opts) {
    const { cacheDir, model, maxTokens } = opts;
    if (typeof cacheDir !== 'string' || cacheDir.length === 0) {
        throw new Error('ingestResults: opts.cacheDir required');
    }
    if (typeof model !== 'string' || model.length === 0) {
        throw new Error('ingestResults: opts.model required');
    }
    if (!Number.isInteger(maxTokens) || maxTokens <= 0) {
        throw new Error('ingestResults: opts.maxTokens must be a positive integer');
    }

    await mkdir(cacheDir, { recursive: true });

    let written = 0;
    let skipped = 0;
    /** @type {Array<{customId: string, reason: string}>} */
    const errors = [];

    const stream = createReadStream(resultsJsonlPath, { encoding: 'utf8' });
    const rl = createInterface({ input: stream, crlfDelay: Infinity });

    for await (const line of rl) {
        if (line.trim().length === 0) continue;
        /** @type {any} */
        let row;
        try {
            row = JSON.parse(line);
        } catch (err) {
            skipped++;
            errors.push({ customId: '(unparseable)', reason: `JSON parse: ${err.message.slice(0, 120)}` });
            continue;
        }
        const customId = row?.custom_id;
        if (typeof customId !== 'string' || customId.length === 0) {
            skipped++;
            errors.push({ customId: '(missing)', reason: 'row missing custom_id' });
            continue;
        }
        // Status-code semantics differ between Fireworks Batch Inference
        // (BIJ) and OpenAI's Batch API. Fireworks' per-row output omits
        // status_code entirely — failures land in a sibling error-data file.
        // OpenAI's wrapper nests {status_code, body: {...}}. Accept both:
        //   - Fireworks BIJ shape: response.choices[0], no status_code
        //   - OpenAI Batch shape:  response.status_code, response.body.choices[0]
        // Only reject when status_code is explicitly present AND not 200.
        const status = row?.response?.status_code;
        if (status !== undefined && status !== 200) {
            skipped++;
            errors.push({ customId, reason: `status_code=${status}` });
            continue;
        }
        // Try Fireworks BIJ shape first (choices at response level),
        // fall back to OpenAI Batch shape (choices at response.body level).
        const choice = row?.response?.choices?.[0] ?? row?.response?.body?.choices?.[0];
        const content = choice?.message?.content;
        if (typeof content !== 'string' || content.length === 0) {
            skipped++;
            errors.push({ customId, reason: 'message.content missing or empty' });
            continue;
        }
        const finish = choice?.finish_reason;
        if (finish !== 'stop') {
            skipped++;
            errors.push({ customId, reason: `finish_reason=${finish}` });
            continue;
        }

        const file = path.join(cacheDir, `${customId}.json`);
        const body = JSON.stringify(
            { model, maxTokens, response: content, at: new Date().toISOString() },
            null,
            2,
        );
        try {
            await writeFile(file, body, 'utf8');
            written++;
        } catch (err) {
            skipped++;
            errors.push({ customId, reason: `write failed: ${err.message.slice(0, 120)}` });
        }
    }

    return { written, skipped, errors };
}
