/**
 * Per-task-type metrics table renderer. Consumed by both JS baseline
 * scripts and the live-extraction baseline synthesizer in Task 6.
 *
 * @module bench/render/by-task-type
 */

/**
 * @param {Record<string, { mrr: number, coverage: number, n_scored: number, n_skipped?: number }>} byTaskType
 * @param {object} [opts]
 * @param {string} [opts.headline] Optional headline line prepended above the table
 * @returns {string} Markdown table string ready for concatenation into a report
 */
export function renderByTaskType(byTaskType, opts = {}) {
    if (!byTaskType || Object.keys(byTaskType).length === 0) {
        return '_No per-task-type slice available (corpus did not provide taskType)._\n';
    }

    const lines = [];
    if (opts.headline) {
        lines.push(opts.headline);
        lines.push('');
    }
    lines.push('| Task type                    | MRR      | Coverage | n scored | n skipped |');
    lines.push('|------------------------------|----------|----------|----------|-----------|');

    // Stable ordering: known LongMemEval types first, then any unknown
    const KNOWN_ORDER = [
        'single-session-user',
        'single-session-assistant',
        'single-session-preference',
        'temporal-reasoning',
        'knowledge-update',
        'multi-session',
    ];
    const ordered = [
        ...KNOWN_ORDER.filter(k => k in byTaskType),
        ...Object.keys(byTaskType).filter(k => !KNOWN_ORDER.includes(k)).sort(),
    ];

    for (const tt of ordered) {
        const m = byTaskType[tt];
        const mrrStr = m.mrr.toFixed(4);
        const covStr = m.coverage.toFixed(4);
        const skipped = m.n_skipped !== undefined ? String(m.n_skipped) : '—';
        lines.push(`| ${tt.padEnd(28)} | ${mrrStr.padStart(8)} | ${covStr.padStart(8)} | ${String(m.n_scored).padStart(8)} | ${skipped.padStart(9)} |`);
    }

    return lines.join('\n') + '\n';
}
