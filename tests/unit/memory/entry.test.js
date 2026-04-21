import { createEntry, isValidEntry, generateEntryId } from '../../../src/memory/entry.js';

describe('entry', () => {
    describe('generateEntryId', () => {
        test('prefixes episodic entries with ep_', () => {
            const id = generateEntryId('episodic', new Date('2026-04-20T14:12:33Z'), 'seed');
            expect(id.startsWith('ep_2026-04-20T14:12:33')).toBe(true);
        });

        test('prefixes working with wk_ and persona with ps_', () => {
            const now = new Date('2026-04-20T14:12:33Z');
            expect(generateEntryId('working', now, 'seed').startsWith('wk_')).toBe(true);
            expect(generateEntryId('persona', now, 'seed').startsWith('ps_')).toBe(true);
        });

        test('appends a deterministic 12-hex-char suffix derived from seed', () => {
            const now = new Date('2026-04-20T14:12:33Z');
            const a = generateEntryId('episodic', now, 'seed-A');
            const b = generateEntryId('episodic', now, 'seed-A');
            expect(a).toBe(b);
            expect(a.split('_').pop()).toHaveLength(12);
            expect(a.split('_').pop()).toMatch(/^[a-f0-9]+$/);
        });
    });

    describe('createEntry', () => {
        /** @type {Parameters<typeof createEntry>[0]} */
        const baseFields = {
            scope: 'episodic',
            content: 'Alice grew up in Marseille and moved to Paris at 18.',
            subject: 'alice',
            tags: ['location', 'hometown'],
            provenance: { sourceMessages: [42, 43], extractor: 'test@v1' },
        };

        test('returns a valid entry with defaulted lifecycle', () => {
            const e = createEntry({ ...baseFields });
            expect(e.id).toMatch(/^ep_/);
            expect(e.scope).toBe('episodic');
            expect(e.content).toBe(baseFields.content);
            expect(e.subject).toBe('alice');
            expect(e.tags).toEqual(['location', 'hometown']);
            expect(e.relations).toEqual([]);
            expect(e.lifecycle.importance).toBe(50);
            expect(e.lifecycle.maturity).toBe('draft');
            expect(e.lifecycle.accessCount).toBe(0);
            expect(e.lifecycle.updateCount).toBe(0);
            expect(e.lifecycle.createdAt).toBe(e.lifecycle.updatedAt);
            expect(new Date(e.lifecycle.createdAt).toString()).not.toBe('Invalid Date');
        });

        test('passes custom relations through', () => {
            const e = createEntry({
                ...baseFields,
                relations: [{ type: 'mentions', target: 'ep_abc' }],
            });
            expect(e.relations).toEqual([{ type: 'mentions', target: 'ep_abc' }]);
        });

        test('allows null subject', () => {
            const e = createEntry({ ...baseFields, subject: null });
            expect(e.subject).toBe(null);
            expect(isValidEntry(e)).toBe(true);
        });

        test('uses injected clock if provided (for deterministic tests)', () => {
            const fixed = new Date('2026-04-20T14:12:33Z');
            const e = createEntry({ ...baseFields, now: fixed });
            expect(e.lifecycle.createdAt).toBe('2026-04-20T14:12:33.000Z');
        });

        test('rejects invalid scope', () => {
            expect(() => createEntry(/** @type {any} */ ({ ...baseFields, scope: 'graph' })))
                .toThrow(/scope/);
        });

        test('rejects empty content', () => {
            expect(() => createEntry({ ...baseFields, content: '' }))
                .toThrow(/content/);
        });

        test('rejects missing provenance', () => {
            const rest = { ...baseFields };
            delete (/** @type {any} */ (rest)).provenance;
            expect(() => createEntry(/** @type {any} */ (rest)))
                .toThrow(/provenance/);
        });
    });

    describe('isValidEntry', () => {
        const good = () => createEntry({
            scope: 'working',
            content: 'hi',
            subject: null,
            tags: [],
            provenance: { sourceMessages: [1], extractor: 'test' },
        });

        test('accepts a freshly built entry', () => {
            expect(isValidEntry(good())).toBe(true);
        });

        test('rejects non-objects', () => {
            expect(isValidEntry(null)).toBe(false);
            expect(isValidEntry(undefined)).toBe(false);
            expect(isValidEntry('x')).toBe(false);
            expect(isValidEntry(42)).toBe(false);
            expect(isValidEntry([])).toBe(false);
        });

        test('rejects entries missing required fields', () => {
            const e = good();
            for (const key of ['id', 'scope', 'content', 'tags', 'relations', 'lifecycle', 'provenance']) {
                const copy = { ...e };
                delete copy[key];
                expect(isValidEntry(copy)).toBe(false);
            }
        });

        test('rejects entries with malformed lifecycle', () => {
            const e = good();
            expect(isValidEntry({ ...e, lifecycle: { ...e.lifecycle, importance: -1 } })).toBe(false);
            expect(isValidEntry({ ...e, lifecycle: { ...e.lifecycle, importance: 101 } })).toBe(false);
            expect(isValidEntry({ ...e, lifecycle: { ...e.lifecycle, maturity: 'legendary' } })).toBe(false);
            expect(isValidEntry({ ...e, lifecycle: { ...e.lifecycle, accessCount: -1 } })).toBe(false);
        });

        test('rejects entries with malformed relations', () => {
            const e = good();
            expect(isValidEntry({ ...e, relations: [{ type: 'bogus', target: 'x' }] })).toBe(false);
            expect(isValidEntry({ ...e, relations: [{ type: 'mentions' }] })).toBe(false);
        });
    });
});
