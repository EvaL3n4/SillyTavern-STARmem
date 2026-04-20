import { maturityFor, maturityBoost } from '../../../src/lifecycle/maturity.js';

describe('maturityFor', () => {
    describe('promotion', () => {
        test('draft → validated at ι ≥ 65', () => {
            expect(maturityFor(65, 'draft')).toBe('validated');
            expect(maturityFor(64, 'draft')).toBe('draft');
            expect(maturityFor(100, 'draft')).toBe('validated');
        });

        test('validated → core at ι ≥ 85', () => {
            expect(maturityFor(85, 'validated')).toBe('core');
            expect(maturityFor(84, 'validated')).toBe('validated');
            expect(maturityFor(100, 'validated')).toBe('core');
        });

        test('draft can only step up one tier per call (ι=90, draft → validated)', () => {
            expect(maturityFor(90, 'draft')).toBe('validated');
        });
    });

    describe('demotion', () => {
        test('validated → draft at ι < 35', () => {
            expect(maturityFor(34, 'validated')).toBe('draft');
            expect(maturityFor(35, 'validated')).toBe('validated');
            expect(maturityFor(0, 'validated')).toBe('draft');
        });

        test('core → validated at ι < 60', () => {
            expect(maturityFor(59, 'core')).toBe('validated');
            expect(maturityFor(60, 'core')).toBe('core');
        });

        test('core only steps down one tier per call (ι=10, core → validated)', () => {
            expect(maturityFor(10, 'core')).toBe('validated');
        });
    });

    describe('hysteresis (gap preserved to prevent oscillation)', () => {
        test('oscillating 60 → 70 → 60 keeps validated', () => {
            expect(maturityFor(60, 'validated')).toBe('validated');
            expect(maturityFor(70, 'validated')).toBe('validated');
            expect(maturityFor(60, 'validated')).toBe('validated');
        });

        test('oscillating around 35 does not flip between draft and validated', () => {
            expect(maturityFor(40, 'validated')).toBe('validated');
            expect(maturityFor(36, 'validated')).toBe('validated');
            expect(maturityFor(40, 'validated')).toBe('validated');
            expect(maturityFor(34, 'validated')).toBe('draft');
        });
    });

    describe('invalid inputs', () => {
        test('rejects invalid current tier', () => {
            expect(() => maturityFor(50, /** @type {any} */ ('legendary'))).toThrow(/maturity/i);
        });

        test('rejects out-of-range importance', () => {
            expect(() => maturityFor(-1, 'draft')).toThrow(/importance/i);
            expect(() => maturityFor(101, 'draft')).toThrow(/importance/i);
        });
    });
});

describe('maturityBoost', () => {
    test('returns the spec §5.2 multipliers', () => {
        expect(maturityBoost('draft')).toBe(0.85);
        expect(maturityBoost('validated')).toBe(1.0);
        expect(maturityBoost('core')).toBe(1.2);
    });

    test('rejects invalid maturity', () => {
        expect(() => maturityBoost(/** @type {any} */ ('nope'))).toThrow(/maturity/i);
    });
});
