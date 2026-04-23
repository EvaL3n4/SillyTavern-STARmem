import { mkdtemp, writeFile, readFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { ingestResults } from '../../../../bench/harness/warmup/cache-ingest.js';

describe('ingestResults', () => {
    let tmp;

    beforeEach(async () => {
        tmp = await mkdtemp(path.join(tmpdir(), 'starmem-ingest-'));
    });

    test('writes one cache file per 200-status row', async () => {
        const results = path.join(tmp, 'results.jsonl');
        const cacheDir = path.join(tmp, 'cache');
        await writeFile(results, [
            JSON.stringify({
                custom_id: 'aaa',
                response: {
                    status_code: 200,
                    body: { choices: [{ message: { content: '{"entries":[]}' }, finish_reason: 'stop' }] },
                },
            }),
            JSON.stringify({
                custom_id: 'bbb',
                response: {
                    status_code: 200,
                    body: { choices: [{ message: { content: '{"entries":[{"content":"x","subject":"X"}]}' }, finish_reason: 'stop' }] },
                },
            }),
        ].join('\n'));

        const stats = await ingestResults(results, {
            cacheDir,
            model: 'accounts/fireworks/models/llama-v3p3-70b-instruct',
            maxTokens: 2048,
        });

        expect(stats.written).toBe(2);
        expect(stats.skipped).toBe(0);
        expect(stats.errors).toEqual([]);

        const files = await readdir(cacheDir);
        expect(files.sort()).toEqual(['aaa.json', 'bbb.json']);
    });

    test('written file round-trips through wrapWithCache read path', async () => {
        const results = path.join(tmp, 'results.jsonl');
        const cacheDir = path.join(tmp, 'cache');
        await writeFile(results, JSON.stringify({
            custom_id: 'zzz',
            response: {
                status_code: 200,
                body: { choices: [{ message: { content: 'HELLO' }, finish_reason: 'stop' }] },
            },
        }));
        await ingestResults(results, {
            cacheDir,
            model: 'some-model',
            maxTokens: 1024,
        });
        const raw = await readFile(path.join(cacheDir, 'zzz.json'), 'utf8');
        const parsed = JSON.parse(raw);
        expect(parsed.response).toBe('HELLO');
        expect(parsed.model).toBe('some-model');
        expect(parsed.maxTokens).toBe(1024);
        expect(typeof parsed.at).toBe('string');
    });

    test('skips rows with non-200 status_code', async () => {
        const results = path.join(tmp, 'results.jsonl');
        const cacheDir = path.join(tmp, 'cache');
        await writeFile(results, JSON.stringify({
            custom_id: 'fail',
            response: { status_code: 500, body: { error: 'upstream' } },
        }));
        const stats = await ingestResults(results, {
            cacheDir,
            model: 'm',
            maxTokens: 512,
        });
        expect(stats.written).toBe(0);
        expect(stats.skipped).toBe(1);
        expect(stats.errors).toHaveLength(1);
        expect(stats.errors[0].customId).toBe('fail');
    });

    test('skips rows with null/empty content', async () => {
        const results = path.join(tmp, 'results.jsonl');
        const cacheDir = path.join(tmp, 'cache');
        await writeFile(results, [
            JSON.stringify({
                custom_id: 'empty',
                response: {
                    status_code: 200,
                    body: { choices: [{ message: { content: '' }, finish_reason: 'stop' }] },
                },
            }),
            JSON.stringify({
                custom_id: 'null',
                response: {
                    status_code: 200,
                    body: { choices: [{ message: { content: null }, finish_reason: 'stop' }] },
                },
            }),
        ].join('\n'));
        const stats = await ingestResults(results, {
            cacheDir,
            model: 'm',
            maxTokens: 512,
        });
        expect(stats.written).toBe(0);
        expect(stats.skipped).toBe(2);
    });

    test('skips rows with finish_reason != stop', async () => {
        const results = path.join(tmp, 'results.jsonl');
        const cacheDir = path.join(tmp, 'cache');
        await writeFile(results, JSON.stringify({
            custom_id: 'trunc',
            response: {
                status_code: 200,
                body: { choices: [{ message: { content: '{"entries":...' }, finish_reason: 'length' }] },
            },
        }));
        const stats = await ingestResults(results, {
            cacheDir,
            model: 'm',
            maxTokens: 512,
        });
        expect(stats.written).toBe(0);
        expect(stats.skipped).toBe(1);
        expect(stats.errors[0].reason).toMatch(/finish_reason/i);
    });

    test('tolerates empty JSONL file (zero rows, zero writes, zero errors)', async () => {
        const results = path.join(tmp, 'empty.jsonl');
        const cacheDir = path.join(tmp, 'cache');
        await writeFile(results, '');
        const stats = await ingestResults(results, {
            cacheDir,
            model: 'm',
            maxTokens: 512,
        });
        expect(stats).toEqual({ written: 0, skipped: 0, errors: [] });
    });
});
