/**
 * Viewer render tests for the cause badge on retrieve traces.
 *
 * The cause badge tells internal users why the same query is being
 * retrieved again — swipe / continue / regenerate / impersonate / quiet —
 * so they don't read consecutive identical traces as "the buffer
 * re-grew." Normal (fresh user turn) gets no badge to keep the
 * common case visually quiet.
 */
import { describe, test, expect, beforeEach } from '@jest/globals';
import { JSDOM } from 'jsdom';
import { formatCauseLabel, renderTab } from '../../../../src/integration/viewer/tabs/traces.js';

describe('formatCauseLabel', () => {
    test('returns null for normal turns and falsy values', () => {
        expect(formatCauseLabel('normal')).toBeNull();
        expect(formatCauseLabel('')).toBeNull();
        expect(formatCauseLabel(null)).toBeNull();
        expect(formatCauseLabel(undefined)).toBeNull();
    });

    test("maps swipe / continue / impersonate / quiet to themselves", () => {
        expect(formatCauseLabel('swipe')).toBe('swipe');
        expect(formatCauseLabel('continue')).toBe('continue');
        expect(formatCauseLabel('impersonate')).toBe('impersonate');
        expect(formatCauseLabel('quiet')).toBe('quiet');
    });

    test("shortens 'regenerate' to 'regen' to keep the chip compact", () => {
        expect(formatCauseLabel('regenerate')).toBe('regen');
    });

    test('returns null for unknown causes (no rogue badges)', () => {
        expect(formatCauseLabel('something_new')).toBeNull();
        expect(formatCauseLabel(/** @type {any} */ (42))).toBeNull();
    });
});

describe('traces tab renders cause badge alongside tier badge', () => {
    let dom;
    beforeEach(() => {
        dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>');
        globalThis.document = dom.window.document;
        globalThis.HTMLElement = dom.window.HTMLElement;
    });

    /** @returns {{ kind: 'retrieve', timestamp: string, tierResolved: 3, classifier: string, query: string, cause?: string }} */
    function retrieveTrace(extra = {}) {
        return {
            kind: 'retrieve',
            timestamp: '2026-05-01T13:00:00Z',
            tierResolved: 3,
            classifier: 'relational',
            query: 'tell me about Eva',
            ...extra,
        };
    }

    test("renders 'swipe' cause badge when trace.cause === 'swipe'", async () => {
        const parent = dom.window.document.getElementById('root');
        await renderTab(parent, {
            chatId: 't',
            state: { runtime: { traces: [retrieveTrace({ cause: 'swipe' })] } },
        });
        const cause = parent.querySelector('.starmem-cause-badge');
        expect(cause).not.toBeNull();
        expect(cause.textContent).toBe('swipe');
        expect(cause.classList.contains('starmem-cause-swipe')).toBe(true);
        // Hover tooltip exposes the raw cause for power users.
        expect(cause.getAttribute('title')).toBe('Generation type: swipe');
    });

    test("renders 'continue' cause badge for trace.cause === 'continue'", async () => {
        const parent = dom.window.document.getElementById('root');
        await renderTab(parent, {
            chatId: 't',
            state: { runtime: { traces: [retrieveTrace({ cause: 'continue' })] } },
        });
        const cause = parent.querySelector('.starmem-cause-badge');
        expect(cause?.textContent).toBe('continue');
    });

    test("renders 'regen' (shortened) for trace.cause === 'regenerate'", async () => {
        const parent = dom.window.document.getElementById('root');
        await renderTab(parent, {
            chatId: 't',
            state: { runtime: { traces: [retrieveTrace({ cause: 'regenerate' })] } },
        });
        const cause = parent.querySelector('.starmem-cause-badge');
        expect(cause?.textContent).toBe('regen');
    });

    test('renders NO cause badge for normal turns (the common case stays quiet)', async () => {
        const parent = dom.window.document.getElementById('root');
        await renderTab(parent, {
            chatId: 't',
            state: { runtime: { traces: [retrieveTrace({ cause: 'normal' })] } },
        });
        // Tier badge present; cause badge absent.
        expect(parent.querySelector('.starmem-tier-badge')).not.toBeNull();
        expect(parent.querySelector('.starmem-cause-badge')).toBeNull();
    });

    test('renders NO cause badge when trace.cause is missing (legacy trace)', async () => {
        // Pre-2.0.5 traces have no cause field. They must render without
        // crashing and without spurious badges.
        const parent = dom.window.document.getElementById('root');
        await renderTab(parent, {
            chatId: 't',
            state: { runtime: { traces: [retrieveTrace()] } },
        });
        expect(parent.querySelector('.starmem-cause-badge')).toBeNull();
    });

    test('cause badge renders alongside (not instead of) the tier badge', async () => {
        const parent = dom.window.document.getElementById('root');
        await renderTab(parent, {
            chatId: 't',
            state: { runtime: { traces: [retrieveTrace({ cause: 'swipe' })] } },
        });
        const badges = parent.querySelectorAll('.starmem-tier-badge');
        // Tier badge + cause badge both share .starmem-tier-badge for
        // baseline styling — assert two badges in DOM order: tier, cause.
        expect(badges.length).toBe(2);
        expect(badges[0].textContent).toBe('T3');
        expect(badges[1].textContent).toBe('swipe');
    });
});
