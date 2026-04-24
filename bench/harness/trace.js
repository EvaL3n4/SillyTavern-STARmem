/**
 * Weave observability adapter for the bench harness.
 *
 * Provides opt-in retrieval-call tracing via W&B Weave. Imports from
 * `weave` (a devDependency — legal bench-side, forbidden runtime-side by
 * AGENTS.md) and exposes two entry points:
 *
 * - initWeave(project): call once at the top of any bench entry point
 *   that wants traces. Safe to call without WANDB credentials: on auth
 *   failure, falls through to a no-op state so the benchmark still runs.
 *
 * - traceRetrieve(fn, meta): wrap a retriever fn so every call becomes
 *   a replayable Weave op. When Weave isn't initialized, returns the
 *   original fn unchanged (zero overhead, zero dependency surface).
 *
 * Why this module lives in bench/harness/ and not bench/runner.js:
 * runner.js is imported transitively by Jest unit tests, and weave's
 * import chain pulls in network / filesystem code that makes unit-test
 * startup brittle. Keeping the import here means tests that don't go
 * through a Modal entry point don't load weave at all.
 *
 * @module bench/harness/trace
 * @see docs/specs/2026-04-20-starmem-v2-design.md §2 "honest instrumentation"
 */

let weaveModule = null;
let weaveReady = false;

/**
 * Initialize Weave for the current process.
 *
 * Attempts to import and init weave. On any failure (missing .netrc,
 * offline, weave not installed, etc.) logs a warning to stderr and
 * leaves the module in no-op state. The bench run completes regardless.
 *
 * Safe to call multiple times — subsequent calls are no-ops when
 * already initialized. Idempotent failure state: once a call fails,
 * later retries will not attempt re-init.
 *
 * @param {string} project — Weave project name (e.g. 'STARmem').
 * @returns {Promise<boolean>} true when Weave is live and traces will
 *   be recorded; false when running in no-op mode.
 */
export async function initWeave(project) {
    if (weaveReady) return true;
    if (weaveModule === false) return false; // prior failure — don't retry

    // Explicit opt-out. Useful for CI, local debug runs, or any context
    // where network access to wandb.ai is undesirable.
    if (process.env.WANDB_DISABLED === '1' || process.env.WEAVE_DISABLED === '1') {
        weaveModule = false;
        return false;
    }

    try {
        const mod = await import('weave');
        await mod.init(project);
        weaveModule = mod;
        weaveReady = true;
        return true;
    } catch (err) {
        // stderr to keep stdout reserved for the Modal JSON payload.
        console.error(`[weave] init failed, continuing without tracing: ${err?.message ?? err}`);
        weaveModule = false;
        return false;
    }
}

/**
 * Wrap a retriever function in a Weave op.
 *
 * The returned wrapper forwards all arguments to the underlying fn.
 * When Weave is initialized, each call produces a trace with the
 * resolved op name and captured inputs/outputs. When not initialized,
 * returns fn unchanged — zero overhead, zero behavioral difference.
 *
 * Op name precedence: meta.name > fn.name > 'retrieve'.
 *
 * @template {(...args: any[]) => any} T
 * @param {T} fn — retriever function to wrap.
 * @param {object} [meta]
 * @param {string} [meta.name] — op name override for W&B display.
 * @returns {T} — wrapped function (or fn itself in no-op mode).
 */
export function traceRetrieve(fn, meta = {}) {
    if (!weaveReady || !weaveModule) return fn;
    const name = meta.name ?? fn.name ?? 'retrieve';
    return weaveModule.op(fn, { name });
}
