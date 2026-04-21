/**
 * Unit tests for bench/baselines/random.js
 *
 * @see docs/plans/phase-9-benchmarking.md §Task 8
 */

import { describe, test, expect } from '@jest/globals';
import { createEmptyState } from '../../../../src/core/schema.js';
import { createEntry } from '../../../../src/memory/entry.js';
import { random } from '../../../../bench/baselines/random.js';

function makeState(entries) {
    const state = createEmptyState();
    for (const e of entries) {
        state.entries[e.id] = e;
    }
    return state;
}

function makeEntry(id, content) {
    const e = createEntry({
        scope: 'episodic',
        content,
        subject: null,
        tags: [],
        provenance: { sourceMessages: [0], extractor: 'test' },
        now: new Date('2026-04-01T00:00:00Z'),
    });
    e.id = id;
    return e;
}

describe('random', () => {
    test('returns empty result for empty state', () => {
        const state = createEmptyState();
        const result = random(state, 'hello', { k: 5 });
        expect(result.entries).toEqual([]);
        expect(result.tierResolved).toBe('random');
        expect(result.trace.tierResolved).toBe('random');
        expect(result.state.runtime.traces.length).toBe(1);
    });

    test('returns k entries when state has more than k', () => {
        const entries = [
            makeEntry('ep_1', 'One'),
            makeEntry('ep_2', 'Two'),
            makeEntry('ep_3', 'Three'),
            makeEntry('ep_4', 'Four'),
        ];
        const state = makeState(entries);
        const result = random(state, 'query', { k: 2 });
        expect(result.entries.length).toBe(2);
        expect(result.tierResolved).toBe('random');
    });

    test('is deterministic for same (chatId + queryStr)', () => {
        const entries = [
            makeEntry('ep_a', 'Alpha'),
            makeEntry('ep_b', 'Beta'),
            makeEntry('ep_c', 'Gamma'),
            makeEntry('ep_d', 'Delta'),
        ];
        const state = makeState(entries);
        const r1 = random(state, 'same query', { k: 3 });
        const r2 = random(state, 'same query', { k: 3 });
        expect(r1.entries.map(e => e.id)).toEqual(r2.entries.map(e => e.id));
    });

    test('produces different order for different query strings', () => {
        const entries = [
            makeEntry('ep_a', 'Alpha'),
            makeEntry('ep_b', 'Beta'),
            makeEntry('ep_c', 'Gamma'),
            makeEntry('ep_d', 'Delta'),
        ];
        const state = makeState(entries);
        const r1 = random(state, 'query one', { k: 4 });
        const r2 = random(state, 'query two', { k: 4 });
        // Different seeds should produce different orderings with high probability
        expect(r1.entries.map(e => e.id)).not.toEqual(r2.entries.map(e => e.id));
    });

    test('trace shape is correct', () => {
        const entries = [makeEntry('ep_1', 'Trace test')];
        const state = makeState(entries);
        const result = random(state, 'test', { k: 1 });
        expect(result.trace.query).toBe('test');
        expect(result.trace.classifier).toBe('factual');
        expect(result.trace.scorerId).toBe('random');
        expect(Array.isArray(result.trace.finalRanking)).toBe(true);
        expect(result.trace.perTier.random).toBeDefined();
        expect(Array.isArray(result.trace.perTier.random)).toBe(true);
    });
});
