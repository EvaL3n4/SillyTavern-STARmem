# STARmem Phase 8 smoke checklist

**Scope:** 18 manual steps verifying end-to-end ST integration. Run after every Phase 8 ship; also the baseline for Phase 9 regression checks.

**Prerequisites:**
- Fresh SillyTavern checkout (or a known-clean install; no prior STARmem state in `chatMetadata`).
- At least one Connection Manager profile configured with a working LLM.
- The Vectors extension installed and enabled (needed for Persona rebuild in step 14).
- Browser devtools console open — every step cross-checks against console logs scoped to `[STARmem]`.

## Happy path

1. **Install.** `git clone` this repo into `public/scripts/extensions/third-party/`. Restart ST. Verify the Extensions panel lists "STARmem" as loaded without errors. Console shows `[STARmem] v2 loaded`.

2. **Settings panel renders.** Open the Extensions panel → STARmem. Verify all eight inputs are present: profile, embed profile, buffer size, idle timeout, scorer, extraction model label, traces max length, debug mode. No broken labels or missing defaults.

3. **Settings round-trip.** Change buffer size from 5 → 7. Reload ST. Reopen settings panel. Verify buffer size is still 7 (persisted to `extension_settings`). Change back to 5.

4. **Settings clamp.** In devtools: `extension_settings.STARmem.bufferSize = 999; saveSettingsDebounced()`. Reload. Open settings — verify clamped to 50 (the max) and a `[STARmem] settings:` warn line appears in console.

5. **Fresh chat, no memories yet.** Start a new chat. Send one user message. Verify the generation completes normally — interceptor runs (console `[STARmem] interceptor: no memories to inject` or similar) and does NOT prepend a system message.

6. **Consolidation indicator idle.** Verify `#send_but_container` has a `.starmem-indicator` child and it is visually absent (no amber pulse).

7. **Buffer grows.** Send 9 more user+assistant exchanges for a total of 10 messages. Verify console shows `[STARmem] workingBuffer: append` (or equivalent) on each. No consolidation yet.

8. **Consolidation fires at threshold.** Send message 11 (total 11). Verify: indicator flips to amber pulse; console shows `[STARmem] consolidation: starting`; after ~seconds, `consolidation: done, added=N, updated=M`. Indicator returns to idle.

9. **Episodic entries visible.** Open Memory Viewer (settings → "Open Memory Viewer" button). Click Episodic tab. Verify at least one entry is rendered with subject + content + tags.

10. **Graph tab renders.** Click Graph tab. Verify either (a) a force-directed canvas with nodes/edges, or (b) the empty-state message if fewer than 2 entries with edges yet. No uncaught exceptions in console.

11. **Traces tab renders.** Click Traces tab. Verify the summary line for the last retrieval: `T=<tier>  q="..."  top=<score>`. Click a trace to expand the raw JSON. Click Clear — confirm dialog appears; answer No; verify trace still present. Click Clear again, answer Yes; verify list empty.

12. **JSONL export.** Expand Traces tab after a retrieval, click "Export JSONL". Verify a file downloads with `.jsonl` extension, filename contains `starmem-traces-<timestamp>`. Open the file — verify each line is valid JSON parseable independently.

## Chat-switch hygiene

13. **Chat switch mid-idle.** With idle timer running (no messages sent in last 30s), switch to another chat. Verify console shows `[STARmem] idleTimer: cancelled for <oldChatId>`. Switch back. Send a message. Verify idle timer restarts from 60s.

14. **Persona rebuild.** Return to chat from step 9 (now has Episodic entries). In Memory Viewer → Persona tab, type a subject from the Episodic entries, click Rebuild. Verify progress lines scroll (`snapshot`, `chunk`, `knn`, `cluster`, `summarize`, `atomic-swap`). Verify final line shows `Done — N new / M replaced in Xms`. Switch to Persona tab proper — verify new entries.

## Defensive paths

15. **Vectors extension disabled.** Disable the Vectors extension. Attempt a Persona rebuild in any chat. Verify error rendered in the progress panel: `Failed: fetch …` with a descriptive message. No stack trace leaks to user. Re-enable Vectors.

16. **Delete a message mid-chat.** With working buffer populated (≥3 entries), right-click a user message → Delete. Verify working buffer scrubs the corresponding entry (console: `workingBuffer: deleted message at idx N`), buffer count decreases by 1.

17. **Settings drift + reload.** In devtools: `extension_settings.STARmem.schemaVersion = 99; saveSettingsDebounced()`. Reload ST. Open settings. Verify console warned about schemaVersion drift; settings now show defaults.

18. **Disable + re-enable extension.** Disable STARmem via Extensions panel. Verify: indicator disappears; no console errors. Re-enable. Verify: `[STARmem] v2 loaded` appears; indicator re-mounts; next generation still works.

## Regression baseline

After running steps 1–18:
- Copy the browser console output to `scripts/smoke-logs/<date>.log` (git-ignored).
- Note any unexpected warnings/errors for Phase 9 triage.
- If any step fails: **do not ship**. File as Phase 8 bug, fix, re-run the whole checklist.
