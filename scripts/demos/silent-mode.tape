# Prompt submitted off screen. Silent mode switched on mid-run: the rows fold away while the
# agent works, the answer stays, and every row comes back once it is switched off.
Output scripts/demos/out/silent-mode/
Source scripts/demos/common.tape
Hide
Type "cd $DEMO_DIR && clear && PI_SKIP_VERSION_CHECK=1 pi --approve --tools read,bash,edit,write,grep,find,ls" Enter
Sleep 6s
Type "Use only these tool calls, in order, with no text between them: read extensions/compact-tools-silent.ts, grep for SilentModeController in extensions, bash `npx tsx --test --test-reporter=dot tests/activity-behavior.test.ts`, then edit extensions/compact-tools-silent.ts to add a one-line comment above SilentModeController. Then answer in one short sentence what silent mode hides, followed by a last line with just the word ready in capitals."
Enter
Show
# Once the first rows have settled, silence them while the rest still run.
Wait+Screen@120s /Done in/
Sleep 2s
Type "/silent on"
Sleep 1s
Enter
Wait+Screen@300s /READY/
Sleep 4s
Type "/silent off"
Sleep 1s
Enter
Sleep 7s
