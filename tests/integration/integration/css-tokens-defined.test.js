import { readFileSync } from 'fs';
import { resolve } from 'path';

describe('every --starmem-* token used is also defined in style.css', () => {
    const css = readFileSync(resolve(process.cwd(), 'style.css'), 'utf8');

    test('every var(--starmem-X) reference resolves to a definition', () => {
        const used = new Set();
        const re = /var\(\s*(--starmem-[a-z0-9-]+)/gi;
        let m;
        while ((m = re.exec(css))) used.add(m[1]);

        const defined = new Set();
        const defRe = /^\s*(--starmem-[a-z0-9-]+)\s*:/gm;
        let d;
        while ((d = defRe.exec(css))) defined.add(d[1]);

        const missing = [...used].filter(u => !defined.has(u));
        expect(missing).toEqual([]);
    });

    test('Quiet Library token surface is present', () => {
        const required = [
            '--starmem-font-display', '--starmem-font-body', '--starmem-font-mono',
            '--starmem-fs-display-1', '--starmem-fs-display-2', '--starmem-fs-body',
            '--starmem-fs-meta', '--starmem-fs-mono',
            '--starmem-space-1', '--starmem-space-7',
            '--starmem-elev-1', '--starmem-elev-3',
            '--starmem-radius-1', '--starmem-radius-3',
            '--starmem-ease', '--starmem-dur-fast', '--starmem-dur-med', '--starmem-dur-slow',
            '--starmem-accent',
        ];
        for (const tok of required) {
            expect(css).toContain(`${tok}:`);
        }
    });
});
