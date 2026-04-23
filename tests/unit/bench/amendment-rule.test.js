import { test, expect } from '@jest/globals';
import { shouldAmend } from '../../../bench/render/amendment-rule.js';

test('amends when MRR jumps and coverage holds', () => {
    const r = shouldAmend({
        baseline: { mrr: 0.70, coverage: 0.64 },
        candidate: { mrr: 0.75, coverage: 0.63 },
    });
    expect(r.amend).toBe(true);
    expect(r.mrrDelta).toBeCloseTo(0.05, 6);
});

test('refuses when MRR gain is below threshold', () => {
    const r = shouldAmend({
        baseline: { mrr: 0.70, coverage: 0.64 },
        candidate: { mrr: 0.71, coverage: 0.64 },
    });
    expect(r.amend).toBe(false);
    expect(r.reason).toMatch(/below amendment threshold/);
});

test('refuses on subset-selection bias (MRR up but coverage drops)', () => {
    const r = shouldAmend({
        baseline: { mrr: 0.70, coverage: 0.64 },
        candidate: { mrr: 0.80, coverage: 0.48 },
    });
    expect(r.amend).toBe(false);
    expect(r.reason).toMatch(/subset-selection bias/);
});

test('allows small coverage drop within budget', () => {
    const r = shouldAmend({
        baseline: { mrr: 0.70, coverage: 0.64 },
        candidate: { mrr: 0.75, coverage: 0.60 },
    });
    expect(r.amend).toBe(true);
});

test('refuses on NaN inputs', () => {
    const r = shouldAmend({
        baseline: { mrr: NaN, coverage: 0.64 },
        candidate: { mrr: 0.75, coverage: 0.64 },
    });
    expect(r.amend).toBe(false);
    expect(r.reason).toMatch(/NaN/);
});
