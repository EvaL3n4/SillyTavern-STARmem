/**
 * Validator for docs/bench/baseline.json — asserts the measured-values
 * artifact is valid JSON with the expected schema and that every tuned key
 * belongs to the swept-key union.
 */
import { describe, test, expect } from '@jest/globals';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import {
    _SWEPT_RETRIEVAL_KEYS,
    _SWEPT_CONSOLIDATION_KEYS,
} from '../../../src/core/constants.js';

const BASELINE_PATH = path.resolve(
    new URL('.', import.meta.url).pathname,
    '..', '..', '..',
    'docs', 'bench', 'baseline.json',
);

const REQUIRED_TOP_KEYS = [
    'asOf',
    'gitSha',
    'corpus',
    'status',
    'statusReason',
    'tuned',
    'headlineMetrics',
    'structuralInvariants',
];

describe('docs/bench/baseline.json', () => {
    let raw;
    let parsed;

    test('file exists', () => {
        raw = readFileSync(BASELINE_PATH, 'utf8');
        expect(raw).toBeTruthy();
    });

    test('is valid JSON', () => {
        expect(() => {
            parsed = JSON.parse(raw);
        }).not.toThrow();
    });

    test('has all required top-level keys', () => {
        for (const key of REQUIRED_TOP_KEYS) {
            expect(parsed).toHaveProperty(key);
        }
    });

    test('status is deferred', () => {
        expect(parsed.status).toBe('deferred');
    });

    test('every tuned key is a swept constant', () => {
        const swept = new Set([
            ..._SWEPT_RETRIEVAL_KEYS,
            ..._SWEPT_CONSOLIDATION_KEYS,
        ]);
        for (const key of Object.keys(parsed.tuned)) {
            expect(swept.has(key)).toBe(true);
        }
    });

    test('headlineMetrics has all four retrievers', () => {
        for (const id of ['ladder', 'bm25only', 'recency', 'random']) {
            expect(parsed.headlineMetrics).toHaveProperty(id);
        }
    });

    test('structuralInvariants has ladderVsRandom and ladderVsBm25Only', () => {
        expect(parsed.structuralInvariants).toHaveProperty('ladderVsRandom');
        expect(parsed.structuralInvariants).toHaveProperty('ladderVsBm25Only');
    });
});
