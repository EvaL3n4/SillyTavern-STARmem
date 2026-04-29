/**
 * Playwright config for STARmem v2 E2E smokes.
 *
 * Phase 15 scope (narrow): does the extension load, render, and mount cleanly
 * against a real local SillyTavern? Phase 16 will add broad behavioral E2E
 * (interceptor, consolidation, persistence).
 *
 * Assumes a local ST is running at http://localhost:8000. Tests that can't
 * connect skip with a clear message rather than failing.
 */
import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
    testDir: './tests/e2e',
    timeout: 30_000,
    expect: { timeout: 5_000 },
    fullyParallel: false,           // ST is a single-instance backend; serialize
    retries: 0,                     // smoke tests should be deterministic; no flake masking
    workers: 1,
    reporter: process.env.CI ? 'github' : 'list',
    use: {
        baseURL: 'http://localhost:8000',
        trace: 'on-first-retry',
        screenshot: 'only-on-failure',
        video: 'retain-on-failure',
    },
    projects: [
        {
            name: 'chromium',
            use: { ...devices['Desktop Chrome'] },
        },
    ],
});
