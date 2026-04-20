import { withWriteLock, _resetLocksForTests } from '../../../src/core/lock.js';

describe('withWriteLock', () => {
    beforeEach(() => { _resetLocksForTests(); });

    test('runs fn and returns its result', async () => {
        const result = await withWriteLock('chat-a', async () => 42);
        expect(result).toBe(42);
    });

    test('serializes concurrent calls for the same chatId', async () => {
        const trace = [];
        const task = (label, ms) => withWriteLock('chat-a', async () => {
            trace.push(`start:${label}`);
            await new Promise(r => setTimeout(r, ms));
            trace.push(`end:${label}`);
            return label;
        });
        const results = await Promise.all([task('A', 30), task('B', 10), task('C', 5)]);
        // The second task does not start until the first ends, etc.
        expect(trace).toEqual([
            'start:A', 'end:A',
            'start:B', 'end:B',
            'start:C', 'end:C',
        ]);
        expect(results).toEqual(['A', 'B', 'C']);
    });

    test('runs independent chatIds in parallel', async () => {
        const trace = [];
        const task = (chat, label, ms) => withWriteLock(chat, async () => {
            trace.push(`start:${label}`);
            await new Promise(r => setTimeout(r, ms));
            trace.push(`end:${label}`);
        });
        await Promise.all([task('chat-a', 'A', 30), task('chat-b', 'B', 5)]);
        // B finishes before A (different chats, no contention)
        const aEnd = trace.indexOf('end:A');
        const bEnd = trace.indexOf('end:B');
        expect(bEnd).toBeLessThan(aEnd);
    });

    test('releases the lock on fn throw; subsequent calls still run', async () => {
        await expect(
            withWriteLock('chat-a', async () => { throw new Error('boom'); })
        ).rejects.toThrow('boom');
        const v = await withWriteLock('chat-a', async () => 'ok');
        expect(v).toBe('ok');
    });

    test('rejects non-function fn', async () => {
        await expect(withWriteLock('chat-a', /** @type {any} */ (null)))
            .rejects.toThrow(/function/);
    });
});
