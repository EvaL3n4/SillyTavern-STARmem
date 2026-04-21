/**
 * Traces tab — render runtime.traces ring buffer + JSONL export + clear.
 *
 * @module integration/viewer/tabs/traces
 */

import { CSS_PREFIX } from '../../constants.js';
import { clearTraces } from '../../../consolidation/index.js';

/**
 * @param {HTMLElement} parent
 * @param {{ chatId: string, state: { runtime?: { traces?: any[] } } }} ctx
 */
export async function renderTab(parent, ctx) {
    const traces = Array.isArray(ctx?.state?.runtime?.traces) ? ctx.state.runtime.traces : [];

    parent.innerHTML = '';
    const root = document.createElement('div');
    root.className = `${CSS_PREFIX}-viewer-traces`;

    const header = document.createElement('div');
    header.className = `${CSS_PREFIX}-viewer-traces-header`;
    header.textContent = `Traces — ${traces.length} entries`;
    root.appendChild(header);

    const controls = document.createElement('div');
    controls.className = `${CSS_PREFIX}-viewer-traces-controls`;
    controls.appendChild(buildExportButton(traces));
    controls.appendChild(buildClearButton(ctx.chatId, parent, ctx));
    root.appendChild(controls);

    if (traces.length === 0) {
        const empty = document.createElement('p');
        empty.className = `${CSS_PREFIX}-viewer-empty`;
        empty.textContent = 'No retrieval traces recorded yet.';
        root.appendChild(empty);
        parent.appendChild(root);
        return;
    }

    const list = document.createElement('ol');
    list.className = `${CSS_PREFIX}-viewer-traces-list`;
    // Latest first.
    for (let i = traces.length - 1; i >= 0; i--) {
        list.appendChild(buildTraceItem(traces[i]));
    }
    root.appendChild(list);
    parent.appendChild(root);
}

function buildExportButton(traces) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = `menu_button ${CSS_PREFIX}-viewer-traces-export`;
    btn.textContent = 'Download JSONL';
    btn.disabled = traces.length === 0;
    btn.addEventListener('click', () => {
        const jsonl = traces.map(t => JSON.stringify(t)).join('\n') + '\n';
        const blob = new Blob([jsonl], { type: 'application/x-ndjson' });
        const url = URL.createObjectURL(blob);
        const isoNow = new Date().toISOString().replace(/:/g, '-').replace(/\..+Z$/, '');
        const a = document.createElement('a');
        a.href = url;
        a.download = `starmem-traces-${isoNow}.jsonl`;
        a.style.display = 'none';
        document.body.appendChild(a);
        a.click();
        setTimeout(() => { URL.revokeObjectURL(url); a.remove(); }, 0);
    });
    return btn;
}

function buildClearButton(chatId, parent, ctx) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = `menu_button ${CSS_PREFIX}-viewer-traces-clear`;
    btn.textContent = 'Clear';
    btn.addEventListener('click', async () => {
        if (!confirm('Clear all retrieval traces?')) return;
        try {
            await clearTraces(chatId);
            // Re-render by re-invoking with an empty state projection.
            const fresh = { ...ctx, state: { ...ctx.state, runtime: { ...(ctx.state?.runtime || {}), traces: [] } } };
            await renderTab(parent, fresh);
        } catch (err) {
            alert(`Failed to clear traces: ${err?.message || err}`);
        }
    });
    return btn;
}

function buildTraceItem(trace) {
    const li = document.createElement('li');
    li.className = `${CSS_PREFIX}-viewer-traces-item`;

    const summary = document.createElement('div');
    summary.className = `${CSS_PREFIX}-viewer-traces-summary`;
    const ts = trace.timestamp ? formatTimestamp(trace.timestamp) : '(no ts)';
    const cls = trace.classifier ?? '?';
    const tier = trace.tierResolved ?? '?';
    const top = getTopScore(trace);
    const query = truncate(trace.query ?? '', 60);
    summary.textContent = `${ts} • T${tier}/${cls} • top=${top !== null ? top.toFixed(2) : 'n/a'} • "${query}"`;
    li.appendChild(summary);

    const details = document.createElement('details');
    details.className = `${CSS_PREFIX}-viewer-traces-details`;
    const sumEl = document.createElement('summary');
    sumEl.textContent = 'raw';
    details.appendChild(sumEl);
    const pre = document.createElement('pre');
    pre.className = `${CSS_PREFIX}-viewer-traces-raw`;
    pre.textContent = JSON.stringify(trace, null, 2);
    details.appendChild(pre);
    li.appendChild(details);

    return li;
}

function getTopScore(trace) {
    const tier = trace.tierResolved;
    if (tier == null) return null;
    const per = trace.perTier?.[String(tier)];
    if (!Array.isArray(per) || per.length === 0) return null;
    const top = per[0];
    return typeof top?.score === 'number' ? top.score : null;
}

function formatTimestamp(iso) {
    try {
        return new Date(iso).toISOString().replace('T', ' ').replace(/\..+Z$/, 'Z');
    } catch { return iso; }
}

function truncate(s, n) {
    if (typeof s !== 'string') return '';
    return s.length > n ? s.slice(0, n) + '…' : s;
}
