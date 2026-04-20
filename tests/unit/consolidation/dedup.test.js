import { describe, test, expect } from '@jest/globals';
import { findDuplicate, jaccard } from '../../../src/consolidation/dedup.js';
import { createEntry } from '../../../src/memory/entry.js';

const FIXED_NOW = new Date('2026-04-20T10:00:00Z');

/** @param {Partial<Parameters<typeof createEntry>[0]>} over */
function ep(over) {
    return createEntry({
        scope: 'episodic',
        content: over.content ?? 'alice traveled to marseille',
        subject: over.subject ?? 'alice',
        tags: over.tags ?? [],
        relations: over.relations ?? [],
        provenance: over.provenance ?? { sourceMessages: [], extractor: 'test' },
        now: over.now ?? FIXED_NOW,
    });
}

describe('jaccard', () => {
    test('disjoint sets → 0', () => {
        expect(jaccard(['a', 'b'], ['c', 'd'])).toBe(0);
    });
    test('identical sets → 1', () => {
        expect(jaccard(['a', 'b'], ['b', 'a'])).toBe(1);
    });
    test('half overlap → 1/3', () => {
        expect(jaccard(['a', 'b'], ['b', 'c'])).toBeCloseTo(1 / 3, 6);
    });
    test('empty-over-empty → 0 (not 1, by spec)', () => {
        expect(jaccard([], [])).toBe(0);
    });
    test('duplicates in input do not inflate', () => {
        expect(jaccard(['a', 'a', 'b'], ['a', 'b'])).toBe(1);
    });
});

describe('findDuplicate', () => {
    test('returns null for candidate with null subject', () => {
        const candidate = createEntry({
            scope: 'episodic', content: 'x', subject: null, tags: [], relations: [],
            provenance: { sourceMessages: [], extractor: 'test' }, now: FIXED_NOW,
        });
        const existing = ep({ subject: null, content: 'x' });
        expect(findDuplicate(candidate, [existing])).toBeNull();
    });

    test('returns null when no subject matches', () => {
        const candidate = ep({ subject: 'alice', content: 'alice went to paris' });
        const existing = ep({ subject: 'bob', content: 'alice went to paris' });
        expect(findDuplicate(candidate, [existing])).toBeNull();
    });

    test('returns null when subject matches but Jaccard below threshold', () => {
        const candidate = ep({ subject: 'alice', content: 'alice ate breakfast' });
        const existing = ep({ subject: 'alice', content: 'alice went to marseille' });
        // Jaccard(["alice","ate","breakfast"], ["alice","went","to","marseille"]) = 1/6 ≈ 0.17
        expect(findDuplicate(candidate, [existing])).toBeNull();
    });

    test('returns match when subject matches and Jaccard ≥ 0.7', () => {
        const existing = ep({ subject: 'alice', content: 'alice traveled to marseille' });
        // Jaccard(["alice","traveled","to","marseille","train"], ["alice","traveled","to","marseille"])
        // = 4 / (5 + 4 - 4) = 4/5 = 0.8 >= 0.7
        const candidate = ep({ subject: 'alice', content: 'alice traveled to marseille train' });
        const found = findDuplicate(candidate, [existing]);
        expect(found).not.toBeNull();
        expect(found?.id).toBe(existing.id);
    });

    test('skips non-episodic entries', () => {
        const candidate = ep({ subject: 'alice', content: 'alice traveled to marseille' });
        const workingDup = createEntry({
            scope: 'working', content: 'alice traveled to marseille',
            subject: 'alice', tags: [], relations: [],
            provenance: { sourceMessages: [], extractor: 'test' }, now: FIXED_NOW,
        });
        expect(findDuplicate(candidate, [workingDup])).toBeNull();
    });

    test('returns the FIRST match when multiple candidates qualify', () => {
        const candidate = ep({ subject: 'alice', content: 'alice traveled to marseille' });
        const first = ep({ subject: 'alice', content: 'alice traveled to marseille once' });
        const second = ep({ subject: 'alice', content: 'alice traveled to marseille twice' });
        const found = findDuplicate(candidate, [first, second]);
        expect(found?.id).toBe(first.id);
    });

    test('empty corpus → null', () => {
        const candidate = ep({ subject: 'alice' });
        expect(findDuplicate(candidate, [])).toBeNull();
    });
});
