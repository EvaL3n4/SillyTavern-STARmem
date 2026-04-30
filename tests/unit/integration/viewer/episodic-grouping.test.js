/** @jest-environment jsdom */
/**
 * Episodic tab — grouping, sort modes, and meta-shape regressions for P16 T6.
 *
 * Covers:
 *   - Subject sort produces grouped layout with alphabetical group order.
 *   - Within-group sort is importance ↓ (decision 2a).
 *   - Flat sort modes (importance/recency/added) keep the existing list shape.
 *   - Subject is omitted from per-row meta inside grouped layout.
 *   - '(no subject)' bucket sorts before alphabetic subjects (leading paren).
 *
 * Does NOT cover the recency-rendering path — that's pinned by
 * episodic-recency.test.js.
 */
import { describe, test, expect, beforeEach } from '@jest/globals';
import { renderTab } from '../../../../src/integration/viewer/tabs/episodic.js';

const ENTRY_DEFAULTS = {
    scope: 'episodic',
    tags: [],
    relations: [],
    provenance: { sourceMessages: [0], extractor: 'test@v1' },
};

function makeEntry(id, subject, importance, content, ageDays = 1) {
    return {
        ...ENTRY_DEFAULTS,
        id,
        subject,
        content,
        lifecycle: {
            importance,
            maturity: 'draft',
            createdAt: new Date(Date.now() - ageDays * 86_400_000).toISOString(),
            updatedAt: new Date().toISOString(),
            accessCount: 0,
            updateCount: 0,
        },
    };
}

describe('episodic tab — flat list (default)', () => {
    let parent;
    beforeEach(() => {
        parent = document.createElement('div');
        document.body.appendChild(parent);
    });

    test('renders flat <ul> by default with all entries', async () => {
        const entries = {
            'a': makeEntry('a', 'Alanis', 80, 'first'),
            'b': makeEntry('b', 'Theo',   40, 'second'),
        };
        await renderTab(parent, { chatId: 'c', subjectFilter: '', state: { entries } });

        const list = parent.querySelector('.starmem-viewer-episodic-list');
        expect(list).not.toBeNull();
        expect(list.tagName.toLowerCase()).toBe('ul');
        expect(list.children).toHaveLength(2);
        // No grouped wrapper on first paint.
        expect(parent.querySelector('.starmem-viewer-episodic-groups')).toBeNull();
    });

    test('default sort is importance descending', async () => {
        const entries = {
            'a': makeEntry('a', 'Alanis', 30, 'low'),
            'b': makeEntry('b', 'Theo',   80, 'high'),
            'c': makeEntry('c', 'Mira',   55, 'mid'),
        };
        await renderTab(parent, { chatId: 'c', subjectFilter: '', state: { entries } });

        const items = [...parent.querySelectorAll('.starmem-viewer-episodic-item')];
        expect(items.map(li => li.getAttribute('data-id'))).toEqual(['b', 'c', 'a']);
    });
});

