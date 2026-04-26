/**
 * Regression for findings #1, #2, #14: reject or sanitize prototype-reserved
 * keys (__proto__, constructor, prototype) across every surface that builds
 * a map from attacker- or LLM-supplied strings.
 */
import { describe, test, expect, beforeEach, afterEach } from '@jest/globals';
import { JSDOM } from 'jsdom';

describe('prototype pollution guards', () => {
    describe('persona grouping (finding #1)', () => {
        let dom;
        let prevSillyTavern;
        beforeEach(() => {
            dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>');
            globalThis.document = dom.window.document;
            globalThis.HTMLElement = dom.window.HTMLElement;
            // Stub the ST global so getSettings() resolves a context instead of
            // throwing. We bind a fresh extensionSettings record per test.
            prevSillyTavern = /** @type {any} */ (globalThis).SillyTavern;
            /** @type {any} */ (globalThis).SillyTavern = {
                getContext: () => ({
                    extensionSettings: {},
                    saveSettingsDebounced: () => {},
                }),
            };
        });

        afterEach(() => {
            /** @type {any} */ (globalThis).SillyTavern = prevSillyTavern;
        });

        test('groups persona entries with subject="__proto__" without crashing', async () => {
            const { renderTab } = await import('../../../src/integration/viewer/tabs/persona.js');
            const entries = {
                'ps_1': makePersona('ps_1', '__proto__'),
                'ps_2': makePersona('ps_2', 'constructor'),
                'ps_3': makePersona('ps_3', 'toString'),
                'ps_4': makePersona('ps_4', 'alice'),
            };
            const parent = dom.window.document.getElementById('root');
            await expect(
                renderTab(parent, { chatId: 'c1', subjectFilter: '', state: { entries } }),
            ).resolves.not.toThrow();
            // At least one subject group rendered — no crash means the fix holds.
            const groups = parent.querySelectorAll('.starmem-viewer-persona-group');
            expect(groups.length).toBeGreaterThan(0);
        });
    });

    describe('bootstrap state backend (finding #2)', () => {
        test('write(__proto__, value) does NOT mutate Object.prototype', async () => {
            const { buildStateBackend } = await import('../../../src/integration/bootstrap.js');
            const { _setContextForTests, _resetContextForTests } =
                await import('../../../src/integration/bootstrap.js');
            const chatMetadata = {};
            _setContextForTests({ chatMetadata, saveMetadataDebounced: () => {} });
            const backend = buildStateBackend();

            const before = Object.prototype.toString;
            expect(() => backend.write('__proto__', { polluted: true })).toThrow(
                /reserved key|invalid chatId/i,
            );
            expect(Object.prototype.toString).toBe(before);
            // Ensure a clean object didn't inherit pollution.
            expect(/** @type {any} */({}).polluted).toBeUndefined();
            _resetContextForTests();
        });

        test('write(constructor, value) is rejected', async () => {
            const { buildStateBackend, _setContextForTests, _resetContextForTests } =
                await import('../../../src/integration/bootstrap.js');
            _setContextForTests({ chatMetadata: {}, saveMetadataDebounced: () => {} });
            const backend = buildStateBackend();
            expect(() => backend.write('constructor', {})).toThrow(/reserved key|invalid chatId/i);
            _resetContextForTests();
        });
    });

    describe('extractFacts relation validator (finding #14)', () => {
        test('rejects relation targets that collide with prototype keys', async () => {
            const { validateExtractionShape } = await import(
                '../../../src/consolidation/extractFacts.js'
            );
            // Phase 12 Task 7 (commit f0fab65) wrapped per-entry validation in
            // a try/catch — our throw is now caught and recorded as a skip
            // rather than propagating. The security guarantee still holds:
            // the malformed entry is dropped, so state.entries[__proto__] is
            // never reached. Assert the skip path instead of toThrow.
            for (const target of ['__proto__', 'constructor', 'prototype']) {
                const out = validateExtractionShape({
                    entries: [{
                        content: 'x', subject: null, tags: [],
                        relations: [{ type: 'mentions', target }],
                    }],
                });
                expect(out.specs).toHaveLength(0);
                expect(out.skipped).toBe(1);
                expect(out.skipReasons[0]).toMatch(/reserved/i);
            }
        });

        test('still accepts ordinary targets', async () => {
            const { validateExtractionShape } = await import(
                '../../../src/consolidation/extractFacts.js'
            );
            const out = validateExtractionShape({
                entries: [{
                    content: 'x', subject: null, tags: [],
                    relations: [{ type: 'mentions', target: 'ep_2026-04-24T10_abcdef012345' }],
                }],
            });
            expect(out.specs[0].relations).toHaveLength(1);
            expect(out.specs[0].relations[0].target).toBe('ep_2026-04-24T10_abcdef012345');
            expect(out.skipped).toBe(0);
        });
    });
});

function makePersona(id, subject) {
    return {
        id, scope: 'persona', content: 'x', subject, tags: [], relations: [],
        lifecycle: {
            importance: 50, maturity: 'draft',
            createdAt: '2026-04-24T10:00:00Z', updatedAt: '2026-04-24T10:00:00Z',
            accessCount: 0, updateCount: 0,
        },
        provenance: { sourceMessages: [0], extractor: 'test@v1' },
    };
}
