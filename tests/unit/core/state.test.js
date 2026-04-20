import { createEmptyState } from '../../../src/core/schema.js';
import {
    loadState,
    persistState,
    setBackend,
    _resetBackendForTests,
} from '../../../src/core/state.js';

/** In-memory backend for deterministic tests. */
function makeMemoryBackend() {
    const store = new Map();
    return {
        store,
        read: (key) => store.has(key) ? structuredClone(store.get(key)) : undefined,
        write: (key, value) => { store.set(key, structuredClone(value)); },
    };
}

describe('state I/O', () => {
    afterEach(() => { _resetBackendForTests(); });

    test('loadState returns an empty State when nothing is stored', async () => {
        setBackend(makeMemoryBackend());
        const s = await loadState('chat-a');
        expect(s).toEqual(createEmptyState());
    });

    test('persist then load round-trips structurally', async () => {
        setBackend(makeMemoryBackend());
        const original = createEmptyState();
        original.workingBuffer.push('wk_abc');
        original.runtime.lastConsolidation = '2026-04-20T14:12:33Z';
        await persistState('chat-a', original);
        const loaded = await loadState('chat-a');
        expect(loaded).toEqual(original);
        // Returned object is independent of the stored one (deep clone).
        loaded.workingBuffer.push('wk_xyz');
        const reloaded = await loadState('chat-a');
        expect(reloaded.workingBuffer).toEqual(['wk_abc']);
    });

    test('persistState rejects non-object state', async () => {
        setBackend(makeMemoryBackend());
        await expect(persistState('chat-a', /** @type {any} */ (null)))
            .rejects.toThrow(/state/);
    });

    test('loadState recovers an empty State when stored value is malformed', async () => {
        const backend = makeMemoryBackend();
        setBackend(backend);
        backend.store.set('chat-a', 42);  // corrupted
        const s = await loadState('chat-a');
        expect(s).toEqual(createEmptyState());
    });

    test('different chatIds do not collide', async () => {
        setBackend(makeMemoryBackend());
        const sa = createEmptyState(); sa.workingBuffer.push('a');
        const sb = createEmptyState(); sb.workingBuffer.push('b');
        await persistState('chat-a', sa);
        await persistState('chat-b', sb);
        expect((await loadState('chat-a')).workingBuffer).toEqual(['a']);
        expect((await loadState('chat-b')).workingBuffer).toEqual(['b']);
    });
});
