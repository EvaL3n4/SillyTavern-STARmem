/**
 * Phase 8 constants are frozen + shaped correctly.
 */
import { describe, test, expect } from '@jest/globals';
import {
    SETTINGS_KEY, SETTINGS_SCHEMA_VERSION, SETTINGS_DEFAULTS, SETTINGS_BOUNDS,
    INJECTION_KEY, INJECTION_ROLE, VIEWER_TABS, CSS_PREFIX,
} from '../../../src/integration/constants.js';

describe('integration/constants', () => {
    test('SETTINGS_KEY is the canonical capitalized name', () => {
        expect(SETTINGS_KEY).toBe('STARmem');
    });

    test('SETTINGS_SCHEMA_VERSION matches the defaults.schemaVersion', () => {
        expect(SETTINGS_DEFAULTS.schemaVersion).toBe(SETTINGS_SCHEMA_VERSION);
    });

    test('SETTINGS_DEFAULTS is frozen', () => {
        expect(Object.isFrozen(SETTINGS_DEFAULTS)).toBe(true);
    });

    test('SETTINGS_DEFAULTS has every key expected by the panel', () => {
        const keys = [
            'schemaVersion', 'profileId', 'embedProfileId', 'bufferSize',
            'idleTimeout', 'scorerId', 'extractionModelLabel', 'tracesMaxLen',
            'debugMode',
        ];
        for (const k of keys) {
            expect(SETTINGS_DEFAULTS).toHaveProperty(k);
        }
    });

    test('SETTINGS_DEFAULTS values pass their own SETTINGS_BOUNDS', () => {
        for (const [field, { min, max }] of Object.entries(SETTINGS_BOUNDS)) {
            const v = /** @type {any} */ (SETTINGS_DEFAULTS)[field];
            expect(v).toBeGreaterThanOrEqual(min);
            expect(v).toBeLessThanOrEqual(max);
        }
    });

    test('INJECTION_KEY is namespaced under STARmem', () => {
        expect(INJECTION_KEY.startsWith('STARmem:')).toBe(true);
    });

    test('INJECTION_ROLE matches ST convention', () => {
        expect(INJECTION_ROLE).toBe('system');
    });

    test('VIEWER_TABS are frozen and match spec §8', () => {
        expect(Object.isFrozen(VIEWER_TABS)).toBe(true);
        expect([...VIEWER_TABS]).toEqual([
            'working', 'episodic', 'persona', 'graph', 'traces',
        ]);
    });

    test('CSS_PREFIX is lowercased to match HTML convention', () => {
        expect(CSS_PREFIX).toBe('starmem');
        expect(CSS_PREFIX).toBe(CSS_PREFIX.toLowerCase());
    });
});
