/**
 * Amendment rule for sweep-to-baseline comparisons.
 *
 * A candidate amendment lands ONLY when it beats the baseline on MRR by
 * at least minMrrDelta AND does not drop coverage by more than
 * maxCoverageDrop. Catches subset-selection bias (9.4.9/9.5 graph-knob
 * pattern: MRR climbs because coverage falls, not because retrieval
 * improved).
 *
 * @module bench/render/amendment-rule
 * @see docs/plans/phase-11-infrastructure-hardening.md Task 4
 * @see docs/plans/phase-9-4-9-retro.md (subset-selection bias origin)
 */

/**
 * @typedef {object} MetricSample
 * @property {number} mrr
 * @property {number} coverage
 */

/**
 * @param {object} args
 * @param {MetricSample} args.baseline
 * @param {MetricSample} args.candidate
 * @param {number} [args.minMrrDelta] - Default 0.02.
 * @param {number} [args.maxCoverageDrop] - Default 0.05 (5pp).
 * @returns {{amend: boolean, reason: string, mrrDelta: number, coverageDelta: number}}
 */
export function shouldAmend({ baseline, candidate, minMrrDelta = 0.02, maxCoverageDrop = 0.05 }) {
    const mrrDelta = candidate.mrr - baseline.mrr;
    const coverageDelta = candidate.coverage - baseline.coverage;

    if (Number.isNaN(mrrDelta) || Number.isNaN(coverageDelta)) {
        return {
            amend: false,
            reason: `Cannot amend: NaN in baseline or candidate (mrr=${baseline.mrr}/${candidate.mrr}, coverage=${baseline.coverage}/${candidate.coverage}).`,
            mrrDelta,
            coverageDelta,
        };
    }

    if (mrrDelta < minMrrDelta) {
        return {
            amend: false,
            reason: `ΔMRR = ${mrrDelta.toFixed(4)} < ${minMrrDelta} (below amendment threshold).`,
            mrrDelta,
            coverageDelta,
        };
    }

    if (coverageDelta < -maxCoverageDrop) {
        return {
            amend: false,
            reason: `ΔMRR = ${mrrDelta.toFixed(4)} ≥ ${minMrrDelta}, but coverage drops ${(-coverageDelta * 100).toFixed(1)}pp > ${maxCoverageDrop * 100}pp allowed (subset-selection bias suspected).`,
            mrrDelta,
            coverageDelta,
        };
    }

    return {
        amend: true,
        reason: `ΔMRR = ${mrrDelta.toFixed(4)} ≥ ${minMrrDelta} and Δcoverage = ${(coverageDelta * 100).toFixed(1)}pp ≥ −${maxCoverageDrop * 100}pp.`,
        mrrDelta,
        coverageDelta,
    };
}
