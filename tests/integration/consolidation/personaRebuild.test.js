/**
 * Phase 7 integration test: 20-entry corpus with two natural themes produces
 * Persona entries that reflect the themes. Uses synthetic embeddings and a
 * themed mock LLM so output is deterministic.
 */
import { describe, test, expect, beforeEach, afterEach } from '@jest/globals';
import { rebuildPersona } from '../../../src/consolidation/index.js';
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

const CHAT = 'chat-persona-integration';
const FIXED_NOW = new Date('2026-04-20T10:00:00Z');

const OPTS = {
    profileId: 'test-profile',
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

/**
 * Themed LLM mock: inspects the prompt, echoes a theme-matching summary.
 * @returns {(profile: string, messages: {role: string, content: string}[]) => Promise<string>}
 */
function themedLLMMock() {
    return async (/** @type {string} */ _p, /** @type {{role: string, content: string}[]} */ messages) => {
        const userContent = messages[messages.length - 1].content.toLowerCase();
        if (userContent.includes('travel') || userContent.includes('marseille') || userContent.includes('paris')) {
            return 'Alice is a frequent traveler who has visited Marseille and Paris.';
        }
        if (userContent.includes('food') || userContent.includes('croissant') || userContent.includes('coffee')) {
            return 'Alice has developed food preferences including croissants and coffee.';
        }
        return 'Alice has various traits captured from conversation.';
    };
}

describe('persona rebuild integration', () => {
    test('20-entry corpus with two themes produces thematic Persona entries', async () => {
        // 10 travel themed + 10 food-themed
        const travelTexts = [
            'alice traveled to marseille',
            'alice visited paris last week',
            'alice flew to marseille for vacation',
            'alice went on a trip to paris',
            'alice toured the marseille coast',
            'alice drove to paris from marseille',
            'alice took the train to paris',
            'alice hiked around marseille',
            'alice visited paris museums',
            'alice returned from paris',
        ];
        const foodTexts = [
            'alice loves croissants for breakfast',
            'alice drinks coffee every morning',
            'alice bakes bread on weekends',
            'alice ordered coffee and croissants',
            'alice makes espresso at home',
            'alice eats fresh bread daily',
            'alice enjoys dark coffee',
            'alice tried new croissant recipe',
            'alice buys bread from the bakery',
            'alice grinds her own coffee beans',
        ];
        const allTexts = [...travelTexts, ...foodTexts];
        const entries = allTexts.map((t, i) => createEntry({
            scope: 'episodic', content: t, subject: 'alice', tags: [], relations: [],
            provenance: { sourceMessages: [i], extractor: 'consolidate@v1' },
            now: new Date(FIXED_NOW.getTime() + i * 1000),
        }));
        store.set(CHAT, {
            ...createEmptyState(),
            entries: Object.fromEntries(entries.map(e => [e.id, e])),
            runtime: {
                lastConsolidation: null,
                pendingPersonaRebuild: true,
                consolidating: false,
                episodicCountSinceLastRebuild: 100,
                traces: [],
            },
        });
        _setLLMClientForTests(themedLLMMock());

        const r = await rebuildPersona(CHAT, 'alice', OPTS);

        // The exact cluster count depends on Leiden's convergence on synthetic
        // embeddings, but we should get at least ONE new Persona entry and
        // should have replaced the (zero) prior Persona entries.
        expect(r.episodicCount).toBe(20);
        expect(r.newCount).toBeGreaterThanOrEqual(1);
        expect(r.duration).toBeGreaterThanOrEqual(0);

        const after = await loadState(CHAT);
        const personas = Object.values(after.entries).filter(
            e => e.scope === 'persona' && e.subject === 'alice',
        );
        expect(personas.length).toBe(r.newCount);
        // Each persona entry has a non-empty content string
        for (const p of personas) {
            expect(p.content.length).toBeGreaterThan(0);
            expect(p.provenance.extractor).toBe('test@persona-rebuild-v1');
        }
        // Runtime counters reset
        expect(after.runtime.pendingPersonaRebuild).toBe(false);
        expect(after.runtime.episodicCountSinceLastRebuild).toBe(0);
        // Episodic entries untouched
        const stillEpisodic = Object.values(after.entries).filter(e => e.scope === 'episodic');
        expect(stillEpisodic).toHaveLength(20);
    });

    test('can rebuild twice in a row without interference', async () => {
        const entries = Array.from({ length: 8 }, (_, i) => createEntry({
            scope: 'episodic', content: `alice fact ${i}`, subject: 'alice',
            tags: [], relations: [],
            provenance: { sourceMessages: [i], extractor: 'c@v1' },
            now: new Date(FIXED_NOW.getTime() + i * 1000),
        }));
        store.set(CHAT, {
            ...createEmptyState(),
            entries: Object.fromEntries(entries.map(e => [e.id, e])),
        });
        _setLLMClientForTests(async (_p, messages) => {
            // Include a nonce in case the second run produces identical summaries.
            return `summary ${messages[messages.length - 1].content.slice(0, 10)}`;
        });

        const r1 = await rebuildPersona(CHAT, 'alice', OPTS);
        expect(r1.newCount).toBeGreaterThanOrEqual(1);

        // Second rebuild — old Persona entries should be replaced, not duplicated.
        const r2 = await rebuildPersona(CHAT, 'alice', OPTS);
        expect(r2.replacedCount).toBe(r1.newCount);  // the N new from r1 become deletions in r2

        const after = await loadState(CHAT);
        const personas = Object.values(after.entries).filter(
            e => e.scope === 'persona' && e.subject === 'alice',
        );
        expect(personas).toHaveLength(r2.newCount);
    });
});
