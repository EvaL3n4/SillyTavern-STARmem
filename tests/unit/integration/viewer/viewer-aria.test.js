/** @jest-environment jsdom */
import { describe, test, expect, afterEach } from '@jest/globals';
import { openViewer, _setContextForTests, _resetContextForTests } from '../../../../src/integration/viewer/mount.js';

describe('viewer ARIA shape', () => {
    afterEach(() => _resetContextForTests());

    test('tablist contains tabs with aria-controls referencing tabpanel id', async () => {
        _setContextForTests({});
        const parent = document.createElement('div');
        document.body.appendChild(parent);
        await openViewer('test', { parent });

        const tablist = parent.querySelector('[role="tablist"]');
        expect(tablist).not.toBeNull();
        const tabs = tablist.querySelectorAll('[role="tab"]');
        expect(tabs.length).toBe(5);
        for (const tab of tabs) {
            const panelId = tab.getAttribute('aria-controls');
            expect(panelId).toBeTruthy();
            const panel = parent.querySelector(`[id="${panelId}"]`);
            expect(panel).not.toBeNull();
            expect(panel.getAttribute('role')).toBe('tabpanel');
        }
        parent.remove();
    });

    test('tabpanel has aria-labelledby pointing back to active tab', async () => {
        _setContextForTests({});
        const parent = document.createElement('div');
        document.body.appendChild(parent);
        await openViewer('test', { parent });
        const activeTab = parent.querySelector('[role="tab"][aria-selected="true"]');
        expect(activeTab).not.toBeNull();
        const tabId = activeTab.id;
        expect(tabId).toBeTruthy();
        const panel = parent.querySelector('[role="tabpanel"]');
        expect(panel.getAttribute('aria-labelledby')).toBe(tabId);
        parent.remove();
    });

    test('only the active tab has tabindex 0; inactive tabs have tabindex -1', async () => {
        _setContextForTests({});
        const parent = document.createElement('div');
        document.body.appendChild(parent);
        await openViewer('test', { parent });
        const tabs = parent.querySelectorAll('[role="tab"]');
        const tabIndices = [...tabs].map(t => t.getAttribute('tabindex'));
        expect(tabIndices.filter(t => t === '0')).toHaveLength(1);
        expect(tabIndices.filter(t => t === '-1')).toHaveLength(4);
        parent.remove();
    });
});
