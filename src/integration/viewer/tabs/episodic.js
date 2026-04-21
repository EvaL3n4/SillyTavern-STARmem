/**
 * Episodic tab — render the Episodic scope with subject filter + sort.
 *
 * @module integration/viewer/tabs/episodic
 */

import { CSS_PREFIX } from '../../constants.js';
import { recencyAt, maturityBoost } from '../../../lifecycle/index.js';

const MAX_RENDER = 500;

/**
 * @param {HTMLElement} parent
 * @param {{ chatId: string, subjectFilter: string, state: { entries?: Record<string, any> } }} ctx
 */
export async function renderTab(parent, ctx) {
    const all = Object.values(ctx?.state?.entries || {});
    const episodic = all.filter(e => e && e.scope === 'episodic');
    const filtered = applyFilter(episodic, ctx.subjectFilter || '');

    parent.innerHTML = '';
    const root = document.createElement('div');
    root.className = `${CSS_PREFIX}-viewer-episodic`;
    root.appendChild(buildHeader(filtered.length, episodic.length));
    root.appendChild(buildSortControls(root, filtered, ctx.subjectFilter));
    root.appendChild(buildList(filtered, 'importance'));
    parent.appendChild(root);
}

function applyFilter(entries, subjectFilter) {
    if (!subjectFilter) return entries;
    const q = subjectFilter.toLowerCase();
    return entries.filter(e => typeof e.subject === 'string' && e.subject.toLowerCase().includes(q));
}

function buildHeader(shown, total) {
    const el = document.createElement('div');
    el.className = `${CSS_PREFIX}-viewer-episodic-header`;
    const limitNote = shown > MAX_RENDER ? ` (showing first ${MAX_RENDER})` : '';
    el.textContent = `Episodic — ${shown}/${total} entries${limitNote}`;
    return el;
}

function buildSortControls(root, entries, _subjectFilter) {
    const wrap = document.createElement('div');
    wrap.className = `${CSS_PREFIX}-viewer-episodic-controls`;

    const label = document.createElement('label');
    label.textContent = 'Sort: ';
    label.setAttribute('for', `${CSS_PREFIX}-viewer-episodic-sort`);

    const select = document.createElement('select');
    select.id = `${CSS_PREFIX}-viewer-episodic-sort`;
    select.innerHTML = `
        <option value="importance">Importance ↓</option>
        <option value="recency">Recency ↓</option>
        <option value="added">Added ↓</option>
    `;
    select.addEventListener('change', () => {
        const oldList = root.querySelector(`.${CSS_PREFIX}-viewer-episodic-list`);
        oldList?.remove();
        root.appendChild(buildList(entries, select.value));
    });

    wrap.appendChild(label);
    wrap.appendChild(select);
    return wrap;
}

function buildList(entries, sortKey) {
    const now = new Date();
    const sorted = [...entries];
    if (sortKey === 'importance') {
        sorted.sort((a, b) => (b.lifecycle?.importance ?? 0) - (a.lifecycle?.importance ?? 0));
    } else if (sortKey === 'recency') {
        sorted.sort((a, b) => recencyAt(b.lifecycle, now) - recencyAt(a.lifecycle, now));
    } else if (sortKey === 'added') {
        sorted.sort((a, b) => (b.lifecycle?.createdAt || '').localeCompare(a.lifecycle?.createdAt || ''));
    }

    const list = document.createElement('ul');
    list.className = `${CSS_PREFIX}-viewer-episodic-list`;
    for (const e of sorted.slice(0, MAX_RENDER)) {
        list.appendChild(buildRow(e, now));
    }
    return list;
}

function buildRow(entry, now) {
    const li = document.createElement('li');
    li.className = `${CSS_PREFIX}-viewer-episodic-item`;
    li.setAttribute('data-id', entry.id);

    const header = document.createElement('div');
    header.className = `${CSS_PREFIX}-viewer-episodic-meta`;
    const subject = document.createElement('span');
    subject.className = `${CSS_PREFIX}-viewer-subject`;
    subject.textContent = entry.subject ?? '(no subject)';
    header.appendChild(subject);
    const scores = document.createElement('span');
    scores.className = `${CSS_PREFIX}-viewer-scores`;
    const imp = entry.lifecycle?.importance ?? 0;
    const rec = recencyAt(entry.lifecycle, now);
    const mat = entry.lifecycle?.maturity ?? '(?)';
    const boost = entry.lifecycle ? maturityBoost(entry.lifecycle.maturity) : 1;
    scores.textContent = `I=${imp.toFixed(0)}  R=${rec.toFixed(2)}  ${mat}·${boost.toFixed(2)}`;
    header.appendChild(scores);
    li.appendChild(header);

    const content = document.createElement('div');
    content.className = `${CSS_PREFIX}-viewer-content`;
    content.textContent = entry.content ?? '';
    li.appendChild(content);

    if (Array.isArray(entry.tags) && entry.tags.length) {
        const tags = document.createElement('div');
        tags.className = `${CSS_PREFIX}-viewer-tags`;
        for (const t of entry.tags) {
            const tag = document.createElement('span');
            tag.className = `${CSS_PREFIX}-viewer-tag`;
            tag.textContent = t;
            tags.appendChild(tag);
        }
        li.appendChild(tags);
    }
    return li;
}
