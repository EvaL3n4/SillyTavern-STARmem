/**
 * Persona tab — grouped Persona entries per subject + Rebuild button.
 *
 * @module integration/viewer/tabs/persona
 * @see docs/specs/2026-04-20-starmem-v2-design.md §8
 */

import { CSS_PREFIX } from '../../constants.js';
import { getSettings } from '../../settings.js';
import { rebuildPersona } from '../../../consolidation/index.js';
import { createLogger } from '../../../core/logger.js';

const log = createLogger({ debug: false }).scope('integration:viewer:persona');

/** @type {AbortController | null} */
let activeRebuild = null;

/**
 * @param {HTMLElement} parent
 * @param {{ chatId: string, subjectFilter: string, state: { entries?: Record<string, any> } }} ctx
 */
export async function renderTab(parent, ctx) {
    const all = Object.values(ctx?.state?.entries || {});
    const persona = all.filter(e => e && e.scope === 'persona');
    const groups = groupBySubject(persona, ctx.subjectFilter || '');
    const settings = getSettings();

    parent.innerHTML = '';
    const root = document.createElement('div');
    root.className = `${CSS_PREFIX}-viewer-persona`;

    const header = document.createElement('div');
    header.className = `${CSS_PREFIX}-viewer-persona-header`;
    const subjectCount = Object.keys(groups).length;
    header.textContent = `Persona — ${persona.length} entries across ${subjectCount} subject${subjectCount === 1 ? '' : 's'}`;
    root.appendChild(header);

    if (subjectCount === 0) {
        const empty = document.createElement('p');
        empty.className = `${CSS_PREFIX}-viewer-empty`;
        empty.textContent = ctx.subjectFilter
            ? `No Persona entries for "${ctx.subjectFilter}" yet.`
            : 'No Persona entries yet. Rebuild a subject to generate them.';
        root.appendChild(empty);
        // Still render a rebuild form so the user has an entry point.
        root.appendChild(buildRebuildForm(parent, ctx.chatId, settings, () => renderTab(parent, ctx)));
        parent.appendChild(root);
        return;
    }

    for (const [subject, entries] of Object.entries(groups)) {
        root.appendChild(buildSubjectGroup(subject, entries, ctx.chatId, settings, () => renderTab(parent, ctx)));
    }
    parent.appendChild(root);
}

function groupBySubject(entries, subjectFilter) {
    const groups = {};
    const q = subjectFilter.toLowerCase();
    for (const e of entries) {
        const subj = e.subject ?? '(no subject)';
        if (q && !subj.toLowerCase().includes(q)) continue;
        if (!groups[subj]) groups[subj] = [];
        groups[subj].push(e);
    }
    return groups;
}

function buildSubjectGroup(subject, entries, chatId, settings, onRerender) {
    const section = document.createElement('section');
    section.className = `${CSS_PREFIX}-viewer-persona-group`;
    section.setAttribute('data-subject', subject);

    const head = document.createElement('div');
    head.className = `${CSS_PREFIX}-viewer-persona-group-head`;
    const title = document.createElement('h3');
    title.className = `${CSS_PREFIX}-viewer-persona-subject`;
    title.textContent = `${subject} (${entries.length})`;
    head.appendChild(title);
    head.appendChild(buildRebuildButton(chatId, subject, settings, section, onRerender));
    section.appendChild(head);

    const list = document.createElement('ul');
    list.className = `${CSS_PREFIX}-viewer-persona-list`;
    for (const e of entries) list.appendChild(buildPersonaItem(e));
    section.appendChild(list);

    const progress = document.createElement('div');
    progress.className = `${CSS_PREFIX}-viewer-persona-progress`;
    progress.setAttribute('aria-live', 'polite');
    section.appendChild(progress);

    return section;
}

function buildPersonaItem(entry) {
    const li = document.createElement('li');
    li.className = `${CSS_PREFIX}-viewer-persona-item`;
    li.setAttribute('data-id', entry.id);
    const content = document.createElement('div');
    content.className = `${CSS_PREFIX}-viewer-content`;
    content.textContent = entry.content ?? '';
    li.appendChild(content);
    const provenance = document.createElement('div');
    provenance.className = `${CSS_PREFIX}-viewer-provenance`;
    provenance.textContent = `from ${entry.provenance?.extractor ?? 'unknown'}`;
    li.appendChild(provenance);
    return li;
}

