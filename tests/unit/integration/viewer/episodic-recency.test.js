/**
 * Regression for finding #11 (Codex 2026-04-24): episodic tab called
 * recencyAt(lifecycle, now) — argument-flipped AND passing the wrong type.
 * The real signature is recencyAt(now, createdAt, tau?) where createdAt is
 * a Date or ISO string. Passing a lifecycle object produced Invalid Date →
 * NaN in every row, breaking recency sort and rendering R=NaN.
 *
 * After the fix, R is a finite number formatted as R=<d>.<dd>.
 */
import { describe, test, expect, beforeEach } from '@jest/globals';
import { JSDOM } from 'jsdom';
import { renderTab } from '../../../../src/integration/viewer/tabs/episodic.js';

describe('episodic tab recency rendering', () => {
    let dom;
    beforeEach(() => {
        dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>');
        globalThis.document = dom.window.document;
        globalThis.HTMLElement = dom.window.HTMLElement;
    });

    test('renders a finite recency score for each episodic entry', async () => {
        const entries = {
            'ep_1': {
                id: 'ep_1', scope: 'episodic', content: 'Alice lives in Paris.',
                subject: 'alice', tags: [], relations: [],
                lifecycle: {
                    importance: 50, maturity: 'draft',
                    createdAt: new Date(Date.now() - 24 * 3600 * 1000).toISOString(),
                    updatedAt: new Date().toISOString(),
                    accessCount: 0, updateCount: 0,
                },
                provenance: { sourceMessages: [0], extractor: 'test@v1' },
            },
        };
        const parent = dom.window.document.getElementById('root');
        await renderTab(parent, { chatId: 'c1', subjectFilter: '', state: { entries } });
        const scores = parent.querySelector('.starmem-viewer-scores');
        expect(scores).not.toBeNull();
        expect(scores.textContent).not.toMatch(/NaN/);
        // Format: "I=50  R=0.97  draft·0.85" — R value is a finite number.
        expect(scores.textContent).toMatch(/R=\d+\.\d{2}/);
    });
});
