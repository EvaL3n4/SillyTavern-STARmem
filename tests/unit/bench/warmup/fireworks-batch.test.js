import { jest } from '@jest/globals';
import {
    createDataset,
    uploadJsonl,
    createJob,
    getJob,
    downloadResults,
} from '../../../../bench/harness/warmup/fireworks-batch.js';

describe('fireworks-batch client', () => {
    const AUTH = { accountId: 'test-account', apiKey: 'test-key' };
    let originalFetch;

    beforeEach(() => {
        originalFetch = global.fetch;
    });

    afterEach(() => {
        global.fetch = originalFetch;
    });

    test('createDataset sends POST to correct URL with correct body', async () => {
        const calls = [];
        global.fetch = jest.fn(async (url, opts) => {
            calls.push({ url, opts });
            return {
                ok: true,
                status: 200,
                json: async () => ({}),
                headers: new Headers({ 'content-type': 'application/json' }),
            };
        });

        await createDataset(AUTH, 'my-dataset');

        expect(calls).toHaveLength(1);
        expect(calls[0].url).toBe('https://api.fireworks.ai/v1/accounts/test-account/datasets');
        expect(calls[0].opts.method).toBe('POST');
        expect(calls[0].opts.headers.Authorization).toBe('Bearer test-key');
        const body = JSON.parse(calls[0].opts.body);
        expect(body.datasetId).toBe('my-dataset');
        expect(body.dataset).toEqual({ userUploaded: {} });
    });

    test('createDataset throws retryable=false on 4xx', async () => {
        global.fetch = jest.fn(async () => ({
            ok: false,
            status: 403,
            statusText: 'Forbidden',
            text: async () => 'nope',
            headers: new Headers(),
        }));

        await expect(createDataset(AUTH, 'ds')).rejects.toThrow(/403/);
        await expect(createDataset(AUTH, 'ds')).rejects.toThrow(/nope/);

        // Verify retryable flag by catching and inspecting
        let caught;
        try {
            await createDataset(AUTH, 'ds');
        } catch (err) {
            caught = err;
        }
        expect(caught.retryable).toBe(false);
        expect(global.fetch).toHaveBeenCalledTimes(3); // once per test assertion
    });

    test('createDataset retries on 5xx up to maxRetries then succeeds', async () => {
        jest.useFakeTimers();
        let calls = 0;
        global.fetch = jest.fn(async () => {
            calls++;
            if (calls < 3) {
                return {
                    ok: false,
                    status: 500,
                    statusText: 'Internal Server Error',
                    text: async () => 'err',
                    headers: new Headers(),
                };
            }
            return {
                ok: true,
                status: 200,
                json: async () => ({ success: true }),
                headers: new Headers({ 'content-type': 'application/json' }),
            };
        });

        const p = createDataset(AUTH, 'ds-retry');
        await jest.runAllTimersAsync();
        const result = await p;

        expect(calls).toBe(3);
        expect(result).toEqual({ success: true });
        expect(global.fetch).toHaveBeenCalledTimes(3);

        jest.useRealTimers();
    });

    test('uploadJsonl sends multipart/form-data with file field', async () => {
        const calls = [];
        global.fetch = jest.fn(async (url, opts) => {
            calls.push({ url, opts });
            return {
                ok: true,
                status: 200,
                json: async () => ({}),
                headers: new Headers({ 'content-type': 'application/json' }),
            };
        });

        await uploadJsonl(AUTH, 'my-ds', '/dev/null');

        expect(calls).toHaveLength(1);
        expect(calls[0].url).toBe('https://api.fireworks.ai/v1/accounts/test-account/datasets/my-ds:upload');
        expect(calls[0].opts.method).toBe('POST');
        expect(calls[0].opts.headers.Authorization).toBe('Bearer test-key');
        expect(calls[0].opts.body instanceof FormData).toBe(true);
        const file = calls[0].opts.body.get('file');
        expect(file).toBeTruthy();
        expect(file instanceof Blob).toBe(true);
    });

    test('createJob constructs fully-qualified input/output dataset refs', async () => {
        const calls = [];
        global.fetch = jest.fn(async (url, opts) => {
            calls.push({ url, opts });
            return {
                ok: true,
                status: 200,
                json: async () => ({}),
                headers: new Headers({ 'content-type': 'application/json' }),
            };
        });

        await createJob(AUTH, 'job-123', {
            model: 'accounts/fireworks/models/llama-v3p3-70b-instruct',
            inputDatasetId: 'input-ds',
            outputDatasetId: 'output-ds',
        });

        expect(calls).toHaveLength(1);
        expect(calls[0].url).toBe(
            'https://api.fireworks.ai/v1/accounts/test-account/batchInferenceJobs?batchInferenceJobId=job-123',
        );
        expect(calls[0].opts.method).toBe('POST');
        const body = JSON.parse(calls[0].opts.body);
        expect(body.model).toBe('accounts/fireworks/models/llama-v3p3-70b-instruct');
        expect(body.inputDatasetId).toBe('accounts/test-account/datasets/input-ds');
        expect(body.outputDatasetId).toBe('accounts/test-account/datasets/output-ds');
    });

    test('createJob with continueFromJobId includes fully-qualified continueFrom ref', async () => {
        const calls = [];
        global.fetch = jest.fn(async (url, opts) => {
            calls.push({ url, opts });
            return {
                ok: true,
                status: 200,
                json: async () => ({}),
                headers: new Headers({ 'content-type': 'application/json' }),
            };
        });

        await createJob(AUTH, 'job-456', {
            model: 'accounts/fireworks/models/llama-v3p3-70b-instruct',
            inputDatasetId: 'in-ds',
            outputDatasetId: 'out-ds',
            continueFromJobId: 'prev-job-789',
        });

        const body = JSON.parse(calls[0].opts.body);
        expect(body.continueFrom).toBe('accounts/test-account/batchInferenceJobs/prev-job-789');
    });

    test('getJob returns parsed JSON on 200', async () => {
        global.fetch = jest.fn(async () => ({
            ok: true,
            status: 200,
            json: async () => ({ state: 'RUNNING', id: 'job-abc' }),
            headers: new Headers({ 'content-type': 'application/json' }),
        }));

        const result = await getJob(AUTH, 'job-abc');
        expect(result.state).toBe('RUNNING');
        expect(result.id).toBe('job-abc');
    });

    test('getJob recognizes all six documented job states', async () => {
        const states = ['VALIDATING', 'PENDING', 'RUNNING', 'COMPLETED', 'FAILED', 'EXPIRED'];
        for (const state of states) {
            global.fetch = jest.fn(async () => ({
                ok: true,
                status: 200,
                json: async () => ({ state }),
                headers: new Headers({ 'content-type': 'application/json' }),
            }));

            const result = await getJob(AUTH, 'job-x');
            expect(result.state).toBe(state);
        }
    });

    test('downloadResults hits getDownloadEndpoint then fetches signed URLs', async () => {
        const calls = [];
        global.fetch = jest.fn(async (url, opts) => {
            calls.push({ url, opts });
            if (url.includes('getDownloadEndpoint')) {
                return {
                    ok: true,
                    status: 200,
                    json: async () => ({
                        filenameToSignedUrls: {
                            'results.jsonl': 'https://signed.example.com/results',
                        },
                    }),
                    headers: new Headers({ 'content-type': 'application/json' }),
                };
            }
            if (url === 'https://signed.example.com/results') {
                return {
                    ok: true,
                    status: 200,
                    arrayBuffer: async () => new TextEncoder().encode('result data').buffer,
                    headers: new Headers(),
                };
            }
            throw new Error(`Unexpected URL: ${url}`);
        });

        const result = await downloadResults(AUTH, 'ds-1', '/tmp/dest');

        // Should have called getDownloadEndpoint + signed URL fetch
        expect(calls.length).toBeGreaterThanOrEqual(2);
        expect(calls.some(c => c.url.includes('getDownloadEndpoint'))).toBe(true);
        expect(calls.some(c => c.url === 'https://signed.example.com/results')).toBe(true);
        expect(result.resultsPath).toBeTruthy();
    });

    test('network-error retry budget exhaustion names maxRetries + 1 attempts', async () => {
        global.fetch = jest.fn(async () => {
            throw new Error('ECONNRESET');
        });

        let caught;
        try {
            await createDataset(AUTH, 'ds-netfail');
        } catch (err) {
            caught = err;
        }

        expect(caught).toBeTruthy();
        expect(caught.message).toMatch(/failed after 4 attempts/);
        expect(global.fetch).toHaveBeenCalledTimes(4);
    });

    test('Auth header is bearer-formatted on every call', async () => {
        const calls = [];
        global.fetch = jest.fn(async (url, opts) => {
            calls.push({ url, opts });
            return {
                ok: true,
                status: 200,
                json: async () => ({}),
                headers: new Headers({ 'content-type': 'application/json' }),
            };
        });

        await createDataset(AUTH, 'ds1');
        await getJob(AUTH, 'job1');

        for (const call of calls) {
            expect(call.opts.headers.Authorization).toBe('Bearer test-key');
        }
    });
});
