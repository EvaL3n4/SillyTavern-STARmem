/** @jest-environment jsdom */
/**
 * Episodic tab — defensive rendering when an entry has an invalid maturity tag.
 *
 * Regression: the v1 → v2 migration produced entries whose lifecycle.maturity
 * was a free-form string ('mature') rather than the v2 enum
 * (draft|validated|core). Calling maturityBoost() on those throws, which
 * crashed the entire tab render with the user-facing error
 *   "Error rendering tab: maturityBoost: invalid maturity mature"
 *
 * Display-layer policy: the lifecycle module is allowed to be strict about
 * its inputs; the viewer wraps the call so a single corrupt entry doesn't
 * take down the whole tab. Bad maturities render as '?·1.00' (treat as
 * neutral boost), good entries render normally alongside.
 */
import { describe, test, expect, beforeEach } from '@jest/globals';
import { renderTab } from '../../../../src/integration/viewer/tabs/episodic.js';

function makeEntry(id, subject, maturity) {
    return {
        id,
        subject,
        content: `entry ${id}`,
        scope: 'episodic',
        tags: [],
        lifecycle: {
            importance: 50,
            maturity,
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
            accessCount: 0,
            updateCount: 0,
        },
        provenance: { sourceMessages: [0], extractor: 'test@v1' },
    };
}

describe('episodic tab — invalid maturity tolerance', () => {
    let parent;
    beforeEach(() => {
        parent = document.createElement('div');
        document.body.appendChild(parent);
    });

    test('does not throw when an entry has an unknown maturity', async () => {
        const entries = {
            ok: makeEntry('ok', 'Alanis', 'core'),
            bad: makeEntry('bad', 'Theo', 'mature'),  // legacy / corrupt
        };
        await expect(
            renderTab(parent, { chatId: 'c', subjectFilter: '', state: { entries } }),
        ).resolves.not.toThrow();

        // Both rows render — the bad one survives with a fallback score line.
        const items = parent.querySelectorAll('.starmem-viewer-episodic-item');
        expect(items).toHaveLength(2);
    });

    test('renders a fallback score line for the bad entry, real one for the good entry', async () => {
        const entries = {
            ok: makeEntry('ok', 'Alanis', 'core'),
            bad: makeEntry('bad', 'Theo', 'mature'),
        };
        await renderTab(parent, { chatId: 'c', subjectFilter: '', state: { entries } });

        // Find each row by data-id and check its score text.
        const okRow = parent.querySelector('[data-id="ok"]');
        const badRow = parent.querySelector('[data-id="bad"]');
        expect(okRow).not.toBeNull();
        expect(badRow).not.toBeNull();

        const okScores = okRow.querySelector('.starmem-viewer-scores').textContent;
        expect(okScores).toMatch(/core/);

        const badScores = badRow.querySelector('.starmem-viewer-scores').textContent;
        // Display fallback: render the raw maturity string but neutral boost.
        expect(badScores).toMatch(/mature/);
        expect(badScores).toMatch(/1\.00/);
    });

    test('survives an entry with no lifecycle at all', async () => {
        const entries = {
            ok: makeEntry('ok', 'Alanis', 'core'),
            stub: { id: 'stub', subject: 'Mira', content: 'no lifecycle', scope: 'episodic', tags: [] },
        };
        await expect(
            renderTab(parent, { chatId: 'c', subjectFilter: '', state: { entries } }),
        ).resolves.not.toThrow();
        const items = parent.querySelectorAll('.starmem-viewer-episodic-item');
        expect(items).toHaveLength(2);
    });
});
