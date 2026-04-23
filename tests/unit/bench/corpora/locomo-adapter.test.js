import { getAdapter, listAdapters } from '../../../../bench/corpora/index.js';
import { loadLocomo } from '../../../../bench/loaders/locomo.js';

describe('LoCoMo adapter (Phase 12 Task 2 port)', () => {
    test('locomoAdapter is registered after importing the barrel', () => {
        expect(listAdapters()).toContain('locomo');
    });

    test('getAdapter("locomo") returns an adapter with the expected metadata', () => {
        const adapter = getAdapter('locomo');
        expect(adapter.name).toBe('locomo');
        expect(adapter.metadata.sourceUrl).toMatch(/snap-research\/locomo/);
        expect(adapter.metadata.cacheKey).toBe('locomo10.json');
        expect(adapter.metadata.multiSession).toBe(false);
    });

    test('adapter.loadConversations({maxConversations:1}) matches legacy loadLocomo({maxConversations:1})', async () => {
        const adapter = getAdapter('locomo');
        const viaAdapter = await adapter.loadConversations({ maxConversations: 1, offline: true });
        const viaLegacy = await loadLocomo({ maxConversations: 1, offline: true });
        expect(viaAdapter.length).toBe(viaLegacy.length);
        expect(viaAdapter[0].id).toBe(viaLegacy[0].id);
        expect(viaAdapter[0].turns.length).toBe(viaLegacy[0].turns.length);
        expect(viaAdapter[0].qa.length).toBe(viaLegacy[0].qa.length);
    });
});
