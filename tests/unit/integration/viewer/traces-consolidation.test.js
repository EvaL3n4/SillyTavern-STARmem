/**
 * Viewer render tests for consolidation trace rows in the Traces tab.
 */
import { describe, test, expect, beforeEach } from '@jest/globals';
import { JSDOM } from 'jsdom';
import { renderTab } from '../../../../src/integration/viewer/tabs/traces.js';

describe('traces tab renders consolidation events distinctly', () => {
    let dom;
    beforeEach(() => {
        dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>');
        globalThis.document = dom.window.document;
        globalThis.HTMLElement = dom.window.HTMLElement;
    });

    test('renders a {kind: "consolidate"} trace with event badge + meta line', async () => {
        const parent = dom.window.document.getElementById('root');
        const ctx = {
            chatId: 'test',
            state: {
                runtime: {
                    traces: [{
                        kind: 'consolidate',
                        timestamp: '2026-04-29T13:47:02.000Z',
                        chatId: 'test',
                        summary: { factCount: 7, added: 5, updated: 2, scope: 'episodic' },
                        durationMs: 412,
                        extractor: 'gpt-4o-mini',
                    }],
                },
            },
        };
        await renderTab(parent, ctx);
        const items = parent.querySelectorAll('.starmem-viewer-traces-item');
        expect(items).toHaveLength(1);
        const badge = items[0].querySelector('.starmem-tier-badge.starmem-tier-badge-event');
        expect(badge).not.toBeNull();
        expect(badge.textContent).toBe('consolidate');
        const summary = items[0].querySelector('.starmem-viewer-traces-summary');
        expect(summary.textContent).toContain('7 facts');
        expect(summary.textContent).toContain('412ms');
        expect(summary.textContent).toContain('gpt-4o-mini');
    });

    test('renders a failed-consolidate trace with · failed marker', async () => {
        const parent = dom.window.document.getElementById('root');
        const ctx = {
            chatId: 'test',
            state: {
                runtime: {
                    traces: [{
                        kind: 'consolidate',
                        timestamp: '2026-04-29T13:47:02.000Z',
                        chatId: 'test',
                        summary: { factCount: 0, added: 0, updated: 0, scope: 'episodic', error: 'parse_failure' },
                        durationMs: 30000,
                        extractor: 'gpt-4o-mini',
                    }],
                },
            },
        };
        await renderTab(parent, ctx);
        const summary = parent.querySelector('.starmem-viewer-traces-summary');
        expect(summary.textContent).toContain('failed');
    });

    test('mixed kinds: both retrieve and consolidate render, latest-first ordering preserved', async () => {
        const parent = dom.window.document.getElementById('root');
        const ctx = {
            chatId: 'test',
            state: {
                runtime: {
                    traces: [
                        { timestamp: '2026-04-29T13:46:55Z', tierResolved: 3, classifier: 'relational', query: 'q1' },
                        { kind: 'consolidate', timestamp: '2026-04-29T13:47:02.000Z', chatId: 'test', summary: { factCount: 2, added: 2, updated: 0, scope: 'episodic' }, durationMs: 120, extractor: 'm' },
                    ],
                },
            },
        };
        await renderTab(parent, ctx);
        const items = parent.querySelectorAll('.starmem-viewer-traces-item');
        expect(items).toHaveLength(2);
        // Latest first: consolidate (13:47:02) should be first, retrieve (13:46:55) second
        expect(items[0].textContent).toContain('consolidate');
        expect(items[1].textContent).toContain('q1');
    });
});
