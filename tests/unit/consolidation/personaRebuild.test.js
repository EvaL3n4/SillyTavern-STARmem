import { describe, test, expect, beforeEach, afterEach } from '@jest/globals';
import { rebuildPersona } from '../../../src/consolidation/personaRebuild.js';
import { setBackend, _resetBackendForTests, loadState } from '../../../src/core/state.js';
import { _resetLocksForTests } from '../../../src/core/lock.js';
import { createEmptyState } from '../../../src/core/schema.js';
import { createEntry } from '../../../src/memory/entry.js';
import {
    _setLLMClientForTests, _resetLLMClientForTests,
} from '../../../src/consolidation/llmClient.js';
import {
    _setEmbeddingClientForTests, _resetEmbeddingClientForTests, makeSyntheticClient,
} from '../../../src/consolidation/raptor/embeddings.js';

const CHAT = 'chat-rebuild';
const FIXED_NOW = new Date('2026-04-20T10:00:00Z');

const OPTS = {
    profileId: 'p',
    extractorLabel: 'test@persona-rebuild-v1',
    now: FIXED_NOW,
};

/** @type {Map<string, unknown>} */
let store;

beforeEach(() => {
    store = new Map();
    setBackend({ read: id => store.get(id), write: (id, v) => { store.set(id, v); } });
    _resetLocksForTests();
    _setEmbeddingClientForTests(makeSyntheticClient());
});

afterEach(() => {
    _resetBackendForTests();
    _resetLocksForTests();
    _resetEmbeddingClientForTests();
    _resetLLMClientForTests();
});

/** @param {string} subject @param {string} content @param {number} [msgIdx] */
function episodic(subject, content, msgIdx = 0) {
    return createEntry({
        scope: 'episodic', content, subject, tags: [], relations: [],
        provenance: { sourceMessages: [msgIdx], extractor: 'test' },
        now: new Date(FIXED_NOW.getTime() + msgIdx * 1000),
    });
}

describe('rebuildPersona (end-to-end)', () => {
    test('single-layer rebuild: small corpus, produces at least one Persona entry', async () => {
        const es = Array.from({ length: 6 }, (_, i) => episodic('alice', `alice fact ${i}`, i));
        store.set(CHAT, {
            ...createEmptyState(),
            entries: Object.fromEntries(es.map(e => [e.id, e])),
            runtime: {
                lastConsolidation: null, pendingPersonaRebuild: true,
                consolidating: false, episodicCountSinceLastRebuild: 120, traces: [],
            },
        });
        let llmCalls = 0;
        _setLLMClientForTests(async () => {
            llmCalls++;
            return `alice summary ${llmCalls}`;
        });

        const r = await rebuildPersona(CHAT, 'alice', OPTS);
        expect(r.episodicCount).toBe(6);
        expect(r.layers).toBeGreaterThanOrEqual(1);
        expect(r.newCount).toBeGreaterThanOrEqual(1);

        const after = await loadState(CHAT);
        const alicePersonas = Object.values(after.entries).filter(
            e => e.scope === 'persona' && e.subject === 'alice',
        );
        expect(alicePersonas.length).toBe(r.newCount);
        expect(after.runtime.pendingPersonaRebuild).toBe(false);
        expect(after.runtime.episodicCountSinceLastRebuild).toBe(0);
    });

    test('no episodic entries for subject → throws', async () => {
        store.set(CHAT, createEmptyState());
        _setLLMClientForTests(async () => 'x');
        await expect(rebuildPersona(CHAT, 'alice', OPTS))
            .rejects.toThrow(/no episodic entries/);
    });

    test('LLM failure: aborts cleanly, no state mutation', async () => {
        const es = Array.from({ length: 6 }, (_, i) => episodic('alice', `fact ${i}`, i));
        const oldPersona = createEntry({
            scope: 'persona', content: 'old alice', subject: 'alice',
            tags: [], relations: [], provenance: { sourceMessages: [], extractor: 'prior' },
            now: FIXED_NOW,
        });
        store.set(CHAT, {
            ...createEmptyState(),
            entries: {
                ...Object.fromEntries(es.map(e => [e.id, e])),
                [oldPersona.id]: oldPersona,
            },
        });
        _setLLMClientForTests(async () => { throw new Error('LLM down'); });

        await expect(rebuildPersona(CHAT, 'alice', OPTS)).rejects.toThrow(/LLM down/);
        const after = await loadState(CHAT);
        // Old persona still there (atomic swap never happened)
        expect(after.entries[oldPersona.id]).toBeDefined();
        expect(after.entries[oldPersona.id].content).toBe('old alice');
    });

    test('AbortSignal pre-flight: throws without mutation', async () => {
        const es = [episodic('alice', 'a'), episodic('alice', 'b')];
        store.set(CHAT, {
            ...createEmptyState(),
            entries: Object.fromEntries(es.map(e => [e.id, e])),
        });
        _setLLMClientForTests(async () => 'x');
        const controller = new AbortController();
        controller.abort();
        await expect(rebuildPersona(CHAT, 'alice', { ...OPTS, signal: controller.signal }))
            .rejects.toThrow(/aborted/);
    });

    test('onProgress callback fires per stage', async () => {
        const es = Array.from({ length: 6 }, (_, i) => episodic('alice', `fact ${i}`, i));
        store.set(CHAT, {
            ...createEmptyState(),
            entries: Object.fromEntries(es.map(e => [e.id, e])),
        });
        _setLLMClientForTests(async () => 'summary text');

        /** @type {string[]} */
        const stages = [];
        await rebuildPersona(CHAT, 'alice', {
            ...OPTS,
            onProgress: (p) => { stages.push(p.stage); },
        });
        expect(stages).toContain('snapshot');
        expect(stages).toContain('chunk');
        expect(stages.some(s => s === 'knn' || s === 'cluster' || s.startsWith('summarize')))
            .toBe(true);
        expect(stages).toContain('atomic-swap');
    });

    test('ignores non-matching-subject episodic entries', async () => {
        const aliceEs = Array.from({ length: 4 }, (_, i) => episodic('alice', `alice ${i}`, i));
        const bobEs = Array.from({ length: 4 }, (_, i) => episodic('bob', `bob ${i}`, i + 10));
        store.set(CHAT, {
            ...createEmptyState(),
            entries: Object.fromEntries([...aliceEs, ...bobEs].map(e => [e.id, e])),
        });
        _setLLMClientForTests(async () => 'alice summary');
        const r = await rebuildPersona(CHAT, 'alice', OPTS);
        expect(r.episodicCount).toBe(4);  // only alice's episodic entries

        const after = await loadState(CHAT);
        // Bob's episodic entries untouched
        const bobEpisodic = Object.values(after.entries).filter(
            e => e.scope === 'episodic' && e.subject === 'bob',
        );
        expect(bobEpisodic).toHaveLength(4);
    });

    test('rejects bad arguments', async () => {
        await expect(rebuildPersona('', 'alice', OPTS)).rejects.toThrow(/chatId/);
        await expect(rebuildPersona('c', '', OPTS)).rejects.toThrow(/subject/);
        await expect(rebuildPersona('c', 'alice', /** @type {any} */ ({}))).rejects.toThrow(/profileId/);
    });
});
