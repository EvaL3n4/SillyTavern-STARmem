/**
 * Unit tests for bench/baselines/bm25only.js
 *
 * @see docs/plans/phase-9-benchmarking.md §Task 8
 */

import { describe, test, expect } from '@jest/globals';
import { createEmptyState } from '../../../../src/core/schema.js';
import { createEntry } from '../../../../src/memory/entry.js';
import { bm25only } from '../../../../bench/baselines/bm25only.js';

function makeState(entries) {
    const state = createEmptyState();
    for (const e of entries) {
        state.entries[e.id] = e;
    }
    return state;
}

function makeEntry(id, content, subject, tags, updatedAt) {
    const e = createEntry({
        scope: 'episodic',
        content,
        subject,
        tags: tags || [],
        provenance: { sourceMessages: [0], extractor: 'test' },
        now: new Date(updatedAt || '2026-04-01T00:00:00Z'),
    });
    // Override id for determinism
    e.id = id;
    if (updatedAt) {
        e.lifecycle.updatedAt = updatedAt;
        e.lifecycle.createdAt = updatedAt;
    }
    return e;
}

describe('bm25only', () => {
    test('returns empty result for empty state', () => {
        const state = createEmptyState();
        const result = bm25only(state, 'hello', { k: 5 });
        expect(result.entries).toEqual([]);
        expect(result.tierResolved).toBe('bm25only');
        expect(result.trace.tierResolved).toBe('bm25only');
        expect(result.state.runtime.traces.length).toBe(1);
    });

    test('returns top-k entries by BM25 relevance', () => {
        const entries = [
            makeEntry('ep_1', 'Alice loves coffee every morning', 'Alice', ['coffee']),
            makeEntry('ep_2', 'Bob drinks tea in the afternoon', 'Bob', ['tea']),
            makeEntry('ep_3', 'Charlie hates coffee but likes tea', 'Charlie', ['coffee', 'tea']),
        ];
        const state = makeState(entries);
        const result = bm25only(state, 'coffee', { k: 2 });
        expect(result.entries.length).toBe(2);
        expect(result.tierResolved).toBe('bm25only');
    });

    test('respects k parameter', () => {
        const entries = [
            makeEntry('ep_1', 'The quick brown fox jumps over the lazy dog', null, []),
            makeEntry('ep_2', 'The lazy dog sleeps all day in the sun', null, []),
            makeEntry('ep_3', 'A quick red fox runs fast through the forest', null, []),
            makeEntry('ep_4', 'Brown bears are large mammals in the wild', null, []),
        ];
        const state = makeState(entries);
        const result3 = bm25only(state, 'the', { k: 3 });
        const result1 = bm25only(state, 'the', { k: 1 });
        expect(result3.entries.length).toBe(3);
        expect(result1.entries.length).toBe(1);
    });

    test('produces deterministic results for same input', () => {
        const entries = [
            makeEntry('ep_1', 'Deterministic test content one', null, []),
            makeEntry('ep_2', 'Deterministic test content two', null, []),
        ];
        const state = makeState(entries);
        const r1 = bm25only(state, 'test', { k: 2 });
        const r2 = bm25only(state, 'test', { k: 2 });
        expect(r1.entries.map(e => e.id)).toEqual(r2.entries.map(e => e.id));
        expect(r1.trace.finalRanking).toEqual(r2.trace.finalRanking);
    });

    test('trace shape is correct', () => {
        const entries = [
            makeEntry('ep_1', 'Trace shape test', null, []),
        ];
        const state = makeState(entries);
        const result = bm25only(state, 'test', { k: 1 });
        expect(result.trace.query).toBe('test');
        expect(result.trace.classifier).toBe('factual');
        expect(result.trace.scorerId).toBe('bm25only');
        expect(Array.isArray(result.trace.finalRanking)).toBe(true);
        expect(result.trace.perTier.bm25only).toBeDefined();
        expect(Array.isArray(result.trace.perTier.bm25only)).toBe(true);
    });
});
