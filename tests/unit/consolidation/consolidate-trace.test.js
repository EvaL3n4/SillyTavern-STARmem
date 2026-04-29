import { describe, test, expect, beforeEach, afterEach } from '@jest/globals';
import { consolidate } from '../../../src/consolidation/consolidate.js';
import { loadState, setBackend, _resetBackendForTests }
    from '../../../src/core/state.js';
import { _resetLocksForTests } from '../../../src/core/lock.js';
import { createEmptyState } from '../../../src/core/schema.js';
import { createEntry } from '../../../src/memory/entry.js';
import {
    _setLLMClientForTests, _resetLLMClientForTests,
} from '../../../src/consolidation/llmClient.js';
import { ExtractionParseError } from '../../../src/consolidation/extractFacts.js';
import { TRACE_BUFFER_CAP } from '../../../src/core/constants.js';

const CHAT = 'chat-trace';
const FIXED_NOW = new Date('2026-04-20T10:00:00Z');

const OPTS = {
    profileId: 'gemma-4-31b',
    extractorLabel: 'gemma-4-31b@v1',
    messageOf: (/** @type {import('../../../src/core/schema.js').Entry} */ e) =>
        ({ role: /** @type {const} */ ('user'), content: e.content }),
    now: FIXED_NOW,
};

/** @type {Map<string, unknown>} */
let store;

beforeEach(() => {
    store = new Map();
    setBackend({
        read: (id) => store.get(id),
        write: (id, v) => { store.set(id, v); },
    });
    _resetLocksForTests();
});

afterEach(() => {
    _resetBackendForTests();
    _resetLocksForTests();
    _resetLLMClientForTests();
});

/** @param {Partial<import('../../../src/core/schema.js').State>} [over] */
async function seed(over) {
    const s = { ...createEmptyState(), ...(over ?? {}) };
    store.set(CHAT, s);
    return s;
}

/** Helper: build a Working entry and register it in state.entries + workingBuffer. */
function workingEntry(content) {
    return createEntry({
        scope: 'working', content, subject: null, tags: [], relations: [],
        provenance: { sourceMessages: [0], extractor: 'test-interceptor' },
        now: FIXED_NOW,
    });
}

