/**
 * Phase 9 benchmarking: guard against regressions in the constants override
 * mechanism.
 *
 * The sweep driver (`bench/sweeps/_driver.js`) mutates `RETRIEVAL` and
 * `CONSOLIDATION` at runtime via `setConstantOverrides`. Two properties must
 * hold for that to work:
 *
 * 1. RETRIEVAL and CONSOLIDATION are NOT Object.isFrozen — otherwise
 *    setConstantOverrides throws silently in strict mode.
 *
 * 2. No source file destructures a SWEPT key at module top. Destructuring
 *    snapshots the value once at import time and later mutations are
 *    invisible — exactly the bug Phase 9 Task 3 preflight caught.
 *
 *    Non-swept keys (BM25_K1, FUZZY_JACCARD_THRESHOLD, BATCH_SIZE, etc.)
 *    may still destructure — nothing sweeps them, so module-top snapshots
 *    are fine.
 *
 * 3. setConstantOverrides + resetConstantOverrides round-trip cleanly:
 *    a partial override updates the live object, and reset restores the
 *    module-load value.
 *
 * Tripwire-verify by reintroducing `const { TIER3_LAMBDA_1 } = RETRIEVAL`
 * at the top of tier2-bm25.js — this suite's second describe block must fail
 * with a clear message naming the file and key.
 *
 * @see bench/runner.js — sole production consumer of setConstantOverrides
 * @see docs/plans/phase-9-benchmarking.md Task 3 Step 5
 */

import { describe, test, expect, afterEach } from '@jest/globals';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import {
    RETRIEVAL,
    CONSOLIDATION,
    _SWEPT_RETRIEVAL_KEYS,
    _SWEPT_CONSOLIDATION_KEYS,
    setConstantOverrides,
    resetConstantOverrides,
} from '../../../src/core/constants.js';

const REPO_ROOT = path.resolve(new URL('.', import.meta.url).pathname, '..', '..', '..');
const SRC_ROOT = path.join(REPO_ROOT, 'src');

/** Recursively list all .js files under dir. */
function walkJs(dir) {
    const out = [];
    for (const name of readdirSync(dir)) {
        const full = path.join(dir, name);
        const st = statSync(full);
        if (st.isDirectory()) out.push(...walkJs(full));
        else if (name.endsWith('.js')) out.push(full);
    }
    return out;
}

/** Strip /* ... *\/ and // ... comments before scanning. */
function stripComments(src) {
    return src
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/^\s*\/\/.*$/gm, '');
}

describe('constants groups are mutable (unfrozen)', () => {
    test('RETRIEVAL is not frozen', () => {
        expect(Object.isFrozen(RETRIEVAL)).toBe(false);
    });
    test('CONSOLIDATION is not frozen', () => {
        expect(Object.isFrozen(CONSOLIDATION)).toBe(false);
    });
});

describe('no source file destructures swept keys at module top', () => {
    const allFiles = walkJs(SRC_ROOT).filter(f => f !== path.join(SRC_ROOT, 'core', 'constants.js'));

    for (const key of _SWEPT_RETRIEVAL_KEYS) {
        test(`RETRIEVAL.${key} is not destructured anywhere`, () => {
            const offenders = [];
            // Match `const { ... KEY ... } = RETRIEVAL` — catches the five
            // patterns we rewrote in Task 3a. Comment-stripped.
            const re = new RegExp(
                String.raw`const\s*\{[^}]*\b${key}\b[^}]*\}\s*=\s*RETRIEVAL\b`,
                'm',
            );
            for (const f of allFiles) {
                const code = stripComments(readFileSync(f, 'utf8'));
                if (re.test(code)) offenders.push(path.relative(REPO_ROOT, f));
            }
            expect(offenders).toEqual([]);
        });
    }

    for (const key of _SWEPT_CONSOLIDATION_KEYS) {
        test(`CONSOLIDATION.${key} is not destructured anywhere`, () => {
            const offenders = [];
            const re = new RegExp(
                String.raw`const\s*\{[^}]*\b${key}\b[^}]*\}\s*=\s*CONSOLIDATION\b`,
                'm',
            );
            for (const f of allFiles) {
                const code = stripComments(readFileSync(f, 'utf8'));
                if (re.test(code)) offenders.push(path.relative(REPO_ROOT, f));
            }
            expect(offenders).toEqual([]);
        });
    }
});

