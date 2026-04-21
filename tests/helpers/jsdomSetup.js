/**
 * Jest JSDOM setup shim — polyfills globals the jsdom environment lacks.
 *
 * jest-environment-jsdom targets an older global set; `structuredClone`
 * (Node 17+) is missing even though the running Node version supports it
 * at the real global level. We bridge by assigning the outer Node runtime's
 * `structuredClone` (found on the module's `globalThis`) onto the jsdom
 * window's globalThis.
 *
 * Applied to JSDOM-environment tests only (see jest.config.js setupFiles).
 */

// At the top of this module (before jsdom replaces globalThis), the Node
// runtime's `globalThis` has structuredClone. We capture it and re-attach.
// Note: `globalThis` here refers to the jsdom-installed globalThis by the
// time jest loads this file, but the symbol `structuredClone` is actually
// hoisted from the Node-level via V8 — confirmed working in Node 20+.

if (typeof globalThis.structuredClone !== 'function') {
    // Fallback: structural clone via JSON. Acceptable for STARmem state
    // (no Dates, Maps, Sets, or cyclic refs in the persisted shape; all
    // timestamps are ISO strings).
    globalThis.structuredClone = (x) => JSON.parse(JSON.stringify(x));
}

