# Claude Code 2.1.312 UI reference

Observed in a live Herdr pane running the installed `claude --effort high` (Sonnet 5.5); version verified with `claude --version`. Claude was consulted in that pane and independently inspected its embedded group renderer. This reference supersedes the exploration and expanded-Read behavior in `claude-code-2.1.288.md`.

## Exploration

A completed exploration has no dot and uses muted text, with **only count digits bold**:

```text
  Searched for 1 pattern, read 1 file, listed 1 directory (ctrl+o to expand)
```

While running, the group retains a dot, progressive verbs and a trailing `…`. The embedded renderer also retains optional elapsed time after two seconds. Ctrl+O replaces the summary with the individual calls; it does not leave a group header above them.

## Expanded Read

Ctrl+O shows only the line count, **not the file's contents**. Ranges appear in the title:

```text
⏺ Read(/tmp/cc-parity-sample.txt · lines 1-3)
  ⎿  Read 3 lines

⏺ Read(/tmp/cc-parity-sample.txt · from line 6)
  ⎿  Read 9 lines

⏺ Read(/tmp/cc-parity-sample.txt · lines 5-8)
  ⎿  Read 4 lines
```

These used limit-only, offset-only, and offset+limit respectively. Repeated reads of the same path still count as one file in the collapsed group.

## Bash

Completed output still previews the first three rows; twelve short lines produce:

```text
⏺ Bash(for i in $(seq 1 12); do echo ...; done)
  ⎿  preview line 01
     preview line 02
     preview line 03
     … +9 lines (ctrl+o to expand)
```

Ctrl+O reveals all output and the full command (a 200-character echo command was shortened at 160 characters in the collapsed title). An empty successful `true` shows `(No output)`. Both an `exit 2` with no diagnostics and one printing `fixture failure` retain `Error: Exit code 2` after expansion; Pi's `Command exited with code 2` is never a displayed diagnostic.

While running, output follows the **last four rows**, not the completed preview's first three. Observed after five lines followed by a fifteen-second sleep:

```text
  Bash(printf ...; sleep 15; printf ...)
  ⎿  stream line 2
     stream line 3
     stream line 4
     stream line 5
     +1 lines (6s · timeout 1m)
     (ctrl+b to run in background)
```

The singular `+1 lines` is Claude's wording. Expanded Bash shows all output, including output from a grouped `grep` command.

## Write and Update

Reconfirmed live: a twelve-line Write previews ten numbered lines followed by `… +2 lines (ctrl+o to expand)`. Update reports `Added 2 lines, removed 1 line` and shows three unchanged context lines on either side of the change. Gutter placement is unchanged from the 2.1.296 observations in the earlier fixture.

## Pi-specific boundaries

Pi retains its theme palette, smaller `⦁` dot, continuous pulse and one-column outer margin. Collapsed pending/interrupted and failed exploration groups retain Pi's status cue; successful groups are quiet and dotless. A locally clicked-open group retains a clickable header for closing it, whereas Ctrl+O hides every group header and shows each call's own status. Group hints still say `(click to expand)` because Pi supports opening just one group.

Only read-only exploration folds into groups; Pi does not hide writes, edits or arbitrary shell commands behind Claude's optional generalized group summaries. Pi's separate grep/find/ls tools retain their existing expanded result bodies; the native search available in the observed session was Bash `grep`, not a standalone Grep tool. Read ranges require positive safe-integer numeric arguments; malformed values and numeric strings in historical calls omit the range rather than reproduce Claude's unchecked arithmetic. Paths retain Pi's supplied spelling in either view, and Read failures use Pi's diagnostic wording. Pi has no Claude PDF/pages, notebook, unchanged-read or already-in-context result variants. Image results say `Read image` without a Claude size suffix; image attachments remain the host's responsibility. Background-task controls, Claude's streaming timeout/elapsed footer, approval/classifier notices, advertising tips and detailed-transcript timestamps are not reproduced. These are UI-only changes: tool execution and model-facing content remain unchanged.