describe('episodic tab — subject grouping (P16 T6)', () => {
    let parent;
    beforeEach(() => {
        parent = document.createElement('div');
        document.body.appendChild(parent);
    });

    async function renderAndSwitchToSubject(entries) {
        await renderTab(parent, { chatId: 'c', subjectFilter: '', state: { entries } });
        const sortSelect = parent.querySelector('#starmem-viewer-episodic-sort');
        sortSelect.value = 'subject';
        sortSelect.dispatchEvent(new Event('change'));
    }

    test('switching sort to "subject" replaces flat list with grouped sections', async () => {
        const entries = {
            'a': makeEntry('a', 'Alanis', 60, 'one'),
            'b': makeEntry('b', 'Alanis', 80, 'two'),
            'c': makeEntry('c', 'Theo',   50, 'three'),
        };
        await renderAndSwitchToSubject(entries);

        expect(parent.querySelector('.starmem-viewer-episodic-list')).toBeNull();
        const groups = parent.querySelectorAll('.starmem-viewer-episodic-group');
        expect(groups).toHaveLength(2);
    });

    test('groups appear in alphabetical order (decision 1a)', async () => {
        const entries = {
            't': makeEntry('t', 'Theo',   50, 'theo entry'),
            'a': makeEntry('a', 'Alanis', 60, 'alanis entry'),
            'm': makeEntry('m', 'Mira',   70, 'mira entry'),
        };
        await renderAndSwitchToSubject(entries);

        const subjects = [...parent.querySelectorAll('.starmem-viewer-episodic-group-subject')];
        expect(subjects.map(s => s.textContent)).toEqual(['Alanis', 'Mira', 'Theo']);
    });

    test('within-group sort is importance descending (decision 2a)', async () => {
        const entries = {
            'a1': makeEntry('a1', 'Alanis', 30, 'low'),
            'a2': makeEntry('a2', 'Alanis', 90, 'high'),
            'a3': makeEntry('a3', 'Alanis', 60, 'mid'),
        };
        await renderAndSwitchToSubject(entries);

        const items = [...parent.querySelectorAll('.starmem-viewer-episodic-item')];
        expect(items.map(li => li.getAttribute('data-id'))).toEqual(['a2', 'a3', 'a1']);
    });

    test('per-group count surfaces in the heading', async () => {
        const entries = {
            'a1': makeEntry('a1', 'Alanis', 60, 'one'),
            'a2': makeEntry('a2', 'Alanis', 50, 'two'),
            'a3': makeEntry('a3', 'Alanis', 40, 'three'),
            't1': makeEntry('t1', 'Theo',   30, 'solo'),
        };
        await renderAndSwitchToSubject(entries);

        const counts = [...parent.querySelectorAll('.starmem-viewer-episodic-group-count')];
        expect(counts.map(c => c.textContent)).toEqual(['3', '1']);
    });

    test('grouped rows omit the subject from the meta line (it is the heading)', async () => {
        const entries = {
            'a1': makeEntry('a1', 'Alanis', 60, 'one'),
        };
        await renderAndSwitchToSubject(entries);

        const item = parent.querySelector('.starmem-viewer-episodic-item');
        expect(item).not.toBeNull();
        // .starmem-viewer-subject is the per-row subject span — should be absent
        // when rendered inside a group (subject is the heading instead).
        expect(item.querySelector('.starmem-viewer-subject')).toBeNull();
        // Scores are still present.
        expect(item.querySelector('.starmem-viewer-scores')).not.toBeNull();
    });

    test('flat rows include the subject in the meta line', async () => {
        const entries = {
            'a1': makeEntry('a1', 'Alanis', 60, 'one'),
        };
        await renderTab(parent, { chatId: 'c', subjectFilter: '', state: { entries } });

        const item = parent.querySelector('.starmem-viewer-episodic-item');
        const subj = item.querySelector('.starmem-viewer-subject');
        expect(subj).not.toBeNull();
        expect(subj.textContent).toBe('Alanis');
    });

    test('entries with missing subject bucket under "(no subject)" and sort first', async () => {
        const entries = {
            'a': makeEntry('a', 'Alanis', 50, 'with subject'),
            'n': makeEntry('n', undefined, 50, 'no subject'),
            'e': makeEntry('e', '',        50, 'empty subject'),
        };
        await renderAndSwitchToSubject(entries);

        const subjects = [...parent.querySelectorAll('.starmem-viewer-episodic-group-subject')]
            .map(s => s.textContent);
        // '(no subject)' sorts before 'Alanis' by ASCII; both empty/missing bucket together.
        expect(subjects).toEqual(['(no subject)', 'Alanis']);
        const noSubjGroup = parent.querySelector(
            '[data-subject="(no subject)"] .starmem-viewer-episodic-group-list',
        );
        expect(noSubjGroup.children).toHaveLength(2);
    });

    test('switching back from subject to importance restores flat list', async () => {
        const entries = {
            'a': makeEntry('a', 'Alanis', 60, 'one'),
            'b': makeEntry('b', 'Theo',   50, 'two'),
        };
        await renderAndSwitchToSubject(entries);
        expect(parent.querySelector('.starmem-viewer-episodic-groups')).not.toBeNull();

        const sortSelect = parent.querySelector('#starmem-viewer-episodic-sort');
        sortSelect.value = 'importance';
        sortSelect.dispatchEvent(new Event('change'));

        expect(parent.querySelector('.starmem-viewer-episodic-groups')).toBeNull();
        expect(parent.querySelector('.starmem-viewer-episodic-list')).not.toBeNull();
    });
});

describe('episodic tab — sort dropdown', () => {
    test('Subject option is present alongside the three flat sorts', async () => {
        const parent = document.createElement('div');
        document.body.appendChild(parent);
        await renderTab(parent, {
            chatId: 'c', subjectFilter: '',
            state: { entries: { 'a': makeEntry('a', 'X', 50, 'c') } },
        });

        const opts = [...parent.querySelectorAll('#starmem-viewer-episodic-sort option')]
            .map(o => o.value);
        expect(opts).toEqual(['importance', 'recency', 'added', 'subject']);
    });
});
