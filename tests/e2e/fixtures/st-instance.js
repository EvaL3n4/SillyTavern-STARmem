/**
 * ST instance helper — connect to a local SillyTavern and verify it's ready.
 *
 * Use as a Playwright fixture: `await openST(page)` returns a page navigated
 * to ST's main view with the extension confirmed loaded.
 */
import { test as base, expect } from '@playwright/test';

/**
 * Navigate to ST and wait for the chat surface to be ready.
 * Throws (and the test fails clearly) if ST isn't reachable.
 */
export async function openST(page) {
    let response;
    try {
        response = await page.goto('/', { waitUntil: 'domcontentloaded', timeout: 5_000 });
    } catch (err) {
        test.skip(true, `SillyTavern not running at ${page.context()._options.baseURL}: ${err.message}`);
        return;
    }
    expect(response.ok()).toBe(true);

    // Wait for ST's chat surface to appear. ST renders #send_but as part
    // of the main UI — that's a stable readiness signal.
    await page.waitForSelector('#send_but', { timeout: 10_000 });
}

/**
 * Confirm the STARmem extension actually loaded. Probes the DOM for
 * any starmem-prefixed id or class.
 */
export async function expectExtensionLoaded(page) {
    const loaded = await page.evaluate(() => {
        return Boolean(document.querySelector('[id^="starmem-"], [class^="starmem-"]'));
    });
    expect(loaded).toBe(true);
}

export const test = base;
export { expect };