function buildRebuildButton(chatId, subject, settings, section, onRerender) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = `${CSS_PREFIX}-viewer-persona-rebuild menu_button`;
    btn.textContent = 'Rebuild';

    if (!settings.profileId) {
        btn.disabled = true;
        btn.title = 'Configure extractor LLM in settings first.';
        return btn;
    }

    btn.addEventListener('click', async () => {
        if (activeRebuild) {
            // This button's rebuild is the active one → cancel.
            if (btn.dataset.active === '1') {
                activeRebuild.abort();
                return;
            }
            // Another subject's rebuild is running; the button should already be disabled.
            return;
        }

        const ac = new AbortController();
        activeRebuild = ac;
        btn.dataset.active = '1';
        btn.textContent = 'Cancel';
        disableOtherRebuildButtons(true);

        const progressEl = /** @type {HTMLElement} */ (section.querySelector(`.${CSS_PREFIX}-viewer-persona-progress`));
        progressEl.innerHTML = '';
        const appendProgress = (line) => {
            const p = document.createElement('div');
            p.className = `${CSS_PREFIX}-viewer-progress-line`;
            p.textContent = line;
            progressEl.appendChild(p);
        };
        appendProgress('Starting rebuild…');

        try {
            const result = await rebuildPersona(chatId, subject, {
                profileId: settings.profileId,
                extractorLabel: settings.extractionModelLabel || 'unknown@persona-rebuild-v1',
                signal: ac.signal,
                onProgress: ({ stage, depth, clusters }) => {
                    const parts = [stage];
                    if (depth != null) parts.push(`depth=${depth}`);
                    if (clusters != null) parts.push(`clusters=${clusters}`);
                    appendProgress(parts.join(' • '));
                },
                now: new Date(),
            });
            appendProgress(`Done — ${result.newCount} new / ${result.replacedCount} replaced in ${result.duration}ms`);
        } catch (err) {
            if (err?.name === 'AbortError') {
                appendProgress('Cancelled.');
            } else {
                appendProgress(`Failed: ${String(err?.message || err)}`);
                log.warn('rebuildPersona failed:', err);
            }
        } finally {
            activeRebuild = null;
            btn.dataset.active = '';
            btn.textContent = 'Rebuild';
            disableOtherRebuildButtons(false);
            // Re-render to pick up new Persona entries. Defer so the user sees
            // the "Done" line for a beat.
            setTimeout(() => onRerender(), 300);
        }
    });
    return btn;
}

function buildRebuildForm(parent, chatId, settings, onRerender) {
    // Offered when no Persona entries exist yet. Requires a subject typed in.
    const form = document.createElement('div');
    form.className = `${CSS_PREFIX}-viewer-persona-rebuild-form`;
    const input = document.createElement('input');
    input.type = 'text';
    input.placeholder = 'Subject to rebuild (e.g. alice)';
    input.className = `${CSS_PREFIX}-viewer-persona-subject-input`;
    form.appendChild(input);
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = `menu_button ${CSS_PREFIX}-viewer-persona-rebuild`;
    btn.textContent = 'Rebuild';
    if (!settings.profileId) {
        btn.disabled = true;
        btn.title = 'Configure extractor LLM in settings first.';
    } else {
        btn.addEventListener('click', async () => {
            const subject = input.value.trim();
            if (!subject) return;
            // Synthesize a section-like container for progress; reuse buildSubjectGroup's progress style.
            const sec = document.createElement('section');
            sec.className = `${CSS_PREFIX}-viewer-persona-group`;
            const progress = document.createElement('div');
            progress.className = `${CSS_PREFIX}-viewer-persona-progress`;
            sec.appendChild(progress);
            form.appendChild(sec);
            // Build a standalone button for running and reuse its handler.
            const trigger = buildRebuildButton(chatId, subject, settings, sec, onRerender);
            trigger.click();
        });
    }
    form.appendChild(btn);
    return form;
}

function disableOtherRebuildButtons(disabled) {
    const btns = document.querySelectorAll(`.${CSS_PREFIX}-viewer-persona-rebuild`);
    for (const b of btns) {
        if (/** @type {HTMLButtonElement} */ (b).dataset.active === '1') continue;
        /** @type {HTMLButtonElement} */ (b).disabled = disabled;
    }
}
