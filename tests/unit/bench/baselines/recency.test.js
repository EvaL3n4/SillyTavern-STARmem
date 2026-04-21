/**
 * Unit tests for bench/baselines/recency.js
 *
 * @see docs/plans/phase-9-benchmarking.md §Task 8
 */

import { describe, test, expect } from '@jest/globals';
import { createEmptyState } from '../../../../src/core/schema.js';
import { createEntry } from '../../../../src/memory/entry.js';
import { recency } from '../../../../bench/baselines/recency.js';

function makeState(entries) {
    const state = createEmptyState();
    for (const e of entries) {
        state.entries[e.id] = e;
    }
    return state;
}

function makeEntry(id, content, updatedAt) {
    const e = createEntry({
        scope: 'episodic',
        content,
        subject: null,
        tags: [],
        provenance: { sourceMessages: [0], extractor: 'test' },
        now: new Date(updatedAt),
    });
    e.id = id;
    e.lifecycle.updatedAt = updatedAt;
    e.lifecycle.createdAt = updatedAt;
    return e;
}

describe('recency', () => {
    test('returns empty result for empty state', () => {
        const state = createEmptyState();
        const result = recency(state, 'hello', { k: 5 });
        expect(result.entries).toEqual([]);
        expect(result.tierResolved).toBe('recency');
        expect(result.trace.tierResolved).toBe('recency');
        expect(result.state.runtime.traces.length).toBe(1);
    });

    test('sorts by lifecycle.updatedAt descending', () => {
        const entries = [
            makeEntry('ep_old', 'Old entry', '2026-04-01T00:00:00Z'),
            makeEntry('ep_mid', 'Mid entry', '2026-04-15T00:00:00Z'),
            makeEntry('ep_new', 'New entry', '2026-04-21T00:00:00Z'),
        ];
        const state = makeState(entries);
        const result = recency(state, 'anything', { k: 3 });
        expect(result.entries.map(e => e.id)).toEqual(['ep_new', 'ep_mid', 'ep_old']);
    });

    test('respects k parameter', () => {
        const entries = [
            makeEntry('ep_1', 'One', '2026-04-01T00:00:00Z'),
            makeEntry('ep_2', 'Two', '2026-04-02T00:00:00Z'),
            makeEntry('ep_3', 'Three', '2026-04-03T00:00:00Z'),
        ];
        const state = makeState(entries);
        const result = recency(state, 'anything', { k: 2 });
        expect(result.entries.length).toBe(2);
        expect(result.entries[0].id).toBe('ep_3');
        expect(result.entries[1].id).toBe('ep_2');
    });

    test('entries with missing updatedAt sort to bottom', () => {
        const e1 = makeEntry('ep_good', 'Good', '2026-04-01T00:00:00Z');
        const e2 = makeEntry('ep_bad', 'Bad', '2026-04-01T00:00:00Z');
        e2.lifecycle.updatedAt = '';
        const state = makeState([e1, e2]);
        const result = recency(state, 'anything', { k: 2 });
        expect(result.entries[0].id).toBe('ep_good');
        expect(result.entries[1].id).toBe('ep_bad');
    });

    test('trace shape is correct', () => {
        const entries = [makeEntry('ep_1', 'Trace test', '2026-04-01T00:00:00Z')];
        const state = makeState(entries);
        const result = recency(state, 'test', { k: 1 });
        expect(result.trace.query).toBe('test');
        expect(result.trace.classifier).toBe('factual');
        expect(result.trace.scorerId).toBe('recency');
        expect(Array.isArray(result.trace.finalRanking)).toBe(true);
        expect(result.trace.perTier.recency).toBeDefined();
        expect(Array.isArray(result.trace.perTier.recency)).toBe(true);
    });
});
