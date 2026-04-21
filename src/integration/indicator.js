/**
 * Consolidation indicator — a subtle dot that pulses while consolidation is
 * running. Mounted once on APP_READY; polls state.runtime.consolidating via
 * loadState() on a 1-second interval.
 *
 * Invisible when consolidating=false; visible + animated when consolidating=true.
 *
 * Decision 14.B: mount inside `#send_but_container` (ST's stable send-button
 * wrapper). Fall back to document.body with fixed positioning if that anchor
 * isn't present at mount time.
 *
 * @module integration/indicator
 * @see docs/specs/2026-04-20-starmem-v2-design.md §8
 */

import { loadState } from '../core/state.js';
import { CSS_PREFIX } from './constants.js';
import { createLogger } from '../core/logger.js';

const log = createLogger({ debug: false }).scope('integration:indicator');

const INDICATOR_ID = `${CSS_PREFIX}-indicator`;
const POLL_INTERVAL_MS = 1000;

/** @type {ReturnType<typeof setInterval> | null} */
let intervalId = null;
/** @type {HTMLElement | null} */
let el = null;
/** @type {(() => string | null) | null} */
let chatIdResolver = null;

/**
 * Mount the indicator. Idempotent — removes prior mount before creating a new one.
 *
 * @param {() => string | null} getChatId - called each tick to resolve current chat
 */
export function mountIndicator(getChatId) {
    unmountIndicator();
    chatIdResolver = getChatId;

    const dot = document.createElement('div');
    dot.id = INDICATOR_ID;
    dot.className = `${CSS_PREFIX}-indicator`;
    dot.setAttribute('role', 'status');
    dot.setAttribute('aria-label', 'STARmem consolidation');
    dot.title = 'STARmem: idle';
    dot.classList.add(`${CSS_PREFIX}-indicator-idle`);

    // Decision 14.B: prefer ST's send-button container as anchor.
    // style.css sets `#send_but_container { position: relative }` so our
    // absolute-positioned dot anchors there. Fall back to document.body
    // with fixed positioning if the container isn't mounted yet (defensive).
    const anchor = document.getElementById('send_but_container');
    if (anchor) {
        anchor.appendChild(dot);
    } else {
        log.debug('#send_but_container not found; falling back to document.body');
        dot.classList.add(`${CSS_PREFIX}-indicator-floating`);
        document.body.appendChild(dot);
    }
    el = dot;

    intervalId = setInterval(tick, POLL_INTERVAL_MS);
    log.debug(`mounted @ #${INDICATOR_ID}, polling every ${POLL_INTERVAL_MS}ms`);
}

/** Unmount + remove any DOM. Idempotent. */
export function unmountIndicator() {
    if (intervalId !== null) {
        clearInterval(intervalId);
        intervalId = null;
    }
    // Remove by id defensively — module instance may have been re-loaded in
    // dev mode and lost its `el` reference.
    const existing = document.getElementById(INDICATOR_ID);
    if (existing) existing.remove();
    el = null;
    chatIdResolver = null;
}

/** Test-only: step one poll deterministically without waiting for the interval. */
export async function _tickForTests() { await tick(); }

async function tick() {
    if (!el || !chatIdResolver) return;
    try {
        const chatId = chatIdResolver();
        if (!chatId) {
            setIdle();
            return;
        }
        const state = await loadState(chatId);
        const isConsolidating = Boolean(state?.runtime?.consolidating);
        if (isConsolidating) setBusy(state?.runtime);
        else setIdle();
    } catch (err) {
        // Swallow — indicator must never break the UI.
        setIdle();
        log.debug(`tick error: ${err?.message || err}`);
    }
}

function setIdle() {
    if (!el) return;
    el.classList.remove(`${CSS_PREFIX}-indicator-busy`);
    el.classList.add(`${CSS_PREFIX}-indicator-idle`);
    el.title = 'STARmem: idle';
}

/**
 * @param {{ consolidating?: boolean, lastConsolidation?: string | null } | undefined} runtime
 */
function setBusy(runtime) {
    if (!el) return;
    el.classList.remove(`${CSS_PREFIX}-indicator-idle`);
    el.classList.add(`${CSS_PREFIX}-indicator-busy`);
    const last = runtime?.lastConsolidation;
    if (typeof last === 'string' && last.length > 0) {
        el.title = `STARmem: consolidating (last run: ${last})`;
    } else {
        el.title = 'STARmem: consolidating';
    }
}
