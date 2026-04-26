/**
 * Regression for finding #8: cache-ingest must reject customIds containing
 * path separators or absolute paths — they're only a basename.
 */
import { describe, test, expect, beforeEach, afterEach } from '@jest/globals';
import { writeFile, mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { ingestResults } from '../../../bench/harness/warmup/cache-ingest.js';

let cacheDir;

beforeEach(async () => { cacheDir = await mkdtemp(path.join(tmpdir(), 'starmem-cacheingest-')); });
afterEach(async () => { await rm(cacheDir, { recursive: true, force: true }); });

async function writeJsonl(pathArg, rows) {
    await writeFile(pathArg, rows.map(r => JSON.stringify(r)).join('\n') + '\n', 'utf8');
}

describe('cache-ingest customId validation', () => {
    test('rejects customId containing ..', async () => {
        const resultsPath = path.join(cacheDir, 'results.jsonl');
        await writeJsonl(resultsPath, [{
            custom_id: '../../../../tmp/evil',
            response: { choices: [{ message: { content: 'x' }, finish_reason: 'stop' }] },
        }]);
        const out = await ingestResults(resultsPath, {
            cacheDir, model: 'm', maxTokens: 10,
        });
        expect(out.written).toBe(0);
        expect(out.skipped).toBe(1);
        expect(out.errors[0].reason).toMatch(/path.*separator|invalid.*custom_id/i);
    });

    test('rejects customId that is an absolute path', async () => {
        const resultsPath = path.join(cacheDir, 'results.jsonl');
        await writeJsonl(resultsPath, [{
            custom_id: '/tmp/evil',
            response: { choices: [{ message: { content: 'x' }, finish_reason: 'stop' }] },
        }]);
        const out = await ingestResults(resultsPath, {
            cacheDir, model: 'm', maxTokens: 10,
        });
        expect(out.written).toBe(0);
        expect(out.skipped).toBe(1);
    });

    test('accepts a hex-digest customId and writes within cacheDir', async () => {
        const resultsPath = path.join(cacheDir, 'results.jsonl');
        await writeJsonl(resultsPath, [{
            custom_id: 'a3f124cde091b7c85f00',
            response: { choices: [{ message: { content: 'hello' }, finish_reason: 'stop' }] },
        }]);
        const out = await ingestResults(resultsPath, {
            cacheDir, model: 'm', maxTokens: 10,
        });
        expect(out.written).toBe(1);
        const files = await readdir(cacheDir);
        expect(files).toContain('a3f124cde091b7c85f00.json');
    });
});
