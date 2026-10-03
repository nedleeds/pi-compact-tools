# Claude Code 2.1.288 UI reference

Observed in a live Herdr pane, using `claude --effort low` (Opus 5.5), not inferred from model descriptions. `npm view @anthropic-ai/claude-code version` matched the installed version. Paths below are shortened; colors depend on the host theme. Approval/classifier notices are Claude-specific and are not reproduced by Pi.

## Completed exploration

The summary has no success dot, uses muted text, and bolds only the counts:

```text
  Searched for 1 pattern, read 2 files, listed 1 directory (ctrl+o to expand)
```

## Bash: twelve output lines, collapsed

```text
⏺ Bash(python3 -c ...)
  ⎿  preview line 01
     preview line 02
     preview line 03
     … +9 lines (ctrl+o to expand)
```

The success dot is green; failed dots and output are red. The result prefix uses an ordinary space and a non-breaking space after `⎿`; Pi uses two ordinary spaces of the same display width.

```text
⏺ Bash(python3 -c "pass")
  ⎿  (No output)

⏺ Bash(python3 -c ...)
  ⎿  Error: Exit code 2
     fixture failure
```

## Write and edit

A twelve-line Write previews ten numbered lines and ends with `… +2 lines (ctrl+o to expand)`. Update reports `Added 2 lines, removed 1 line`, then displays the diff with three unchanged context lines on each side.

## Deliberate Pi differences

Pi keeps its own smaller `⦁` dot instead of `⏺`, and leaves out Claude's growing `✻` working glyph. Pi draws every row one column in, so the dot sits in column 1 and every prefix moves right with it: `⎿` stays under the tool's name, results start two columns after it, and a group's summary or a wrapped call line starts where a name does. Pi keeps its own click/Ctrl+O behavior, theme palette, and continuous pulse rather than reproducing Claude's blinking UI. Exploration groups keep Pi's status dot and title color in every state rather than Claude's quiet, dotless summary above, so a finished group reads like any other row. Claude's background-task shortcut, approval/classifier notices, and advertising tips are not implemented here.
