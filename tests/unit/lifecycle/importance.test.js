import {
    applyAccessEvent,
    applyUpdateEvent,
    applyDailyDecay,
} from '../../../src/lifecycle/importance.js';

/** @type {import('../../../src/core/schema.js').Lifecycle} */
const baseLifecycle = {
    importance: 50,
    maturity: 'draft',
    createdAt: '2026-04-20T12:00:00.000Z',
    updatedAt: '2026-04-20T12:00:00.000Z',
    accessCount: 0,
    updateCount: 0,
};

describe('applyAccessEvent', () => {
    test('adds 3 to importance per spec §7', () => {
        const out = applyAccessEvent(baseLifecycle);
        expect(out.importance).toBe(53);
    });

    test('increments accessCount', () => {
        const out = applyAccessEvent(baseLifecycle);
        expect(out.accessCount).toBe(1);
    });

    test('does not mutate the input (pure function)', () => {
        applyAccessEvent(baseLifecycle);
        expect(baseLifecycle.importance).toBe(50);
        expect(baseLifecycle.accessCount).toBe(0);
    });

    test('does not touch updatedAt (access is not an update)', () => {
        const out = applyAccessEvent(baseLifecycle);
        expect(out.updatedAt).toBe(baseLifecycle.updatedAt);
    });

    test('clamps at 100', () => {
        const near = { ...baseLifecycle, importance: 99 };
        const out = applyAccessEvent(near);
        expect(out.importance).toBe(100);
    });

    test('golden value: importance=50 + 7 accesses = 71', () => {
        let l = baseLifecycle;
        for (let i = 0; i < 7; i++) l = applyAccessEvent(l);
        expect(l.importance).toBe(71);
        expect(l.accessCount).toBe(7);
    });
});

describe('applyUpdateEvent', () => {
    test('adds 5 to importance per spec §7', () => {
        const out = applyUpdateEvent(baseLifecycle, new Date('2026-04-21T12:00:00Z'));
        expect(out.importance).toBe(55);
    });

    test('increments updateCount and sets updatedAt', () => {
        const when = new Date('2026-04-21T12:00:00Z');
        const out = applyUpdateEvent(baseLifecycle, when);
        expect(out.updateCount).toBe(1);
        expect(out.updatedAt).toBe('2026-04-21T12:00:00.000Z');
    });

    test('does not increment accessCount', () => {
        const out = applyUpdateEvent(baseLifecycle, new Date());
        expect(out.accessCount).toBe(0);
    });

    test('does not mutate input', () => {
        applyUpdateEvent(baseLifecycle, new Date());
        expect(baseLifecycle.importance).toBe(50);
        expect(baseLifecycle.updateCount).toBe(0);
    });

    test('clamps at 100', () => {
        const near = { ...baseLifecycle, importance: 97 };
        const out = applyUpdateEvent(near, new Date());
        expect(out.importance).toBe(100);
    });

    test('uses current time when `now` omitted', () => {
        const before = Date.now();
        const out = applyUpdateEvent(baseLifecycle);
        const after = Date.now();
        const t = new Date(out.updatedAt).getTime();
        expect(t).toBeGreaterThanOrEqual(before);
        expect(t).toBeLessThanOrEqual(after);
    });
});

describe('applyDailyDecay', () => {
    test('multiplies importance by 0.995 for one day', () => {
        const out = applyDailyDecay(baseLifecycle, 1);
        expect(out.importance).toBeCloseTo(50 * 0.995, 6);
    });

    test('compounds over N days', () => {
        const out = applyDailyDecay(baseLifecycle, 10);
        expect(out.importance).toBeCloseTo(50 * Math.pow(0.995, 10), 6);
    });

    test('365-day convergence check: 50 decays to ~8', () => {
        const out = applyDailyDecay(baseLifecycle, 365);
        expect(out.importance).toBeCloseTo(50 * Math.pow(0.995, 365), 4);
        expect(out.importance).toBeGreaterThan(7);
        expect(out.importance).toBeLessThan(9);
    });

    test('zero days is a no-op', () => {
        const out = applyDailyDecay(baseLifecycle, 0);
        expect(out.importance).toBe(50);
    });

    test('negative days is rejected', () => {
        expect(() => applyDailyDecay(baseLifecycle, -1)).toThrow(/days/);
    });

    test('does not touch counts or timestamps (decay is a scheduled background effect)', () => {
        const out = applyDailyDecay(baseLifecycle, 10);
        expect(out.accessCount).toBe(baseLifecycle.accessCount);
        expect(out.updateCount).toBe(baseLifecycle.updateCount);
        expect(out.updatedAt).toBe(baseLifecycle.updatedAt);
        expect(out.createdAt).toBe(baseLifecycle.createdAt);
        expect(out.maturity).toBe(baseLifecycle.maturity);
    });

    test('does not mutate input', () => {
        applyDailyDecay(baseLifecycle, 10);
        expect(baseLifecycle.importance).toBe(50);
    });
});
