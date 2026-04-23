import { getAdapter, listAdapters, registerAdapter, _clearRegistryForTests } from '../../../../bench/corpora/adapter.js';

describe('CorpusAdapter registry', () => {
    afterEach(() => {
        _clearRegistryForTests();
    });

    test('registerAdapter accepts a valid adapter and it can be retrieved', () => {
        const mockAdapter = {
            name: 'test-corpus',
            loadConversations: async () => [],
            metadata: { sourceUrl: 'https://example.com/test', cacheKey: 'test.json', itemCount: 0 },
        };
        registerAdapter(mockAdapter);
        expect(getAdapter('test-corpus')).toBe(mockAdapter);
        expect(listAdapters()).toEqual(['test-corpus']);
    });

    test('registerAdapter rejects adapters missing a name', () => {
        expect(() => registerAdapter({ loadConversations: async () => [], metadata: { sourceUrl: 'x', cacheKey: 'x', itemCount: 0 } }))
            .toThrow(/non-empty name/);
    });

    test('registerAdapter rejects adapters missing loadConversations', () => {
        expect(() => registerAdapter({ name: 'x', metadata: { sourceUrl: 'x', cacheKey: 'x', itemCount: 0 } }))
            .toThrow(/loadConversations must be a function/);
    });

    test('registerAdapter rejects adapters missing metadata.sourceUrl', () => {
        expect(() => registerAdapter({ name: 'x', loadConversations: async () => [], metadata: {} }))
            .toThrow(/metadata\.sourceUrl required/);
    });

    test('getAdapter throws on unknown name and lists known adapters', () => {
        registerAdapter({
            name: 'corpus-a',
            loadConversations: async () => [],
            metadata: { sourceUrl: 'x', cacheKey: 'x', itemCount: 0 },
        });
        expect(() => getAdapter('corpus-b'))
            .toThrow(/unknown corpus "corpus-b"\. Known: corpus-a/);
    });

    test('getAdapter throws with "(none registered)" when registry is empty', () => {
        expect(() => getAdapter('anything'))
            .toThrow(/\(none registered\)/);
    });
});
