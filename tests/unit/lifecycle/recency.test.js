import { recencyAt, MS_PER_DAY } from '../../../src/lifecycle/recency.js';

describe('recencyAt', () => {
    const t0 = new Date('2026-04-20T12:00:00Z');

    test('returns 1.0 when now === createdAt', () => {
        expect(recencyAt(t0, t0)).toBeCloseTo(1.0, 6);
    });

    test('returns exp(-1) at Δt = τ days', () => {
        const thirtyLater = new Date(t0.getTime() + 30 * MS_PER_DAY);
        expect(recencyAt(thirtyLater, t0)).toBeCloseTo(Math.exp(-1), 6);
    });

    test('returns ≈ 0.5 at the 21-day half-life point (τ = 30)', () => {
        const twentyOneLater = new Date(t0.getTime() + 21 * MS_PER_DAY);
        expect(recencyAt(twentyOneLater, t0)).toBeCloseTo(0.4966, 3);
    });

    test('respects custom tau parameter', () => {
        const tenLater = new Date(t0.getTime() + 10 * MS_PER_DAY);
        expect(recencyAt(tenLater, t0, 10)).toBeCloseTo(Math.exp(-1), 6);
    });

    test('defaults tau to 30 when omitted', () => {
        const thirtyLater = new Date(t0.getTime() + 30 * MS_PER_DAY);
        expect(recencyAt(thirtyLater, t0)).toBe(recencyAt(thirtyLater, t0, 30));
    });

    test('decays monotonically with age', () => {
        const values = [1, 7, 14, 30, 60, 90, 365].map(d =>
            recencyAt(new Date(t0.getTime() + d * MS_PER_DAY), t0)
        );
        for (let i = 1; i < values.length; i++) {
            expect(values[i]).toBeLessThan(values[i - 1]);
        }
        expect(values.at(-1)).toBeGreaterThan(0);
        expect(values.at(-1)).toBeLessThan(0.0001);
    });

    test('accepts ISO strings as well as Date objects', () => {
        const asIso = recencyAt(t0.toISOString(), t0.toISOString());
        expect(asIso).toBeCloseTo(1.0, 6);
    });

    test('treats negative Δt (now before createdAt) as Δt = 0', () => {
        const earlier = new Date(t0.getTime() - 5 * MS_PER_DAY);
        expect(recencyAt(earlier, t0)).toBe(1.0);
    });

    test('rejects invalid τ', () => {
        expect(() => recencyAt(t0, t0, 0)).toThrow(/tau/);
        expect(() => recencyAt(t0, t0, -1)).toThrow(/tau/);
    });
});
