/**
 * Visual smoke — open the viewer with synthetic data and screenshot every tab.
 * Not a regression test; this is the eyeball-it artifact for design review.
 */
import { test } from '@playwright/test';
import { openST, expectExtensionLoaded } from './fixtures/st-instance.js';
import { mkdirSync } from 'node:fs';

const TABS = ['working', 'episodic', 'persona', 'graph', 'traces'];
const SHOTDIR = 'test-results/viewer-visual-populated';

const SEED = `(async () => {
    const { openViewer } = await import('/scripts/extensions/third-party/SillyTavern-STARmem/src/integration/viewer/mount.js');
    const ctx = window.SillyTavern.getContext();
    const cm = ctx.chatMetadata;
    const chatId = ctx.chatId || 'visual-smoke';
    const now = new Date().toISOString();
    const mk = (id, scope, subject, content, importance, tags, mat) => ({
        id, scope, subject, content, tags: tags || [],
        lifecycle: { createdAt: now, importance, maturity: mat },
        provenance: { extractor: 'gpt-4o-mini@v1', sourceMessages: [1, 2] },
    });
    cm.STARmem = cm.STARmem || {};
    cm.STARmem[chatId] = {
        entries: {
            e1: mk('e1', 'episodic', 'Seraphina', 'Seraphina mentioned her childhood spent in the lighthouse on the eastern coast, where her grandmother taught her to read tide tables before she could read books.', 8.5, ['biography', 'origin'], 'core'),
            e2: mk('e2', 'episodic', 'Seraphina', 'Confirmed she has two younger sisters, Iola and Mara. Iola is a midwife; Mara teaches at the village school.', 7.2, ['family'], 'validated'),
            e3: mk('e3', 'episodic', 'Theo', 'Theo is studying marine biology at the coastal university and works part-time at the harbor cafe to cover rent.', 6.8, ['biography'], 'validated'),
            e4: mk('e4', 'episodic', 'Theo', 'Has a strong dislike of crowded spaces; prefers solo work and long walks at low tide.', 5.1, ['preferences'], 'draft'),
            e5: mk('e5', 'persona', 'Seraphina', 'Quiet, careful, prone to long silences. Trusts slowly. Childhood by the sea shaped her affinity for solitude and tides; the lighthouse remains her metaphor for steady, patient presence.', 0, [], 'core'),
            e6: mk('e6', 'persona', 'Theo', 'Pragmatic and reserved. Avoids crowds. Anchored by routine and the harbor; finds calm in repetitive, careful work like sorting specimens or cleaning equipment.', 0, [], 'validated'),
            e7: mk('e7', 'working', '', 'Mid-conversation observation: Theo arrived early today, seemed restless, kept checking the dock as if waiting for someone.', 0, [], 'draft'),
            e8: mk('e8', 'working', '', 'Seraphina stayed late after the others left. Said little but wrote a long letter, folded it carefully, never sent it.', 0, [], 'draft'),
        },
        workingBuffer: ['e7', 'e8'],
        graph: { edges: [
            { from: 'e1', to: 'e5', type: 'supports', weight: 0.92 },
            { from: 'e2', to: 'e5', type: 'supports', weight: 0.78 },
            { from: 'e3', to: 'e6', type: 'supports', weight: 0.85 },
            { from: 'e4', to: 'e6', type: 'supports', weight: 0.71 },
            { from: 'e1', to: 'e2', type: 'same_topic', weight: 0.55 },
            { from: 'e3', to: 'e4', type: 'same_topic', weight: 0.62 },
        ]},
        tierCaches: { exact: {}, fuzzy: {} },
        runtime: {
            lastConsolidation: null,
            pendingPersonaRebuild: false,
            consolidating: false,
            episodicCountSinceLastRebuild: 0,
            traces: [
                { kind: 'retrieve', timestamp: now, classifier: 'factual', tierResolved: 0, query: 'where is seraphina from', perTier: { '0': [{ id: 'e1', score: 1.0 }] } },
                { kind: 'retrieve', timestamp: now, classifier: 'relational', tierResolved: 3, query: 'what does theo study', perTier: { '3': [{ id: 'e3', score: 0.74 }] }, cause: 'swipe' },
                { kind: 'retrieve', timestamp: now, classifier: 'factual', tierResolved: 1, query: 'theo crowds', perTier: { '1': [{ id: 'e4', score: 0.91 }] }, cause: 'regenerate' },
                { kind: 'consolidate', timestamp: now, durationMs: 412, extractor: 'gpt-4o-mini', summary: { factCount: 7 } },
                { kind: 'retrieve', timestamp: now, classifier: 'factual', tierResolved: 'floor', query: '(empty corpus)', perTier: {} },
            ],
        },
    };
    await openViewer(chatId);
})()`;

test('visual — populated viewer, every tab', async ({ page }) => {
    mkdirSync(SHOTDIR, { recursive: true });
    await openST(page);
    await expectExtensionLoaded(page);
    await page.evaluate(SEED);
    await page.waitForSelector('.starmem-viewer', { state: 'visible', timeout: 10_000 });

    for (const t of TABS) {
        await page.locator(`.starmem-viewer-tab[data-tab="${t}"]`).click();
        await page.waitForSelector(`.starmem-viewer-${t}`, { state: 'visible' });
        // Wait a tick for animation/render
        await page.waitForTimeout(150);
        const viewer = page.locator('.starmem-viewer');
        await viewer.screenshot({ path: `${SHOTDIR}/tab-${t}.png` });
    }
});
