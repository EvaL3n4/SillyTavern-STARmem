/**
 * Viewer render tests for tier label formatting in the Traces tab.
 */
import { describe, test, expect, beforeEach } from '@jest/globals';
import { JSDOM } from 'jsdom';
import { formatTierLabel, renderTab } from '../../../../src/integration/viewer/tabs/traces.js';

describe('formatTierLabel—post-Phase-14 ladder honesty', () => {
    test('T0 / T1 / T3 are the only tier numbers', () => {
        expect(formatTierLabel(0)).toBe('T0');
        expect(formatTierLabel(1)).toBe('T1');
        expect(formatTierLabel(3)).toBe('T3');
    });

    test("'floor' renders as 'Floor'", () => {
        expect(formatTierLabel('floor')).toBe('Floor');
    });

    test('legacy T2 is renamed to T3 (Phase 14 backfill—Tier 2 demolished)', () => {
        expect(formatTierLabel(2)).toBe('T3');
    });

    test('bench-only control conditions map to honest labels', () => {
        expect(formatTierLabel('bm25only')).toBe('BM25');
        expect(formatTierLabel('recency')).toBe('Recent');
        expect(formatTierLabel('random')).toBe('Rand');
    });

    test('null/undefined returns ?', () => {
        expect(formatTierLabel(null)).toBe('?');
        expect(formatTierLabel(undefined)).toBe('?');
    });
});

describe('traces tab renders retrieve tier badges', () => {
    let dom;
    beforeEach(() => {
        dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>');
        globalThis.document = dom.window.document;
        globalThis.HTMLElement = dom.window.HTMLElement;
    });

    test('renders T3 badge for retrieve trace with tierResolved: 3', async () => {
        const parent = dom.window.document.getElementById('root');
        const ctx = {
            chatId: 'test',
            state: {
                runtime: {
                    traces: [{
                        kind: 'retrieve',
                        timestamp: '2026-04-29T13:00:00Z',
                        tierResolved: 3,
                        classifier: 'relational',
                        query: 'x',
                    }],
                },
            },
        };
        await renderTab(parent, ctx);
        const badge = parent.querySelector('.starmem-tier-badge');
        expect(badge).not.toBeNull();
        expect(badge.textContent).toBe('T3');
    });

    test('renders BM25 badge for bench trace with tierResolved: "bm25only"', async () => {
        const parent = dom.window.document.getElementById('root');
        const ctx = {
            chatId: 'test',
            state: {
                runtime: {
                    traces: [{
                        kind: 'retrieve',
                        timestamp: '2026-04-29T13:00:00Z',
                        tierResolved: 'bm25only',
                        classifier: 'keyword',
                        query: 'bench query',
                    }],
                },
            },
        };
        await renderTab(parent, ctx);
        const badge = parent.querySelector('.starmem-tier-badge');
        expect(badge).not.toBeNull();
        expect(badge.textContent).toBe('BM25');
    });
});
