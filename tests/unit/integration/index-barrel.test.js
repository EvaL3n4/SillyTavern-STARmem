/**
 * Every public symbol Phase 8 promises is re-exported from the barrel.
 * If a later refactor drops one of these, this test catches it before
 * the root index.js starts throwing at extension-load time.
 *
 * Names reconciled with actual module exports in Task 9 (plan drift).
 */
import { describe, test, expect } from '@jest/globals';
import * as barrel from '../../../src/integration/index.js';

describe('integration barrel', () => {
    test('re-exports every Phase 8 public symbol', () => {
        const expected = [
            // constants
            'SETTINGS_KEY', 'SETTINGS_SCHEMA_VERSION', 'SETTINGS_DEFAULTS',
            'SETTINGS_BOUNDS', 'INJECTION_KEY', 'INJECTION_ROLE',
            'VIEWER_TABS', 'CSS_PREFIX',
            // settings
            'getSettings', 'setSettings', 'resetSettings', 'validateSettings',
            '_setContextForTests', '_resetContextForTests',
            // interceptor / bootstrap
            'starmemInterceptor', 'bootstrap',
            // indicator
            'mountIndicator', 'unmountIndicator', '_tickForTests',
            // settings panel
            'renderSettingsPanel',
            // viewer
            'openViewer',
        ];
        for (const name of expected) {
            expect(barrel).toHaveProperty(name);
        }
    });

    test('does not leak internal helpers', () => {
        // resolveContext is an internal in settings.js and must not escape.
        expect(/** @type {any} */ (barrel).resolveContext).toBeUndefined();
    });
});
