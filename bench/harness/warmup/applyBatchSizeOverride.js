/**
 * Pure helper: parse STARMEM_BATCH_SIZE and apply via setConstantOverrides.
 *
 * Why a separate module: `bench/harness/_modal-warmup-point.js` is a
 * top-level-await entry script that can't be unit-tested directly without
 * spinning up Jest's experimental ESM mode against process env mutation.
 * Extracting the parse+apply pair into a pure function lets us drive the
 * full RED-GREEN cycle in jest with zero side effects.
 *
 * Contract:
 *   - When `envVal` is undefined, empty, or otherwise non-positive-integer,
 *     do NOT call setOverridesFn — return null (no override applied).
 *     This preserves the live-pipeline spec default for the common case
 *     where the warmup runs without --batch-size.
 *   - When `envVal` is a positive integer string, call
 *     `setOverridesFn({BATCH_SIZE: <number>})` and return the parsed int.
 *   - When `envVal` is set but invalid (negative, zero, NaN, fractional),
 *     throw — silent fallback would mask a deployment misconfig.
 *
 * @param {string|undefined} envVal - process.env.STARMEM_BATCH_SIZE
 * @param {(overrides: {BATCH_SIZE: number}) => () => void} setOverridesFn
 *   - injected setConstantOverrides; injected (not imported) so the test
 *     can assert it WAS or WAS NOT called without monkey-patching the
 *     constants module.
 * @returns {number|null} The applied batch size, or null when no override.
 *
 * @module bench/harness/warmup/applyBatchSizeOverride
 * @see bench/harness/_modal-warmup-point.js
 * @see src/core/constants.js setConstantOverrides
 */
export function applyBatchSizeOverride(envVal, setOverridesFn) {
    if (envVal === undefined || envVal === null || envVal === '') {
        return null;
    }

    // Strict integer parse — reject '15.5', '15e0', '15foo', whitespace,
    // anything that doesn't round-trip cleanly. parseInt is too permissive
    // (parseInt('15foo', 10) === 15), and Number() returns NaN for floats
    // we don't want either.
    const trimmed = String(envVal).trim();
    if (!/^[1-9]\d*$/.test(trimmed)) {
        throw new Error(
            `STARMEM_BATCH_SIZE must be a positive integer (got '${envVal}')`,
        );
    }

    const n = Number(trimmed);
    setOverridesFn({ BATCH_SIZE: n });
    return n;
}
