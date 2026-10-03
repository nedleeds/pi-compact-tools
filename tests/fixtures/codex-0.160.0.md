# Codex CLI 0.160.0 UI reference

Observed in a live Herdr pane with `npx @openai/codex@0.160.0 -s workspace-write -a never` (GPT-6-Sol, low effort), and checked against the `rust-v0.160.0` source (`codex-rs/tui/src/exec_cell`, `history_cell`, `diff_render.rs`, `transcript_view/layout.rs`). `npm view @openai/codex version` matched. Paths are shortened; colors depend on the host theme.

## Commands, collapsed

The success bullet is bold green, a failed one bold red. The verb is bold and the command is shell-highlighted. Output is dimmed, and only its **last** three lines show, each cut to one row with `…`. The disclosure row starts at `min(width / 4, 4)` and drops its key hint when the row cannot fit it.

```text
• Ran seq 1 12
  └ 10
    11
    12
    + 9 lines (ctrl+t to expand)

• Ran true
  └ (no output)

• Failed (exit 2) sh -c 'echo fixture failure >&2; exit 2'
  └ fixture failure
```

A header wider than the row is cut with `…`; a multi-line command shows its first line and ` …`. Either one, or an output line too wide for the row, gives `+ Show details` when no line count applies:

```text
• Ran echo aaaaaaaaaa bbbbbbbbbb cccccccccc dddddddddd eeeeeeeeee ffffffffff gggggggggg hhhhhhhhhh iiiiiiiiii jjjjjjjjj…
  └ aaaaaaaaaa bbbbbbbbbb cccccccccc dddddddddd eeeeeeeeee ffffffffff gggggggggg hhhhhhhhhh iiiiiiiiii jjjjjjjjjj kkkkk…
    + 1 line (ctrl+t to expand)
```

While a call runs its header reads `Running` behind an animated bullet, followed by the tail of its live output. (Codex 0.160 moved most long commands to background terminals, so this row is rarely on screen; the source still draws it.)

## Commands, opened (F4, Enter)

The header is replaced by the command after a magenta `$`, its continuation indented four columns; the output follows undimmed and whole, then the outcome and its time:

```text
$ echo aaaaaaaaaa bbbbbbbbbb … jjjjjjjjjj
    kkkkkkkkkk llllllllll mmmmmmmmmm nnnnnnnnnn
aaaaaaaaaa bbbbbbbbbb … kkkkkkkkkk
llllllllll mmmmmmmmmm nnnnnnnnnn
✓ • 0ms
    − Show less
```

A failure reads `✗ (2) • 12ms`. Times are `250ms`, `1.50s`, `1m 15s`.

Only a call whose preview leaves something out has a control: Enter on `• Ran true` or a one-line failure changes nothing. Pi's Ctrl+O opens every row, so such a row keeps its preview when opened.

## Exploration

Reads, searches and listings fold into one dim-bulleted group. Each call is one line with its verb in the accent color; consecutive reads merge into one line of distinct file names (the last path segment, skipping `src`, `dist`, `build` and `node_modules`). The collapsed group keeps its first three detail rows and always offers `+ Show details`:

```text
• Explored
  └ Read README.md, notes.md, util.ts
    Search export in src
    List docs
    + Show details
```

Opened (Enter on `+ Show details`), the summary gives way to each call's transcript, `$ cmd`, its output, and `✓ • 0ms`, one after another, with a single `− Show less` beneath them all.

While a call runs the header reads `Exploring`. A failed call ends its line with ` (exit N)` in red, or ` (command exit N)` for a compound command; only a search's exit 1, which can mean it found nothing, is dim. The header gains ` · N failed` in bold red, counting every non-zero exit. Opened, each call is drawn as an opened command, separated by a blank line.

## Edits

Bullet dim, verb bold, counts green and red. Collapsed, only changed lines show, three rows at most, four columns in, each tinted across the whole row; the gutter is `{line} {sign}{code}`:

```text
• Edited src/app.ts (+1 -1)
    2 -    return `Hello, ${name}!`;
    2 +    return `Hi, ${name}!`;
    + Show details

• Added docs/new.md (+12 -0)
     1 +line 1
     2 +line 2
     3 +line 3
    + Show details
```

Opened, the header stays and the diff gains its context lines, with `⋮` between hunks:

```text
• Edited src/app.ts (+1 -1)
    1  export function greet(name: string): string {
    2 -    return `Hello, ${name}!`;
    2 +    return `Hi, ${name}!`;
    3  }
    − Show less
```

A failed patch reads `✘ Failed to apply patch` in bold magenta with the error under `└`.

## MCP tools

Observed with a stdio MCP server (`lab`) whose `web_search` returns six lines. The bullet animates while the call runs and approval is asked; it settles bold green, or bold red on failure. The name is in the accent color, without arguments until opened:

```text
• Calling lab.web_search
    + Show details

• Called lab.web_search
  └ result 4
    result 5
    result 6
    + Show details

• Failed lab.web_search
  └ Error: MCP tool call requires approval, but approval policy is never
    + Show details
```

Opened, the header lists the JSON arguments and the whole result follows:

```text
• Called lab.web_search({"query":"pi tui","limit":3})
  └ result 1
    result 2
    result 3
    result 4
    result 5
    result 6
    − Show less
```

## Deliberate Pi differences

Pi draws every row one column in, so each prefix moves right with it. Codex's `ctrl+t` hint becomes Pi's `ctrl+o`, which is what expands a row in Pi, and a click on any row toggles it as Pi always has. Colors come from Pi's theme: the accent for verbs, `bashMode` for `$`, `dim` for output and chrome, and the running bullet uses Pi's pulse in place of Codex's shimmer. Codex counts `xargs` and `tee` as formatting and reads `find -delete` as a listing; a group hides its commands, so here any command that can write or run something (`xargs`, `tee`, `find -delete`/`-exec`, `fd -x`, `sort -o`, a writing `sed` or `awk`) is a command it ran. Codex reads a quoted `;` as a connector, so `rg ';' src` shows as `Search rg ';' src`; here it reads `Search ; in src`. Pi's dedicated tools have no Codex command, so a lone `read`, `grep`, `find` or `ls` row uses its exploration verb (`• Read src/app.ts`), a `write` reads `• Wrote path (+N -0)` because Pi does not report whether the file existed, an edit or write in progress reads `Editing`/`Writing`, and a failed one names its file: `✘ Failed to edit src/app.ts`. Pi's custom tools have no server, so they read `• Called web_search`.
