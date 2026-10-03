# Prompt submitted off screen. One short run of tool calls, then /compact-tools redraws the same rows
# in each style: Compact first, then Claude, then Codex, and
# /silent at the end leaves only the prompt and the answer. The answer is one word, so every row stays on screen.
Output scripts/demos/out/overview/
Source scripts/demos/common.tape
Set Height 720
Hide
Type "cd $DEMO_DIR && clear && PI_SKIP_VERSION_CHECK=1 pi --approve --tools read,bash,edit,write,grep,find,ls" Enter
Sleep 6s
Type "Use only these tool calls, in order, with no text between them: read extensions/compact-tools-config.ts, read package.json, grep for DEFAULT_CONFIG in extensions, bash `npx tsx --test --test-reporter=dot tests/codex-parse.test.ts`, then edit extensions/compact-tools-config.ts to add a one-line comment above DEFAULT_CONFIG. Do not explain anything; your whole reply is the word ready in capitals."
Enter
Show
Wait+Screen@300s /READY/
Sleep 4s
Type "/compact-tools claude project"
Sleep 1s
Enter
Sleep 8s
Type "/compact-tools codex project"
Sleep 1s
Enter
Sleep 8s
# Typed in full, the command offers no completion, so Enter runs it.
Type "/silent on"
Sleep 1s
Enter
Sleep 6s
