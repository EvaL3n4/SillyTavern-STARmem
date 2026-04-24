/**
 * Unit tests for starmemInterceptor (src/integration/interceptor.js).
 *
 * @module tests/unit/integration/interceptor.test
 */
import { describe, test, expect, beforeEach, afterEach } from '@jest/globals';
import { createEntry } from '../../../src/memory/entry.js';
import { createEmptyState } from '../../../src/core/schema.js';
import { setBackend, _resetBackendForTests } from '../../../src/core/state.js';
import { _setContextForTests, _resetContextForTests, starmemInterceptor } from '../../../src/integration/interceptor.js';
import { _resetLocksForTests, _getLockSetForTests } from '../../../src/core/lock.js';

describe('starmemInterceptor', () => {
    beforeEach(() => {
        _resetContextForTests();
        _resetBackendForTests();
        _resetLocksForTests();
    });
    afterEach(() => {
        _resetContextForTests();
        _resetBackendForTests();
        _resetLocksForTests();
    });

    test('acquires write lock BEFORE loading state (no retrieve→persist race)', async () => {
        // Regression for finding #12 (Codex 2026-04-24): starmemInterceptor
        // previously loaded state outside the write lock, then persisted
        // inside it — so a concurrent consolidation/persona-rebuild commit
        // between load and persist would be overwritten by the interceptor's
        // stale snapshot. The fix moves loadState inside withWriteLock.
        //
        // Instrumentation: hijack the backend.read() method (invoked by
        // loadState) and check whether the chatId is in the lock set at that
        // moment. jest.spyOn on ESM exports is unavailable (read-only module
        // bindings), so we instrument at the backend seam instead — same
        // semantic, cleaner fit with the existing test-seam design.
        const chatId = 'race-test';
        const e1 = createEntry({
            scope: 'episodic',
            content: 'Alice lives in Paris.',
            subject: 'alice', tags: ['location'], relations: [],
            provenance: { sourceMessages: [0], extractor: 'test@v1' },
            now: new Date('2026-04-24T12:00:00Z'),
        });
        const initial = { ...createEmptyState(), entries: { [e1.id]: e1 } };

        let lockHeldWhenLoaded = false;
        setBackend({
            read: (id) => {
                lockHeldWhenLoaded = _getLockSetForTests().has(id);
                return structuredClone(initial);
            },
            write: (_id, v) => { initial.entries = v.entries; initial.workingBuffer = v.workingBuffer; },
        });
        _setContextForTests({ chatId });

        const chat = [
            { name: 'U', is_user: true, is_system: false, send_date: '', mes: 'where does alice live?' },
        ];

        await starmemInterceptor(chat, 4096, () => {}, 'normal');

        expect(lockHeldWhenLoaded).toBe(true);
    });
});