describe('consolidate emits trace entry', () => {
    test('success path appends a {kind: "consolidate"} trace with documented shape', async () => {
        const w = Array.from({ length: 3 }, (_, i) => workingEntry(`turn ${i}`));
        await seed({
            entries: Object.fromEntries(w.map(e => [e.id, e])),
            workingBuffer: w.map(e => e.id),
        });

        _setLLMClientForTests(async () => JSON.stringify({
            entries: [
                { content: 'alice traveled to marseille', subject: 'alice', tags: ['travel'] },
                { content: 'alice met bob there', subject: 'alice' },
            ],
        }));

        const result = await consolidate(CHAT, OPTS);
        expect(/** @type {any} */ (result).added).toBe(2);
        expect(/** @type {any} */ (result).updated).toBe(0);

        const after = await loadState(CHAT);
        const consolidateTraces = after.runtime.traces.filter(t => t.kind === 'consolidate');
        expect(consolidateTraces).toHaveLength(1);

        const t = consolidateTraces[0];
        expect(t).toMatchObject({
            kind: 'consolidate',
            chatId: CHAT,
            timestamp: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/),
            summary: expect.objectContaining({
                factCount: 2,
                added: 2,
                updated: 0,
                scope: 'episodic',
            }),
            durationMs: expect.any(Number),
            extractor: OPTS.extractorLabel,
        });
        expect(t.durationMs).toBeGreaterThanOrEqual(0);
        expect(t.summary.error).toBeUndefined();
    });

    test('parse-failure path appends a {kind: "consolidate"} trace with error marker', async () => {
        const w = Array.from({ length: 3 }, (_, i) => workingEntry(`p${i}`));
        await seed({
            entries: Object.fromEntries(w.map(e => [e.id, e])),
            workingBuffer: w.map(e => e.id),
        });

        _setLLMClientForTests(async () => { throw new ExtractionParseError('bad json', { responseLength: 12 }); });

        const result = await consolidate(CHAT, OPTS);
        expect(/** @type {any} */ (result).parseFailures).toBe(1);

        const after = await loadState(CHAT);
        const consolidateTraces = after.runtime.traces.filter(t => t.kind === 'consolidate');
        expect(consolidateTraces).toHaveLength(1);

        const t = consolidateTraces[0];
        expect(t).toMatchObject({
            kind: 'consolidate',
            chatId: CHAT,
            timestamp: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/),
            summary: {
                factCount: 0,
                added: 0,
                updated: 0,
                scope: 'episodic',
                error: 'parse_failure',
            },
            durationMs: expect.any(Number),
            extractor: OPTS.extractorLabel,
        });
    });

    test('mixed-kind ordering: retrieve trace + consolidate trace coexist; consolidate is newer', async () => {
        const w = [workingEntry('x')];
        await seed({
            entries: Object.fromEntries(w.map(e => [e.id, e])),
            workingBuffer: w.map(e => e.id),
            runtime: {
                lastConsolidation: null,
                pendingPersonaRebuild: false,
                consolidating: false,
                episodicCountSinceLastRebuild: 0,
                traces: [
                    { timestamp: '2026-04-20T09:00:00Z', tierResolved: 0, query: 'pre-existing', classifier: 'factual' },
                ],
            },
        });

        _setLLMClientForTests(async () => JSON.stringify({
            entries: [{ content: 'a new fact', subject: 'alice' }],
        }));

        await consolidate(CHAT, OPTS);

        const after = await loadState(CHAT);
        expect(after.runtime.traces).toHaveLength(2);
        expect(after.runtime.traces[0].query).toBe('pre-existing'); // retrieve (older)
        expect(after.runtime.traces[1].kind).toBe('consolidate'); // consolidate (newer)
    });

    test('ring-buffer cap is honored: fill to cap, consolidate, length stays <= cap with consolidate at end', async () => {
        const w = [workingEntry('x')];
        const traces = [];
        for (let i = 0; i < TRACE_BUFFER_CAP; i++) {
            traces.push({
                timestamp: new Date(Date.now() - i * 1000).toISOString(),
                tierResolved: 2,
                query: `q${i}`,
                classifier: 'factual',
            });
        }
        await seed({
            entries: Object.fromEntries(w.map(e => [e.id, e])),
            workingBuffer: w.map(e => e.id),
            runtime: {
                lastConsolidation: null,
                pendingPersonaRebuild: false,
                consolidating: false,
                episodicCountSinceLastRebuild: 0,
                traces,
            },
        });

        _setLLMClientForTests(async () => JSON.stringify({
            entries: [{ content: 'a new fact', subject: 'alice' }],
        }));

        await consolidate(CHAT, OPTS);

        const after = await loadState(CHAT);
        expect(after.runtime.traces.length).toBeLessThanOrEqual(TRACE_BUFFER_CAP);
        // Newest entry must be the consolidate trace
        expect(after.runtime.traces[after.runtime.traces.length - 1].kind).toBe('consolidate');
    });

    test('transport-error path does NOT append a consolidate trace', async () => {
        const w = [workingEntry('a')];
        await seed({
            entries: Object.fromEntries(w.map(e => [e.id, e])),
            workingBuffer: w.map(e => e.id),
        });

        _setLLMClientForTests(async () => { throw new Error('connection reset'); });

        await expect(consolidate(CHAT, OPTS)).rejects.toThrow('connection reset');

        const after = await loadState(CHAT);
        const consolidateTraces = after.runtime.traces.filter(t => t.kind === 'consolidate');
        expect(consolidateTraces).toHaveLength(0);
    });
});
