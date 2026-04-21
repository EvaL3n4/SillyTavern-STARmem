/**
 * Working tab — render the working buffer (entries awaiting consolidation).
 *
 * Per Phase 8 Decision B (revised from plan draft): the working buffer is a
 * string[] of entry IDs pointing into state.entries. Each buffered entry is
 * a `scope: 'working'` Entry carrying the assistant's reply text. This tab
 * resolves the ids → entries and renders them newest-first.
 *
 * @module integration/viewer/tabs/working
 * @see docs/specs/2026-04-20-starmem-v2-design.md §8
 */

import { CSS_PREFIX } from '../../constants.js';

const MAX_INLINE_LEN = 200;

/**
 * @typedef {import('../../../core/schema.js').Entry} Entry
 */

/**
 * @param {HTMLElement} parent
 * @param {{
 *   state: import('../../../core/schema.js').State,
 *   chatId: string,
 *   subjectFilter: string,
 * }} ctx
 */
export async function renderTab(parent, ctx) {
    const state = ctx?.state;
    const bufferIds = Array.isArray(state?.workingBuffer) ? state.workingBuffer : [];
    const entries = state?.entries || {};

    // Resolve ids to entries; stale ids (missing in entries) are skipped.
    /** @type {Entry[]} */
    const resolved = [];
    for (const id of bufferIds) {
        const e = entries[id];
        if (e) resolved.push(e);
    }

    parent.innerHTML = '';
    const container = document.createElement('div');
    container.className = `${CSS_PREFIX}-viewer-working`;

    const header = document.createElement('div');
    header.className = `${CSS_PREFIX}-viewer-working-header`;
    header.textContent = `Working buffer — ${resolved.length} entr${resolved.length === 1 ? 'y' : 'ies'}`;
    container.appendChild(header);

    if (resolved.length === 0) {
        const empty = document.createElement('p');
        empty.className = `${CSS_PREFIX}-viewer-empty`;
        empty.textContent = 'Buffer is empty. Entries accumulate here between consolidations.';
        container.appendChild(empty);
        parent.appendChild(container);
        return;
    }

    const list = document.createElement('ol');
    list.className = `${CSS_PREFIX}-viewer-working-list`;
    // Newest first — iterate buffer back-to-front.
    for (let i = resolved.length - 1; i >= 0; i--) {
        list.appendChild(renderEntry(resolved[i], i));
    }
    container.appendChild(list);
    parent.appendChild(container);
}

/**
 * @param {Entry} entry
 * @param {number} idx
 */
function renderEntry(entry, idx) {
    const item = document.createElement('li');
    item.className = `${CSS_PREFIX}-viewer-working-item`;
    item.setAttribute('data-index', String(idx));

    const meta = document.createElement('div');
    meta.className = `${CSS_PREFIX}-viewer-working-meta`;
    const ts = entry.lifecycle?.createdAt ? formatTimestamp(entry.lifecycle.createdAt) : '(no timestamp)';
    const sourceIds = Array.isArray(entry.provenance?.sourceMessages) && entry.provenance.sourceMessages.length
        ? `msg ${entry.provenance.sourceMessages.join(',')}`
        : '';
    meta.textContent = `${ts}  •  ${sourceIds}`;
    item.appendChild(meta);

    const content = document.createElement('div');
    content.className = `${CSS_PREFIX}-viewer-working-content`;
    appendTruncated(content, entry.content);
    item.appendChild(content);

    return item;
}

function appendTruncated(el, text) {
    const body = document.createElement('span');
    if (typeof text === 'string' && text.length > MAX_INLINE_LEN) {
        body.textContent = text.slice(0, MAX_INLINE_LEN) + '…';
        const expand = document.createElement('button');
        expand.type = 'button';
        expand.className = `${CSS_PREFIX}-viewer-expand`;
        expand.textContent = '(more)';
        expand.addEventListener('click', () => {
            body.textContent = text;
            expand.remove();
        });
        el.appendChild(body);
        el.appendChild(expand);
    } else {
        body.textContent = typeof text === 'string' ? text : '';
        el.appendChild(body);
    }
}

function formatTimestamp(iso) {
    try {
        const d = new Date(iso);
        return d.toISOString().replace('T', ' ').replace(/\..+Z$/, 'Z');
    } catch { return iso; }
}
