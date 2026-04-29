/**
 * Smoke 8 — indicator is in idle state by default (no consolidation running
 * on a fresh ST). Confirms the polling path doesn't false-positive on a
 * clean state.
 */
import { test, expect, openST, expectExtensionLoaded } from './fixtures/st-instance.js';

test('indicator defaults to idle', async ({ page }) => {
    await openST(page);
    await expectExtensionLoaded(page);
    const indicator = page.locator('.starmem-indicator');
    await expect(indicator).toHaveClass(/starmem-indicator-idle/);
    await expect(indicator).not.toHaveClass(/starmem-indicator-busy/);
});
