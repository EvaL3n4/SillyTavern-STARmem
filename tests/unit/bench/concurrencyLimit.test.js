/**
 * @jest-environment node
 */
import { concurrencyLimit } from '../../../bench/harness/concurrencyLimit.js';

describe('concurrencyLimit', () => {
    test('rejects non-positive or non-integer max', () => {
        expect(() => concurrencyLimit(0)).toThrow();
        expect(() => concurrencyLimit(-1)).toThrow();
        expect(() => concurrencyLimit(1.5)).toThrow();
        expect(() => concurrencyLimit(/** @type {any} */ ('x'))).toThrow();
    });

    test('runs all tasks and returns their results in order via Promise.all', async () => {
        const limit = concurrencyLimit(4);
        const tasks = [1, 2, 3, 4, 5, 6, 7, 8].map(n =>
            limit(async () => {
                await new Promise(r => setTimeout(r, 5));
                return n * 10;
            }),
        );
        const results = await Promise.all(tasks);
        expect(results).toEqual([10, 20, 30, 40, 50, 60, 70, 80]);
    });

    test('never runs more than max tasks concurrently', async () => {
        const limit = concurrencyLimit(3);
        let inFlight = 0;
        let peak = 0;
        const task = async () => {
            inFlight++;
            if (inFlight > peak) peak = inFlight;
            await new Promise(r => setTimeout(r, 10));
            inFlight--;
        };
        await Promise.all(Array.from({ length: 12 }, () => limit(task)));
        expect(peak).toBeLessThanOrEqual(3);
    });

    test('one rejection does not poison the pool — sibling tasks still run', async () => {
        const limit = concurrencyLimit(2);
        const r1 = limit(async () => { throw new Error('boom'); });
        const r2 = limit(async () => 'ok-1');
        const r3 = limit(async () => 'ok-2');

        await expect(r1).rejects.toThrow('boom');
        await expect(r2).resolves.toBe('ok-1');
        await expect(r3).resolves.toBe('ok-2');
    });

    test('queued tasks run FIFO once a slot frees', async () => {
        const limit = concurrencyLimit(1);
        const order = [];
        const tasks = ['a', 'b', 'c', 'd'].map(id =>
            limit(async () => {
                order.push(`start-${id}`);
                await new Promise(r => setTimeout(r, 1));
                order.push(`end-${id}`);
                return id;
            }),
        );
        await Promise.all(tasks);
        expect(order).toEqual([
            'start-a', 'end-a',
            'start-b', 'end-b',
            'start-c', 'end-c',
            'start-d', 'end-d',
        ]);
    });
});
