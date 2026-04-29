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

/**
 * Format a tier value for the tab UI.
 * Post-Phase-14 ladder: Tier 2 is demolished as a resolver. Legacy traces with
 * `tierResolved: 2` (pre-Phase-14) backfill to T3 — the seed-into-Tier-3 path
 * is what historical Tier 2 hits actually exercised.
 *
 * Bench-only control conditions (bm25only, recency, random) map to short
 * labels rather than '?' so the viewer is honest when bench traces appear.
 *
 * @param {0 | 1 | 2 | 3 | 'floor' | 'bm25only' | 'recency' | 'random' | null | undefined} tier
 * @returns {'T0' | 'T1' | 'T3' | 'Floor' | 'BM25' | 'Recent' | 'Rand' | '?'}
 */
export function formatTierLabel(tier) {
    if (tier === 0) return 'T0';
    if (tier === 1) return 'T1';
    if (tier === 2 || tier === 3) return 'T3';
    if (tier === 'floor') return 'Floor';
    if (tier === 'bm25only') return 'BM25';
    if (tier === 'recency') return 'Recent';
    if (tier === 'random') return 'Rand';
    return '?';
}

function buildTraceItem(trace) {
    const li = document.createElement('li');
    li.className = `${CSS_PREFIX}-viewer-traces-item`;

    const summary = document.createElement('div');
    summary.className = `${CSS_PREFIX}-viewer-traces-summary`;

    if (trace.kind === 'consolidate') {
        const ts = trace.timestamp ? formatTimestamp(trace.timestamp) : '(no ts)';
        const factCount = trace.summary?.factCount ?? '?';
        const dur = typeof trace.durationMs === 'number' ? `${trace.durationMs}ms` : '?';
        const ext = trace.extractor ?? '?';
        const errMark = trace.summary?.error ? ' · failed' : '';
        const badge = document.createElement('span');
        badge.className = `${CSS_PREFIX}-tier-badge ${CSS_PREFIX}-tier-badge-event`;
        badge.textContent = 'consolidate';
        summary.appendChild(badge);
        const text = document.createTextNode(`${ts} · ${factCount} facts · ${dur} · ${ext}${errMark}`);
        summary.appendChild(text);
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

    // Retrieve path (T0/T1/T3/Floor + bench-only labels)
    const ts = trace.timestamp ? formatTimestamp(trace.timestamp) : '(no ts)';
    const cls = trace.classifier ?? '?';
    const tier = trace.tierResolved;
    const top = getTopScore(trace);
    const query = truncate(trace.query ?? '', 60);
    const badge = document.createElement('span');
    badge.className = `${CSS_PREFIX}-tier-badge`;
    badge.textContent = formatTierLabel(tier);
    summary.appendChild(badge);
    const topStr = top !== null ? top.toFixed(2) : 'n/a';
    const text = document.createTextNode(`${ts} · ${cls} · top=${topStr} · "${query}"`);
    summary.appendChild(text);
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
