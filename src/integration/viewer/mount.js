/**
 * Memory Viewer shell — tabbed modal with Working/Episodic/Persona/Graph/Traces.
 *
 * Opens via openViewer(chatId); closes via the X button (or Popup dismiss).
 * Individual tabs render their own content; this module handles tab switching,
 * the shared subject filter, and modal lifecycle.
 *
 * @module integration/viewer/mount
 * @see docs/specs/2026-04-20-starmem-v2-design.md §8
 */

import { VIEWER_TABS, CSS_PREFIX } from '../constants.js';
import { loadState } from '../../core/state.js';
import { createLogger } from '../../core/logger.js';

const log = createLogger({ debug: false }).scope('integration:viewer');

/** @type {any} */
let testContext = null;

/** Test-only: inject a fake getContext() result. */
export function _setContextForTests(ctx) { testContext = ctx; }
/** Test-only: clear injected context. */
export function _resetContextForTests() { testContext = null; }

function resolveContext() {
    if (testContext !== null) return testContext;
    const st = /** @type {any} */ (globalThis).SillyTavern;
    if (!st || typeof st.getContext !== 'function') return {};
    return st.getContext();
}

/**
 * @typedef {object} ViewerState
 * @property {string} chatId
 * @property {string} activeTab
 * @property {string} subjectFilter
 * @property {HTMLElement} root
 * @property {HTMLElement} tabBody
 * @property {() => void} [close]
 */

/**
 * Open the Memory Viewer for a chat. Returns the resolved viewer state object
 * once it's mounted. For tests, pass `{ parent: HTMLElement }` to mount
 * inline instead of opening a popup.
 *
 * @param {string} chatId
 * @param {{ parent?: HTMLElement, onClose?: () => void }} [opts]
 * @returns {Promise<ViewerState>}
 */
export async function openViewer(chatId, opts = {}) {
    const ctx = resolveContext();
    const root = buildRootElement(chatId);

    /** @type {ViewerState} */
    const state = {
        chatId,
        activeTab: VIEWER_TABS[0],
        subjectFilter: '',
        root,
        tabBody: /** @type {HTMLElement} */ (root.querySelector(`.${CSS_PREFIX}-viewer-body`)),
    };

    wireTabs(state);
    wireSubjectFilter(state);
    wireClose(state, opts.onClose);

    await renderActiveTab(state);

    // Mount. Prefer Popup if available; otherwise append to provided parent or body.
    if (opts.parent) {
        opts.parent.appendChild(root);
        state.close = () => { root.remove(); opts.onClose?.(); };
    } else if (ctx.Popup && ctx.POPUP_TYPE) {
        const popup = new ctx.Popup(root, ctx.POPUP_TYPE.TEXT, '', { wide: true });
        state.close = () => { popup.complete?.(); opts.onClose?.(); };
        popup.show();
    } else {
        document.body.appendChild(root);
        state.close = () => { root.remove(); opts.onClose?.(); };
    }

    // Memorable moment: staged entrance reveal. Class drives keyframe animations
    // in style.css; honored unless prefers-reduced-motion is set.
    root.classList.add('starmem-is-revealing');
    // Cleanup so re-renders don't re-animate (post slow + small buffer)
    setTimeout(() => root.classList.remove('starmem-is-revealing'), 900);

    return state;
}

/** Build the DOM skeleton (header, filter row, tabs, body). */
function buildRootElement(chatId) {
    const root = document.createElement('div');
    root.className = `${CSS_PREFIX}-viewer`;
    root.setAttribute('data-chat-id', chatId);

    const safeChatId = chatId.replace(/[^a-z0-9-]/gi, '-');
    const panelId = `${CSS_PREFIX}-tabpanel-${safeChatId}`;
    const tabIds = VIEWER_TABS.map(t => `${CSS_PREFIX}-tab-${t}`);

    root.innerHTML = `
        <div class="${CSS_PREFIX}-viewer-header">
            <h2 class="${CSS_PREFIX}-viewer-title">Memory Viewer</h2>
            <button type="button" class="${CSS_PREFIX}-viewer-close" aria-label="Close">✕</button>
        </div>
        <div class="${CSS_PREFIX}-viewer-filter-row">
            <label for="${CSS_PREFIX}-viewer-subject">Subject:</label>
            <input type="text" id="${CSS_PREFIX}-viewer-subject" class="${CSS_PREFIX}-viewer-subject-input" placeholder="(all subjects)" />
        </div>
        <nav class="${CSS_PREFIX}-viewer-tabs" role="tablist" aria-label="Memory views">
            ${VIEWER_TABS.map((t, i) => `
                <button type="button" role="tab" id="${tabIds[i]}" aria-controls="${panelId}" tabindex="-1" class="${CSS_PREFIX}-viewer-tab" data-tab="${t}">${titleFor(t)}</button>
            `).join('')}
        </nav>
        <select class="${CSS_PREFIX}-viewer-tab-select" aria-label="Select tab">
            ${VIEWER_TABS.map(t => `
                <option value="${t}">${titleFor(t)}</option>
            `).join('')}
        </select>
        <div class="${CSS_PREFIX}-viewer-body" id="${panelId}" role="tabpanel" aria-labelledby="${tabIds[0]}" tabindex="0"></div>
    `;
    return root;
}

function titleFor(tab) {
    switch (tab) {
        case 'working': return 'Working';
        case 'episodic': return 'Episodic';
        case 'persona': return 'Persona';
        case 'graph': return 'Graph';
        case 'traces': return 'Traces';
        default: return tab;
    }
}

