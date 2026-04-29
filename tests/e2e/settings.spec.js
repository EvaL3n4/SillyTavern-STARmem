/**
 * Smoke 2-3 — settings panel renders into ST's extensions drawer and is
 * interactive.
 */
import { test, expect, openST, expectExtensionLoaded } from './fixtures/st-instance.js';

test('settings panel mounts into ST extensions drawer', async ({ page }) => {
    await openST(page);
    await expectExtensionLoaded(page);

    // Open the extensions drawer. ST's selector for the toggle is stable;
    // the drawer itself is #extensions_settings2 (preferred) or #extensions_settings.
    await page.locator('#extensions-settings-button, [data-i18n="Extensions"]').first().click();
    await page.waitForSelector('#extensions_settings2, #extensions_settings', { state: 'visible' });

    const panel = page.locator('.starmem-settings-panel');
    await expect(panel).toBeVisible();
});

test('settings panel exposes the expected fields', async ({ page }) => {
    await openST(page);
    await expectExtensionLoaded(page);
    await page.locator('#extensions-settings-button, [data-i18n="Extensions"]').first().click();
    await page.waitForSelector('.starmem-settings-panel', { state: 'visible' });

    // Per src/integration/settingsPanel.js: panel uses ID selectors on inputs.
    // Just confirm the structural shape — required IDs exist.
    await expect(page.locator('#starmem-settings-profile-id')).toBeVisible();
    await expect(page.locator('#starmem-settings-scorer')).toBeVisible();
    await expect(page.locator('#starmem-settings-buffer-size')).toBeVisible();
    await expect(page.locator('#starmem-settings-open-viewer')).toBeVisible();
});
