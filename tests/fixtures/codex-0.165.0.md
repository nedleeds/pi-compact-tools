# Codex CLI 0.165.0 compact UI reference

Pinned upstream tag: **rust-v0.165.0**. The installed CLI reported `codex-cli 0.165.0`; npm latest was independently verified as 0.165.0 by the coordinating assistant. Source was inspected from the coordinating assistant's download at `/tmp/pi-compact-codex-source/codex-rs/tui`.

Live captured in Herdr during Codex consultation: the failed Node test command appeared in the default collapsed UI as `• Exited (status 1) …`. This agrees with `compact_command_lines`, rather than the separate `display_lines` renderer. The older [0.160.0 fixture](codex-0.160.0.md) remains a historical live capture.

## Authoritative render paths

- [exec_cell/compact.rs](https://github.com/openai/codex/blob/rust-v0.165.0/codex-rs/tui/src/exec_cell/compact.rs): `compact_command_lines` draws the default collapsed command; `command_disclosure` determines whether and how much it can reveal.
- [exec_cell/transcript.rs](https://github.com/openai/codex/blob/rust-v0.165.0/codex-rs/tui/src/exec_cell/transcript.rs): `detailed_hyperlink_lines` draws expanded commands, output, and outcomes.
- [history_cell/mcp_preview.rs](https://github.com/openai/codex/blob/rust-v0.165.0/codex-rs/tui/src/history_cell/mcp_preview.rs): `compact_mcp_lines` draws collapsed MCP activity and its last three detail lines.
- [exec_cell/render.rs](https://github.com/openai/codex/blob/rust-v0.165.0/codex-rs/tui/src/exec_cell/render.rs): `compact_hyperlink_lines` dispatches to the compact command renderer; exploration summaries also live here. Its separate `command_display_lines_with_hidden_details` uses `Ran` on failure, command continuation rows, and a head output preview. Those are **not** the default collapsed command contract.

Examples below omit Pi's extra one-column left margin. Key labels vary by platform (`⌃t`, `^t`, `ctrl+t`); examples spell `ctrl+t`. Pi uses its own `ctrl+o` key and `to expand` wording.

## Collapsed commands

Success: bold green bullet, bold `Ran`. Nonzero exit: **bold neutral bullet**, bold `Exited (status N)`. The command retains shell syntax colors. A running command says `Running` with an animated bullet.

```text
• Ran seq 1 12
  └ 10
    11
    12
    + 9 lines (ctrl+t to expand)

• Ran true
  └ (no output)

• Exited (status 2) sh -c 'echo fixture failure >&2; exit 2'
  └ fixture failure
```

The output preview keeps the **last three logical lines**, dim and clipped individually with `…`; it does not wrap. The first command line is clipped too. A multiline command shows only its first line followed by ` …`.

```text
• Ran echo first …
  └ first
    second
    + Show details
```

`command_disclosure` counts retained lines before the last three plus each clipped line among those last three. A five-line result with two clipped tail lines therefore says `+ 4 lines`. A clipped header or multiline command with no hidden output uses `+ Show details`. A short command with no hidden content has no disclosure and remains a preview even when Pi globally expands rows. Disclosure indentation and key-hint fitting follow the older fixture.

## Expanded commands

The compact header gives way to the full highlighted command after a magenta `$`; command continuations are indented four columns. Full output follows undimmed, then the outcome and duration:

```text
$ sh -c 'seq 1 5; exit 2'
1
2
3
4
5
✗ (2) • 12ms
    − Show less
```

The success outcome is bold green `✓`; failure is bold red `✗` with its numeric code. Durations remain `250ms`, `1.50s`, `1m 15s`. Pi keeps its width-bounded wrapping and theme colors. Expansion changes only presentation, never retained tool output or model-visible messages.

## MCP and Pi custom tools

`mcp_preview.rs` keeps the last three detail lines, dim and clipped. Success bullets are bold green; **custom/MCP failure bullets remain bold red**, unlike numeric shell exits. Names use the accent color. Short errors gain `Error: `; errors longer than three lines show their tail without that prefix. Arguments appear when expanded.

```text
• Called lab.web_search
  └ result 4
    result 5
    result 6
    + Show details

• Failed lab.web_search
  └ Error: Search provider unavailable
    + Show details
```

Pi custom tools have no MCP server prefix. Their author's expanded renderer, when available, and Pi's nested-call completion summary remain supported.

## Pi adaptations and remaining review points

Pi keeps its one-column margin, Ctrl+O expansion, click controls, theme, and running pulse. Dedicated file tools keep exploration verbs; writes say `Wrote` because Pi does not report file existence. Conservative exploration parsing continues to expose commands that can write or execute other programs. No tools, arguments, outputs, prompts, or model loadouts are changed.

A Pi timeout or abort may have no numeric exit code. It explicitly remains `• Failed command` with a red bullet and the supplied reason, rather than inventing `Exited (status N)`.

Exploration's compact summary uses neutral bold `· 1 nonzero exit` or `· N nonzero exits`, counting completed shell calls with actual numeric nonzero outcomes (including search exit 1). Pi-only failures without numeric status retain a separate red bold `· N failed`: dedicated read/grep errors and aborted shells never imply a nonzero exit. A mixed group can therefore read `• Explored · 1 nonzero exit · 3 failed`. Patch rendering remains covered by the existing diff tests and historical fixture. Native-only background terminal interactions, NodeRepl titles/result decoding, image markers, retained-output storage limits, and URL-aware transcript selection are not emulated by this update.
