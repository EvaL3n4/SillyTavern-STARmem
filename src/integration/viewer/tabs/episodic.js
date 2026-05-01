/**
 * Episodic tab — render the Episodic scope with subject filter + sort.
 *
 * Sort modes:
 *   - importance | recency | added → flat list, sorted globally
 *   - subject                      → grouped layout: subjects A→Z, entries
 *                                    within each group sorted by importance ↓
 *
 * The grouped layout matches the "Quiet Library" identity (literary archive
 * with per-subject hanging-indent sections); flat layouts keep the current
 * data-density-first presentation.
 *
 * @module integration/viewer/tabs/episodic
 */

import { CSS_PREFIX } from '../../constants.js';
import { recencyAt, maturityBoost } from '../../../lifecycle/index.js';
import { isMaturity } from '../../../core/schema.js';

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
    root.appendChild(buildBody(filtered, 'importance'));
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
    el.textContent = `Episodic—${shown}/${total} entries${limitNote}`;
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
        <option value="subject">Subject (grouped)</option>
    `;
    select.addEventListener('change', () => {
        const oldBody = root.querySelector(
            `.${CSS_PREFIX}-viewer-episodic-list, .${CSS_PREFIX}-viewer-episodic-groups`,
        );
        oldBody?.remove();
        root.appendChild(buildBody(entries, select.value));
    });

    wrap.appendChild(label);
    wrap.appendChild(select);
    return wrap;
}

/**
 * Body builder — dispatches to flat list or grouped layout based on sortKey.
 */
function buildBody(entries, sortKey) {
    if (sortKey === 'subject') return buildGroupedBody(entries);
    return buildFlatBody(entries, sortKey);
}

function buildFlatBody(entries, sortKey) {
    const now = new Date();
    const sorted = sortFlat(entries, sortKey, now);

    const list = document.createElement('ul');
    list.className = `${CSS_PREFIX}-viewer-episodic-list`;
    for (const e of sorted.slice(0, MAX_RENDER)) {
        list.appendChild(buildRow(e, now));
    }
    return list;
}

function sortFlat(entries, sortKey, now) {
    const sorted = [...entries];
    if (sortKey === 'importance') {
        sorted.sort((a, b) => (b.lifecycle?.importance ?? 0) - (a.lifecycle?.importance ?? 0));
    } else if (sortKey === 'recency') {
        sorted.sort((a, b) => recencyAt(now, b.lifecycle?.createdAt) - recencyAt(now, a.lifecycle?.createdAt));
    } else if (sortKey === 'added') {
        sorted.sort((a, b) => (b.lifecycle?.createdAt || '').localeCompare(a.lifecycle?.createdAt || ''));
    }
    return sorted;
}

/**
 * Subject-grouped body: groups alphabetically (A→Z), within-group sort is
 * importance ↓. Per-group entry count surfaced in the heading. Flattened
 * MAX_RENDER cap applies to the whole layout (groups consume the budget
 * in alphabetical order; trailing groups may be trimmed if cap is exhausted).
 */
function buildGroupedBody(entries) {
    const now = new Date();
    const groups = groupBySubject(entries);

    const wrap = document.createElement('div');
    wrap.className = `${CSS_PREFIX}-viewer-episodic-groups`;

    let rendered = 0;
    for (const [subject, subjectEntries] of groups) {
        if (rendered >= MAX_RENDER) break;

        // Within-group sort: importance ↓ (decision 2a).
        const sorted = [...subjectEntries].sort(
            (a, b) => (b.lifecycle?.importance ?? 0) - (a.lifecycle?.importance ?? 0),
        );

        const group = document.createElement('section');
        group.className = `${CSS_PREFIX}-viewer-episodic-group`;
        group.setAttribute('data-subject', subject);

        const heading = document.createElement('h3');
        heading.className = `${CSS_PREFIX}-viewer-episodic-group-heading`;
        const subjectLabel = document.createElement('span');
        subjectLabel.className = `${CSS_PREFIX}-viewer-episodic-group-subject`;
        subjectLabel.textContent = subject;
        const count = document.createElement('span');
        count.className = `${CSS_PREFIX}-viewer-episodic-group-count`;
        count.textContent = `${subjectEntries.length}`;
        heading.appendChild(subjectLabel);
        heading.appendChild(count);
        group.appendChild(heading);

        const list = document.createElement('ul');
        list.className = `${CSS_PREFIX}-viewer-episodic-group-list`;
        const remaining = MAX_RENDER - rendered;
        for (const e of sorted.slice(0, remaining)) {
            list.appendChild(buildRow(e, now, /* inGroup */ true));
            rendered += 1;
        }
        group.appendChild(list);
        wrap.appendChild(group);
    }
    return wrap;
}

/**
 * Group entries by subject alphabetically (decision 1a). Empty/missing
 * subjects bucket under '(no subject)' which sorts last via leading paren.
 *
 * @returns {Map<string, any[]>} insertion order = alphabetical
 */
function groupBySubject(entries) {
    const groups = new Map();
    for (const e of entries) {
        const subj = (typeof e.subject === 'string' && e.subject) ? e.subject : '(no subject)';
        if (!groups.has(subj)) groups.set(subj, []);
        groups.get(subj).push(e);
    }
    // Re-emit in alphabetical order. '(no subject)' sorts before letters
    // by ASCII order; localeCompare keeps locale-friendly subject sorting
    // for the rest. Re-insert into a fresh Map to lock insertion order.
    const sortedKeys = [...groups.keys()].sort((a, b) => a.localeCompare(b));
    const out = new Map();
    for (const k of sortedKeys) out.set(k, groups.get(k));
    return out;
}

/**
 * Single-entry row. Renders the same shape in both flat and grouped layouts;
 * grouped layout omits the subject in the meta line (it's the heading).
 *
 * @param {any} entry
 * @param {Date} now
 * @param {boolean} [inGroup]  true when rendering inside a subject group
 */
function buildRow(entry, now, inGroup = false) {
    const li = document.createElement('li');
    li.className = `${CSS_PREFIX}-viewer-episodic-item`;
    li.setAttribute('data-id', entry.id);

    const header = document.createElement('div');
    header.className = `${CSS_PREFIX}-viewer-episodic-meta`;

    if (!inGroup) {
        const subject = document.createElement('span');
        subject.className = `${CSS_PREFIX}-viewer-subject`;
        subject.textContent = entry.subject ?? '(no subject)';
        header.appendChild(subject);
    }

    const scores = document.createElement('span');
    scores.className = `${CSS_PREFIX}-viewer-scores`;
    const imp = entry.lifecycle?.importance ?? 0;
    const rec = recencyAt(now, entry.lifecycle?.createdAt);
    // Display-layer tolerance: legacy/corrupt entries may carry a maturity
    // tier outside the v2 enum (draft|validated|core). The lifecycle module
    // is allowed to throw on those — we render them with a neutral boost so
    // a single corrupt entry doesn't crash the tab. Render the raw string
    // verbatim so the operator can see what's wrong.
    const matRaw = entry.lifecycle?.maturity;
    const matValid = isMaturity(matRaw);
    const mat = matRaw ?? '(?)';
    const boost = matValid ? maturityBoost(matRaw) : 1;
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
