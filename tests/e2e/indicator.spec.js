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

test('idle indicator is visible (Quiet Library: always-on quiet dot)', async ({ page }) => {
    await openST(page);
    await expectExtensionLoaded(page);
    const indicator = page.locator('.starmem-indicator');
    // P16 T5: idle is no longer invisible. It uses --starmem-fg-muted at
    // 0.4 opacity so the user can always see "STARmem is here, watching."
    // Pin both: non-transparent background and the reduced opacity.
    const computed = await indicator.evaluate((el) => {
        const cs = getComputedStyle(el);
        return { background: cs.backgroundColor, opacity: cs.opacity };
    });
    expect(computed.background).not.toBe('rgba(0, 0, 0, 0)');
    expect(computed.background).not.toBe('transparent');
    // Opacity should be the idle value (0.4) — busy bumps it to 1.
    expect(parseFloat(computed.opacity)).toBeLessThan(1);
});
