/**
 * Smoke 4-7 — Memory Viewer opens, all 5 tabs render, close works.
 */
import { test, expect, openST, expectExtensionLoaded } from './fixtures/st-instance.js';

const TABS = ['working', 'episodic', 'persona', 'graph', 'traces'];

async function openViewer(page) {
    // Open the extensions drawer first to mount the settings panel and reveal
    // the open-viewer button (panel renders inside #extensions_settings2).
    await page.locator('#extensions-settings-button, [data-i18n="Extensions"]').first().click();
    await page.waitForSelector('#starmem-settings-open-viewer', { state: 'visible' });
    await page.locator('#starmem-settings-open-viewer').click();
    await page.waitForSelector('.starmem-viewer', { state: 'visible' });
}

test('viewer opens via settings button', async ({ page }) => {
    await openST(page);
    await expectExtensionLoaded(page);
    await openViewer(page);
    await expect(page.locator('.starmem-viewer')).toBeVisible();
});

for (const tabName of TABS) {
    test(`viewer tab "${tabName}" renders`, async ({ page }) => {
        await openST(page);
        await expectExtensionLoaded(page);
        await openViewer(page);

        // Tabs are buttons with data-tab attribute (per viewer/mount.js).
        await page.locator(`.starmem-viewer-tab[data-tab="${tabName}"]`).click();
        await expect(page.locator(`.starmem-viewer-${tabName}`)).toBeVisible();
    });
}

test('viewer closes via X button', async ({ page }) => {
    await openST(page);
    await expectExtensionLoaded(page);
    await openViewer(page);
    await page.locator('.starmem-viewer-close').click();
    await expect(page.locator('.starmem-viewer')).not.toBeVisible();
});
