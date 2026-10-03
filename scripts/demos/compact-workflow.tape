# Prompt submitted off screen. The compact style while a run happens: rows streaming, then settled, then opened with Ctrl+O.
Output scripts/demos/out/compact-workflow/
Source scripts/demos/common.tape
Hide
Type "cd $DEMO_DIR && clear && PI_SKIP_VERSION_CHECK=1 pi --approve --tools read,bash,edit,write,grep,find,ls" Enter
Sleep 6s
Type "Where is formatDurationMs used? Look around, run tests/timing-behavior.test.ts with npx tsx --test --test-reporter=dot, then add a one-line comment above it. Do not explain anything; your whole reply is the word ready in capitals."
Enter
Show
Wait+Screen@300s /READY/
Sleep 3s
Ctrl+O
Sleep 4s
Ctrl+O
Sleep 2s
