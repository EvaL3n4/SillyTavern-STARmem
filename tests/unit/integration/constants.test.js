/**
 * Phase 8 constants are frozen + shaped correctly.
 */
import { describe, test, expect } from '@jest/globals';
import {
    SETTINGS_KEY, SETTINGS_SCHEMA_VERSION, SETTINGS_DEFAULTS, SETTINGS_BOUNDS,
    INJECTION_PROMPT_KEY, INJECTION_DEPTH, INJECTION_POSITION_IN_CHAT, INJECTION_ROLE_SYSTEM,
    VIEWER_TABS, CSS_PREFIX,
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

    test('INJECTION_PROMPT_KEY is stable + namespaced under STARmem', () => {
        expect(INJECTION_PROMPT_KEY).toBe('STARmem');
    });

    test('INJECTION_DEPTH matches ST in-chat convention', () => {
        expect(INJECTION_DEPTH).toBe(4);
    });

    test('INJECTION_POSITION_IN_CHAT mirrors ST extension_prompt_types.IN_CHAT', () => {
        // Source of truth: public/script.js -> extension_prompt_types.IN_CHAT = 1.
        expect(INJECTION_POSITION_IN_CHAT).toBe(1);
    });

    test('INJECTION_ROLE_SYSTEM mirrors ST extension_prompt_roles.SYSTEM', () => {
        // Source of truth: public/script.js -> extension_prompt_roles.SYSTEM = 0.
        expect(INJECTION_ROLE_SYSTEM).toBe(0);
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
