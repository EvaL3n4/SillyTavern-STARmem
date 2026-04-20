import { withWriteLock, _resetLocksForTests } from '../../src/core/lock.js';
import { loadState, persistState, setBackend, _resetBackendForTests } from '../../src/core/state.js';
import { createEntry } from '../../src/memory/entry.js';

function makeMemoryBackend() {
    const store = new Map();
    return {
        store,
        read: (key) => store.has(key) ? structuredClone(store.get(key)) : undefined,
        write: (key, value) => { store.set(key, structuredClone(value)); },
    };
}

describe('storage round-trip (integration)', () => {
    beforeEach(() => {
        _resetLocksForTests();
        setBackend(makeMemoryBackend());
    });
    afterEach(() => { _resetBackendForTests(); });

    test('two concurrent lock-wrapped mutations both land in order', async () => {
        const addEntry = (chatId, scope, content) => withWriteLock(chatId, async () => {
            const s = await loadState(chatId);
            const e = createEntry({
                scope, content, subject: null, tags: [],
                provenance: { sourceMessages: [], extractor: 'test' },
            });
            s.entries[e.id] = e;
            s.workingBuffer.push(e.id);
            await persistState(chatId, s);
            return e.id;
        });

        const [idA, idB] = await Promise.all([
            addEntry('chat-a', 'working', 'first'),
            addEntry('chat-a', 'working', 'second'),
        ]);

        const finalState = await loadState('chat-a');
        expect(Object.keys(finalState.entries).sort()).toEqual([idA, idB].sort());
        expect(finalState.workingBuffer).toEqual([idA, idB]);
    });

    test('lock-free interleaving would corrupt state (control demonstration)', async () => {
        // Without the lock, both callers read the same empty state and one
        // write clobbers the other. This test proves the hazard the lock exists
        // to prevent—without actually using the lock.
        const addUnlocked = async (chatId, content) => {
            const s = await loadState(chatId);
            await new Promise(r => setTimeout(r, 10));  // widen the race window
            const e = createEntry({
                scope: 'working', content, subject: null, tags: [],
                provenance: { sourceMessages: [], extractor: 'test' },
            });
            s.entries[e.id] = e;
            s.workingBuffer.push(e.id);
            await persistState(chatId, s);
            return e.id;
        };

        await Promise.all([
            addUnlocked('chat-a', 'first'),
            addUnlocked('chat-a', 'second'),
        ]);

        const finalState = await loadState('chat-a');
        // Exactly one write survives; the other is lost.
        expect(Object.keys(finalState.entries)).toHaveLength(1);
        expect(finalState.workingBuffer).toHaveLength(1);
    });
});