describe('setConstantOverrides / resetConstantOverrides', () => {
    afterEach(() => resetConstantOverrides());

    test('sets a single RETRIEVAL key and returns a restore function', () => {
        const before = RETRIEVAL.TIER3_LAMBDA_1;
        const restore = setConstantOverrides({ TIER3_LAMBDA_1: 99 });
        expect(RETRIEVAL.TIER3_LAMBDA_1).toBe(99);
        restore();
        expect(RETRIEVAL.TIER3_LAMBDA_1).toBe(before);
    });

    test('sets a CONSOLIDATION key', () => {
        const before = CONSOLIDATION.DEDUP_JACCARD_THRESHOLD;
        setConstantOverrides({ DEDUP_JACCARD_THRESHOLD: 0.42 });
        expect(CONSOLIDATION.DEDUP_JACCARD_THRESHOLD).toBe(0.42);
        resetConstantOverrides();
        expect(CONSOLIDATION.DEDUP_JACCARD_THRESHOLD).toBe(before);
    });

    test('sets multiple keys across both groups', () => {
        setConstantOverrides({
            TIER3_BEAM_WIDTH: 10,
            TIER3_LAMBDA_2: 0.75,
            DEDUP_JACCARD_THRESHOLD: 0.5,
        });
        expect(RETRIEVAL.TIER3_BEAM_WIDTH).toBe(10);
        expect(RETRIEVAL.TIER3_LAMBDA_2).toBe(0.75);
        expect(CONSOLIDATION.DEDUP_JACCARD_THRESHOLD).toBe(0.5);
    });

    // 9.4.9: TIER3_SEEDS_K and BATCH_SIZE must be overridable for the
    // graph + consolidation sweeps. Both were unregistered until this
    // sub-phase; tests below catch regressions.
    test('9.4.9: TIER3_SEEDS_K override lands on RETRIEVAL and restores', () => {
        const before = RETRIEVAL.TIER3_SEEDS_K;
        const restore = setConstantOverrides({ TIER3_SEEDS_K: 7 });
        expect(RETRIEVAL.TIER3_SEEDS_K).toBe(7);
        restore();
        expect(RETRIEVAL.TIER3_SEEDS_K).toBe(before);
    });

    test('9.4.9: BATCH_SIZE override lands on CONSOLIDATION and restores', () => {
        const before = CONSOLIDATION.BATCH_SIZE;
        const restore = setConstantOverrides({ BATCH_SIZE: 10 });
        expect(CONSOLIDATION.BATCH_SIZE).toBe(10);
        restore();
        expect(CONSOLIDATION.BATCH_SIZE).toBe(before);
    });

    test('rejects unknown keys and undoes partial application', () => {
        const beforeBeam = RETRIEVAL.TIER3_BEAM_WIDTH;
        expect(() =>
            setConstantOverrides({ TIER3_BEAM_WIDTH: 20, NOT_A_KEY: 0 }),
        ).toThrow(/unknown or non-swept/);
        // Partial rollback: TIER3_BEAM_WIDTH must NOT have leaked into the live
        // state even though it was processed before the bad key.
        expect(RETRIEVAL.TIER3_BEAM_WIDTH).toBe(beforeBeam);
    });

    test('rejects non-swept keys from the same group (e.g. FUZZY_JACCARD_THRESHOLD)', () => {
        expect(() =>
            setConstantOverrides({ FUZZY_JACCARD_THRESHOLD: 0.9 }),
        ).toThrow(/unknown or non-swept/);
    });

    test('rejects non-object input', () => {
        expect(() => setConstantOverrides(null)).toThrow(/must be an object/);
        // @ts-expect-error — deliberately passing a string to exercise the guard.
        expect(() => setConstantOverrides('bad')).toThrow(/must be an object/);
    });

    test('resetConstantOverrides restores all swept keys to module-load values', () => {
        setConstantOverrides({
            TIER3_LAMBDA_1: 2,
            DEDUP_JACCARD_THRESHOLD: 0.3,
        });
        resetConstantOverrides();
        expect(RETRIEVAL.TIER3_LAMBDA_1).toBe(1.0);
        expect(CONSOLIDATION.DEDUP_JACCARD_THRESHOLD).toBe(0.7);
    });
});
