/**
 * Graph tab — textual adjacency listing ranked by degree.
 *
 * @module integration/viewer/tabs/graph
 */

import { CSS_PREFIX } from '../../constants.js';
import { buildAdjacency, neighborsOf } from '../../../memory/index.js';

const MAX_ENTRIES = 200;
const MAX_NEIGHBORS_PER_ENTRY = 10;

/**
 * @param {HTMLElement} parent
 * @param {{ subjectFilter: string, state: { entries?: Record<string, any>, graph?: { edges?: any[] } } }} ctx
 */
export async function renderTab(parent, ctx) {
    const entries = ctx?.state?.entries || {};
    const edges = Array.isArray(ctx?.state?.graph?.edges) ? ctx.state.graph.edges : [];
    const filtered = filterEntries(entries, ctx.subjectFilter || '');
    const adj = buildAdjacency(/** @type {any} */ (ctx.state));
    const ranked = rankByDegree(filtered, adj);

    parent.innerHTML = '';
    const root = document.createElement('div');
    root.className = `${CSS_PREFIX}-viewer-graph`;

    const header = document.createElement('div');
    header.className = `${CSS_PREFIX}-viewer-graph-header`;
    header.textContent = `Graph — ${Object.keys(filtered).length} nodes, ${edges.length} edges`;
    root.appendChild(header);

    if (ranked.length === 0) {
        const empty = document.createElement('p');
        empty.className = `${CSS_PREFIX}-viewer-empty`;
        empty.textContent = 'No nodes to display.';
        root.appendChild(empty);
        parent.appendChild(root);
        return;
    }

    const list = document.createElement('ul');
    list.className = `${CSS_PREFIX}-viewer-graph-list`;
    for (const entry of ranked.slice(0, MAX_ENTRIES)) {
        list.appendChild(buildNodeRow(entry, adj, entries));
    }
    root.appendChild(list);

    if (ranked.length > MAX_ENTRIES) {
        const more = document.createElement('p');
        more.className = `${CSS_PREFIX}-viewer-note`;
        more.textContent = `(${ranked.length - MAX_ENTRIES} more nodes hidden — use subject filter to narrow)`;
        root.appendChild(more);
    }

    parent.appendChild(root);
}

function filterEntries(entries, filter) {
    if (!filter) return { ...entries };
    const q = filter.toLowerCase();
    const out = {};
    for (const [id, e] of Object.entries(entries)) {
        if (typeof e?.subject === 'string' && e.subject.toLowerCase().includes(q)) out[id] = e;
    }
    return out;
}

function rankByDegree(entries, adj) {
    const list = Object.values(entries);
    list.sort((a, b) => {
        const da = neighborsOf(adj, a.id).length;
        const db = neighborsOf(adj, b.id).length;
        return db - da;
    });
    return list;
}

function buildNodeRow(entry, adj, entriesById) {
    const li = document.createElement('li');
    li.className = `${CSS_PREFIX}-viewer-graph-item`;
    li.setAttribute('data-id', entry.id);

    const header = document.createElement('div');
    header.className = `${CSS_PREFIX}-viewer-graph-node-header`;
    const subject = document.createElement('span');
    subject.className = `${CSS_PREFIX}-viewer-subject`;
    subject.textContent = entry.subject ?? '(no subject)';
    header.appendChild(subject);
    const preview = document.createElement('span');
    preview.className = `${CSS_PREFIX}-viewer-graph-node-preview`;
    preview.textContent = truncate(entry.content ?? '', 80);
    header.appendChild(preview);
    li.appendChild(header);

    const neighbors = neighborsOf(adj, entry.id);
    const neighborList = document.createElement('ul');
    neighborList.className = `${CSS_PREFIX}-viewer-graph-neighbors`;
    for (const n of neighbors.slice(0, MAX_NEIGHBORS_PER_ENTRY)) {
        const ni = document.createElement('li');
        ni.className = `${CSS_PREFIX}-viewer-graph-neighbor`;
        const target = entriesById[n.to];
        const targetSubject = target?.subject ?? '?';
        const targetPreview = truncate(target?.content ?? '', 40);
        ni.textContent = `[${n.type}] (w=${n.weight.toFixed(2)}) → ${targetSubject}: ${targetPreview}`;
        neighborList.appendChild(ni);
    }
    if (neighbors.length > MAX_NEIGHBORS_PER_ENTRY) {
        const more = document.createElement('li');
        more.className = `${CSS_PREFIX}-viewer-graph-neighbor-more`;
        more.textContent = `+${neighbors.length - MAX_NEIGHBORS_PER_ENTRY} more neighbors`;
        neighborList.appendChild(more);
    }
    li.appendChild(neighborList);

    return li;
}

function truncate(s, n) {
    if (typeof s !== 'string') return '';
    return s.length > n ? s.slice(0, n) + '…' : s;
}
