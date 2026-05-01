
import { test } from '@playwright/test';
import { openST, expectExtensionLoaded } from './fixtures/st-instance.js';
import { mkdirSync } from 'node:fs';

const TABS = ['working', 'episodic', 'persona', 'graph', 'traces'];
const SHOTDIR = 'test-results/viewer-visual';

test('visual smoke — viewer + each tab', async ({ page }) => {
    mkdirSync(SHOTDIR, { recursive: true });
    await openST(page);
    await expectExtensionLoaded(page);

    // Open viewer programmatically by importing the module from the running
    // extension. The extension is already loaded so its entry point pulled
    // in mount.js — but the export isn't on window. Re-import via dynamic
    // import from inside the page to call openViewer with the active chatId.
    await page.evaluate(async () => {
        const { openViewer } = await import('/scripts/extensions/third-party/SillyTavern-STARmem/src/integration/viewer/mount.js');
        const ctx = (window).SillyTavern?.getContext?.() || {};
        await openViewer(ctx.chatId || 'visual-smoke');
    });

    await page.waitForSelector('.starmem-viewer', { state: 'visible', timeout: 10_000 });
    await page.screenshot({ path: `${SHOTDIR}/00-shell.png`, fullPage: true });

    for (const t of TABS) {
        await page.locator(`.starmem-viewer-tab[data-tab="${t}"]`).click();
        await page.waitForSelector(`.starmem-viewer-${t}`, { state: 'visible' });
        await page.screenshot({ path: `${SHOTDIR}/tab-${t}.png`, fullPage: true });
    }
});
