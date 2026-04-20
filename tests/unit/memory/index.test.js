import * as memory from '../../../src/memory/index.js';

describe('memory barrel exports', () => {
    test('exposes all public functions', () => {
        // entry.js
        expect(typeof memory.createEntry).toBe('function');
        expect(typeof memory.isValidEntry).toBe('function');
        expect(typeof memory.generateEntryId).toBe('function');
        // graph.js (Phase 5)
        expect(typeof memory.addEdge).toBe('function');
        expect(typeof memory.removeEdge).toBe('function');
        expect(typeof memory.listEdges).toBe('function');
        expect(typeof memory.buildAdjacency).toBe('function');
        expect(typeof memory.neighborsOf).toBe('function');
        // edgeBuilder.js (Phase 5)
        expect(typeof memory.buildEdges).toBe('function');
        expect(typeof memory.extractEntities).toBe('function');
    });

    test('re-exports are reference-equal to the source modules', async () => {
        const entry = await import('../../../src/memory/entry.js');
        const graph = await import('../../../src/memory/graph.js');
        const edgeBuilder = await import('../../../src/memory/edgeBuilder.js');
        expect(memory.createEntry).toBe(entry.createEntry);
        expect(memory.addEdge).toBe(graph.addEdge);
        expect(memory.buildEdges).toBe(edgeBuilder.buildEdges);
    });
});
