/**
 * Phase 8 integration barrel.
 *
 * Re-exports the public surface of src/integration/ so the root index.js
 * and JSDOM integration tests have a single import target.
 *
 * Keeps DOM-specific exports (settingsPanel, indicator, viewer) together
 * so the root index.js can selectively opt into them without reaching
 * across the folder.
 *
 * Names reflect what each module actually exports (plan-task drift
 * reconciled in Task 9): interceptor exports `starmemInterceptor`,
 * settingsPanel exports `renderSettingsPanel`, viewer exports `openViewer`,
 * bootstrap.js has no `teardown` (idempotent bootstrap + event unsubscribe
 * is handled on CHAT_CHANGED by bootstrap itself).
 *
 * @module integration
 * @see docs/specs/2026-04-20-starmem-v2-design.md §8
 */

export * from './constants.js';
export {
    getSettings, setSettings, resetSettings, validateSettings,
    _setContextForTests, _resetContextForTests,
} from './settings.js';
export { starmemInterceptor } from './interceptor.js';
export { bootstrap } from './bootstrap.js';
export { mountIndicator, unmountIndicator, _tickForTests } from './indicator.js';
export { renderSettingsPanel } from './settingsPanel.js';
export { openViewer } from './viewer/mount.js';
