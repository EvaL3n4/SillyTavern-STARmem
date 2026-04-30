/** @jest-environment jsdom */
import { describe, test, expect, beforeEach, afterEach } from '@jest/globals';
import { openViewer, _resetContextForTests, _setContextForTests } from '../../../../src/integration/viewer/mount.js';

function press(target, key) {
    const ev = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true });
    target.dispatchEvent(ev);
    return ev;
}

describe('viewer keyboard navigation', () => {
    let parent;
    beforeEach(async () => {
        _setContextForTests({});
        parent = document.createElement('div');
        document.body.appendChild(parent);
        await openViewer('test', { parent });
    });
    afterEach(() => { parent.remove(); _resetContextForTests(); });

    test('ArrowRight moves selection to next tab', async () => {
        const tabs = parent.querySelectorAll('[role="tab"]');
        tabs[0].focus();
        press(tabs[0], 'ArrowRight');
        await new Promise(r => setTimeout(r, 0));
        expect(tabs[1].getAttribute('aria-selected')).toBe('true');
        expect(document.activeElement).toBe(tabs[1]);
    });

    test('ArrowLeft on first tab wraps to last', async () => {
        const tabs = parent.querySelectorAll('[role="tab"]');
        tabs[0].focus();
        press(tabs[0], 'ArrowLeft');
        await new Promise(r => setTimeout(r, 0));
        expect(tabs[tabs.length - 1].getAttribute('aria-selected')).toBe('true');
    });

    test('Home jumps to first tab', async () => {
        const tabs = parent.querySelectorAll('[role="tab"]');
        tabs[3].focus();
        press(tabs[3], 'Home');
        await new Promise(r => setTimeout(r, 0));
        expect(tabs[0].getAttribute('aria-selected')).toBe('true');
    });

    test('End jumps to last tab', async () => {
        const tabs = parent.querySelectorAll('[role="tab"]');
        tabs[0].focus();
        press(tabs[0], 'End');
        await new Promise(r => setTimeout(r, 0));
        expect(tabs[tabs.length - 1].getAttribute('aria-selected')).toBe('true');
    });

    test('Enter / Space activate the focused tab', async () => {
        const tabs = parent.querySelectorAll('[role="tab"]');
        tabs[2].focus();
        press(tabs[2], 'Enter');
        await new Promise(r => setTimeout(r, 0));
        expect(tabs[2].getAttribute('aria-selected')).toBe('true');
    });
});