function wireTabs(state) {
    const buttons = state.root.querySelectorAll(`.${CSS_PREFIX}-viewer-tab`);
    for (const btn of buttons) {
        btn.addEventListener('click', async () => {
            const tab = /** @type {HTMLElement} */ (btn).dataset.tab;
            if (!tab) return;
            state.activeTab = tab;
            highlightActiveTab(state);
            await renderActiveTab(state);
        });
    }

    // Mobile: <select> mirror of the tab strip. CSS hides the strip and
    // shows the select at <640px. Both control the same active-tab state.
    const select = /** @type {HTMLSelectElement | null} */ (
        state.root.querySelector(`.${CSS_PREFIX}-viewer-tab-select`)
    );
    if (select) {
        select.addEventListener('change', async () => {
            state.activeTab = select.value;
            highlightActiveTab(state);
            await renderActiveTab(state);
        });
    }

    wireTabKeyboard(state);
    highlightActiveTab(state);
}

function wireTabKeyboard(state) {
    const buttons = [...state.root.querySelectorAll(`.${CSS_PREFIX}-viewer-tab`)];
    const tablist = state.root.querySelector(`.${CSS_PREFIX}-viewer-tabs`);
    if (!tablist) return;
    tablist.addEventListener('keydown', async (ev) => {
        const target = ev.target;
        if (!(target instanceof HTMLElement) || target.getAttribute('role') !== 'tab') return;
        const idx = buttons.indexOf(target);
        if (idx < 0) return;
        let nextIdx = -1;
        switch (ev.key) {
            case 'ArrowRight': nextIdx = (idx + 1) % buttons.length; break;
            case 'ArrowLeft':  nextIdx = (idx - 1 + buttons.length) % buttons.length; break;
            case 'Home':       nextIdx = 0; break;
            case 'End':        nextIdx = buttons.length - 1; break;
            case 'Enter':
            case ' ':          nextIdx = idx; break;
            default: return;
        }
        ev.preventDefault();
        const next = /** @type {HTMLElement} */ (buttons[nextIdx]);
        const tab = next.dataset.tab;
        if (!tab) return;
        state.activeTab = tab;
        highlightActiveTab(state);
        next.focus();
        await renderActiveTab(state);
    });
}

function highlightActiveTab(state) {
    const buttons = state.root.querySelectorAll(`.${CSS_PREFIX}-viewer-tab`);
    const panel = state.root.querySelector('[role="tabpanel"]');
    let activeId = null;
    for (const btn of buttons) {
        const tab = /** @type {HTMLElement} */ (btn).dataset.tab;
        if (tab === state.activeTab) {
            btn.classList.add(`${CSS_PREFIX}-viewer-tab-active`);
            btn.setAttribute('aria-selected', 'true');
            btn.setAttribute('tabindex', '0');
            activeId = btn.id;
        } else {
            btn.classList.remove(`${CSS_PREFIX}-viewer-tab-active`);
            btn.setAttribute('aria-selected', 'false');
            btn.setAttribute('tabindex', '-1');
        }
    }
    if (panel && activeId) panel.setAttribute('aria-labelledby', activeId);

    const select = /** @type {HTMLSelectElement | null} */ (
        state.root.querySelector(`.${CSS_PREFIX}-viewer-tab-select`)
    );
    if (select && select.value !== state.activeTab) {
        select.value = state.activeTab;
    }
}

function wireSubjectFilter(state) {
    const input = /** @type {HTMLInputElement | null} */ (state.root.querySelector(`.${CSS_PREFIX}-viewer-subject-input`));
    if (!input) return;
    /** @type {ReturnType<typeof setTimeout> | null} */
    let debounceId = null;
    input.addEventListener('input', () => {
        state.subjectFilter = input.value.trim();
        if (debounceId) clearTimeout(debounceId);
        debounceId = setTimeout(() => { renderActiveTab(state); }, 150);
    });
}

function wireClose(state, onClose) {
    const btn = state.root.querySelector(`.${CSS_PREFIX}-viewer-close`);
    if (!btn) return;
    btn.addEventListener('click', () => {
        state.close?.();
        if (typeof onClose === 'function') onClose();
    });
}

async function renderActiveTab(state) {
    state.tabBody.innerHTML = `<div class="${CSS_PREFIX}-viewer-loading">Loading…</div>`;
    try {
        const tabModule = await loadTabModule(state.activeTab);
        const snapshot = await loadState(state.chatId);
        state.tabBody.innerHTML = '';
        await tabModule.renderTab(state.tabBody, {
            chatId: state.chatId,
            subjectFilter: state.subjectFilter,
            state: snapshot,
        });
    } catch (err) {
        log.warn(`tab render failed: ${err?.message || err}`);
        state.tabBody.innerHTML = `<div class="${CSS_PREFIX}-viewer-error">Error rendering tab: ${escapeHtml(String(err?.message || err))}</div>`;
    }
}

async function loadTabModule(tab) {
    switch (tab) {
        case 'working': return await import('./tabs/working.js');
        case 'episodic': return await import('./tabs/episodic.js');
        case 'persona': return await import('./tabs/persona.js');
        case 'graph': return await import('./tabs/graph.js');
        case 'traces': return await import('./tabs/traces.js');
        default: throw new Error(`Unknown tab: ${tab}`);
    }
}

function escapeHtml(s) {
    return s.replace(/[&<>"']/g, ch => ({
        '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
    })[ch] || ch);
}
