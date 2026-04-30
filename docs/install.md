# Install

## Path A—From the SillyTavern UI (recommended)

1. Open SillyTavern.
2. Click the Extensions icon (puzzle piece) in the top bar.
3. Click "Install Extension" at the top right of the panel.
4. Paste: `https://github.com/EvaL3n4/SillyTavern-STARmem`
5. Click "Install".
6. STARmem appears in the extension list. Toggle it on.

## Path B—Local clone (development)

```bash
cd <path-to-SillyTavern>/public/scripts/extensions/third-party
git clone https://github.com/EvaL3n4/SillyTavern-STARmem.git
```

Restart SillyTavern. The extension loads from the cloned directory.

For dev tooling (lint, typecheck, jest, playwright):

```bash
cd <path>/public/scripts/extensions/third-party/SillyTavern-STARmem
npm install
npm test         # jest unit + integration
npm run lint
npm run typecheck
npm run test:e2e # Playwright; requires local ST running
```

## Verifying the install

After enabling STARmem, send a few messages in any chat. The
consolidation indicator (a small dot next to the send button) should
pulse briefly after ~10 messages. Open the STARmem Memory Viewer from
the Extensions drawer to inspect what's been recorded.

## Uninstall

Disable from the Extensions panel, or:

```bash
rm -rf <path-to-ST>/public/scripts/extensions/third-party/SillyTavern-STARmem
```

State stored in `chatMetadata['STARmem']` is preserved across
reinstalls because it lives in your chat files, not in the extension
directory.
