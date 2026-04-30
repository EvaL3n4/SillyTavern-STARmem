/**
 * Smoke 1 — STARmem loads cleanly into ST with no console errors.
 *
 * This is the most basic guarantee: opening ST with the extension installed
 * does not throw, does not log errors, and the extension's bootstrap path
 * runs to completion.
 */
import { test, expect, openST, expectExtensionLoaded } from './fixtures/st-instance.js';

test('extension loads with no console errors', async ({ page }) => {
    /** @type {string[]} */
    const errors = [];
    page.on('console', (msg) => {
        if (msg.type() === 'error') errors.push(msg.text());
    });
    page.on('pageerror', (err) => errors.push(err.message));

    await openST(page);
    await expectExtensionLoaded(page);

    // Filter out ST's own pre-existing console noise (network 404s for
    // optional extension manifests, etc.) by requiring the error to mention
    // STARmem-related identifiers.
    const ourErrors = errors.filter(e =>
        /starmem|STARmem|integration\/(bootstrap|interceptor|indicator|settings)/i.test(e),
    );
    expect(ourErrors).toEqual([]);
});

test('indicator mounts at send-form anchor', async ({ page }) => {
    await openST(page);
    await expectExtensionLoaded(page);
    // P16 T5: indicator mounts inside #send_form (or floats fixed if absent).
    const indicator = page.locator('.starmem-indicator');
    await expect(indicator).toHaveCount(1);
    await expect(indicator).toBeVisible();
});
