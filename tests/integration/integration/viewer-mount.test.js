/** @jest-environment jsdom */
/**
 * Viewer mount — tabs, subject filter, close, Popup fallback.
 */
import { describe, test, expect, beforeEach, afterEach, jest } from '@jest/globals';
import {
    openViewer, _setContextForTests, _resetContextForTests,
} from '../../../src/integration/viewer/mount.js';
import { setBackend, _resetBackendForTests } from '../../../src/core/state.js';
import { createEmptyState } from '../../../src/core/schema.js';
import { VIEWER_TABS, CSS_PREFIX } from '../../../src/integration/constants.js';

/** @type {HTMLElement} */
let parent;

beforeEach(() => {
    parent = document.createElement('div');
    document.body.appendChild(parent);
    setBackend({ read: () => createEmptyState(), write: () => {} });
    _setContextForTests({});  // force fallback (no Popup)
});

afterEach(() => {
    _resetContextForTests();
    _resetBackendForTests();
    document.body.innerHTML = '';
});

describe('viewer mount', () => {
    test('openViewer mounts into provided parent with all tab buttons', async () => {
        await openViewer('chat-A', { parent });
        const tabs = parent.querySelectorAll(`.${CSS_PREFIX}-viewer-tab`);
        expect(tabs.length).toBe(VIEWER_TABS.length);
    });

    test('first tab (working) is initially active', async () => {
        await openViewer('chat-A', { parent });
        const active = parent.querySelectorAll(`.${CSS_PREFIX}-viewer-tab-active`);
        expect(active.length).toBe(1);
        expect(/** @type {HTMLElement} */ (active[0]).dataset.tab).toBe('working');
    });

    test('clicking a tab switches the active one', async () => {
        await openViewer('chat-A', { parent });
        const episodicBtn = /** @type {HTMLElement} */ (parent.querySelector('[data-tab="episodic"]'));
        episodicBtn.click();
        // allow the async renderActiveTab to complete
        await new Promise(r => setTimeout(r, 10));
        const active = parent.querySelectorAll(`.${CSS_PREFIX}-viewer-tab-active`);
        expect(/** @type {HTMLElement} */ (active[0]).dataset.tab).toBe('episodic');
    });

    test('close button removes the viewer from DOM', async () => {
        await openViewer('chat-A', { parent });
        const closeBtn = /** @type {HTMLElement} */ (parent.querySelector(`.${CSS_PREFIX}-viewer-close`));
        closeBtn.click();
        expect(parent.querySelector(`.${CSS_PREFIX}-viewer`)).toBeNull();
    });

    test('subject filter input updates state and triggers re-render', async () => {
        const state = await openViewer('chat-A', { parent });
        const input = /** @type {HTMLInputElement} */ (parent.querySelector(`.${CSS_PREFIX}-viewer-subject-input`));
        input.value = 'alice';
        input.dispatchEvent(new Event('input'));
        await new Promise(r => setTimeout(r, 200));  // debounce
        expect(state.subjectFilter).toBe('alice');
    });

    test('tab body renders content after switching tabs', async () => {
        await openViewer('chat-A', { parent });
        const btn = /** @type {HTMLElement} */ (parent.querySelector('[data-tab="graph"]'));
        btn.click();
        await new Promise(r => setTimeout(r, 10));
        const body = /** @type {HTMLElement} */ (parent.querySelector(`.${CSS_PREFIX}-viewer-body`));
        expect(body).not.toBeNull();
        // The graph stub renders a data-tab="graph" element.
        expect(body.querySelector('[data-tab="graph"]')).not.toBeNull();
    });

    test('falls back to document.body when no parent and no Popup', async () => {
        _setContextForTests({});  // no Popup
        const state = await openViewer('chat-A', {});
        expect(document.body.contains(state.root)).toBe(true);
        state.close?.();
    });

    test('uses Popup when available in context', async () => {
        const popupShow = jest.fn();
        const popupComplete = jest.fn();
        _setContextForTests({
            Popup: class {
                constructor() { this.show = popupShow; this.complete = popupComplete; }
            },
            POPUP_TYPE: { TEXT: 1 },
        });
        await openViewer('chat-A', {});
        expect(popupShow).toHaveBeenCalled();
    });

    test('onClose callback fires when close button clicked', async () => {
        const onClose = jest.fn();
        await openViewer('chat-A', { parent, onClose });
        const closeBtn = /** @type {HTMLElement} */ (parent.querySelector(`.${CSS_PREFIX}-viewer-close`));
        closeBtn.click();
        expect(onClose).toHaveBeenCalled();
    });

    test('invalid tab id falls back to error message', async () => {
        const state = await openViewer('chat-A', { parent });
        // Inject a nonexistent tab dynamically.
        state.activeTab = 'nonexistent';
        // Force re-render via subject input.
        const input = /** @type {HTMLInputElement} */ (parent.querySelector(`.${CSS_PREFIX}-viewer-subject-input`));
        input.value = 'x';
        input.dispatchEvent(new Event('input'));
        await new Promise(r => setTimeout(r, 200));
        const body = /** @type {HTMLElement} */ (parent.querySelector(`.${CSS_PREFIX}-viewer-body`));
        expect(body.textContent).toContain('Error');
    });
});
