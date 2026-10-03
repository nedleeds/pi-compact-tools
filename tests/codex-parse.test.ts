/**
 * The Codex style's pure rules, checked against Codex CLI 0.160.0: how it names a
 * file, prints a duration, offers hidden lines, and tells a command that only looks
 * around from one that runs something. Cases marked "codex" are Codex's own tests.
 */
import assert from "node:assert/strict";
import test from "node:test";
import {
	codexDisclosure,
	exploreActions,
	exploreFailure,
	exploreLines,
	formatCodexDuration,
	isEmptyOutput,
	parseExploreCommand,
	shellOutcome,
	shortDisplayPath,
	tailLines,
	type ExploreAction,
} from "../extensions/compact-tools-codex.ts";

test("durations read as Codex prints them (codex)", () => {
	assert.equal(formatCodexDuration(0), "0ms");
	assert.equal(formatCodexDuration(250), "250ms");
	assert.equal(formatCodexDuration(999), "999ms");
	assert.equal(formatCodexDuration(1_000), "1.00s");
	assert.equal(formatCodexDuration(1_500), "1.50s");
	assert.equal(formatCodexDuration(59_999), "60.00s");
	assert.equal(formatCodexDuration(60_000), "1m 00s");
	assert.equal(formatCodexDuration(75_000), "1m 15s");
	assert.equal(formatCodexDuration(3_601_000), "60m 01s");
	assert.equal(formatCodexDuration(-5), "0ms", "a clock that ran backwards is never negative");
});

test("a file is named by its last meaningful path segment (codex)", () => {
	assert.equal(shortDisplayPath("src/app.ts"), "app.ts");
	assert.equal(shortDisplayPath("docs/"), "docs");
	assert.equal(shortDisplayPath("a/b/src"), "b", "src says nothing about where");
	assert.equal(shortDisplayPath("node_modules/pkg/dist/index.js"), "index.js");
	assert.equal(shortDisplayPath("pkg/dist"), "pkg");
	assert.equal(shortDisplayPath("src"), "src", "a path of nothing else keeps itself");
	assert.equal(shortDisplayPath("C:\\work\\notes.md"), "notes.md");
	assert.equal(shortDisplayPath("."), ".");
});

test("the disclosure control starts a quarter in, at most four, and drops a hint it cannot fit", () => {
	assert.equal(codexDisclosure(100, false, 9), "     + 9 lines (ctrl+o to expand)");
	assert.equal(codexDisclosure(100, false, 1), "     + 1 line (ctrl+o to expand)");
	assert.equal(codexDisclosure(100, false), "     + Show details");
	assert.equal(codexDisclosure(100, true, 9), "     − Show less");
	assert.equal(codexDisclosure(12, false), "    + Show details", "a quarter of 12 is three columns");
	assert.equal(codexDisclosure(30, false, 9), "     + 9 lines", "the hint needs more room than 30 columns");
	assert.equal(codexDisclosure(33, false, 9), "     + 9 lines (ctrl+o to expand)", "exactly fits");
	assert.equal(codexDisclosure(32, false, 9), "     + 9 lines");
	assert.equal(codexDisclosure(2, false), " + Show details", "below four columns only the margin is left; the row is cut where drawn");
});

const read = (name: string): ExploreAction => ({ kind: "read", name });

test("reads are recognized the way Codex parses them (codex)", () => {
	assert.deepEqual(parseExploreCommand("cat src/app.ts"), [read("app.ts")]);
	assert.deepEqual(parseExploreCommand("cat 'docs/my notes.md'"), [read("my notes.md")]);
	assert.equal(parseExploreCommand("cat src/app.ts src/util.ts"), undefined, "two files is not one read");
	assert.deepEqual(parseExploreCommand("sed -n 1,200p src/app.ts"), [read("app.ts")]);
	assert.deepEqual(parseExploreCommand("sed -n '10,20p' README.md"), [read("README.md")]);
	assert.deepEqual(parseExploreCommand("sed -n -e 5p notes.txt"), [read("notes.txt")]);
	assert.equal(parseExploreCommand("sed -i 's/a/b/' src/app.ts"), undefined, "an in-place sed writes");
	assert.equal(parseExploreCommand("sed 's/a/b/' src/app.ts"), undefined, "a sed without -n prints everything changed");
	assert.deepEqual(parseExploreCommand("head -n 50 README.md"), [read("README.md")]);
	assert.deepEqual(parseExploreCommand("head -n50 README.md"), [read("README.md")]);
	assert.deepEqual(parseExploreCommand("tail -n +10 logs/app.log"), [read("app.log")]);
	assert.deepEqual(parseExploreCommand("tail app.log"), [read("app.log")]);
	assert.equal(parseExploreCommand("head -5 README.md"), undefined, "only -n counts are understood");
	assert.deepEqual(parseExploreCommand("nl -ba src/app.ts"), [read("app.ts")]);
	assert.deepEqual(parseExploreCommand("bat --style plain src/app.ts"), [read("app.ts")]);
	assert.deepEqual(parseExploreCommand("less README.md"), [read("README.md")]);
	assert.deepEqual(parseExploreCommand("more README.md"), [read("README.md")]);
});

test("searches and listings name what they look for and where (codex)", () => {
	assert.deepEqual(parseExploreCommand("rg -n TODO src"), [{ kind: "search", query: "TODO", path: "src", command: "rg -n TODO src" }]);
	assert.deepEqual(parseExploreCommand("rg -n 'export' src/lib"), [{ kind: "search", query: "export", path: "lib", command: "rg -n export src/lib" }]);
	assert.deepEqual(parseExploreCommand("rg -g '*.ts' foo"), [{ kind: "search", query: "foo", path: undefined, command: "rg -g *.ts foo" }]);
	assert.deepEqual(parseExploreCommand("rg --files src"), [{ kind: "list", path: "src", command: "rg --files src" }]);
	assert.deepEqual(parseExploreCommand("grep -R CODEX_SANDBOX -n ."), [{ kind: "search", query: "CODEX_SANDBOX", path: ".", command: "grep -R CODEX_SANDBOX -n ." }]);
	assert.deepEqual(parseExploreCommand("grep -e foo -r lib"), [{ kind: "search", query: "foo", path: "lib", command: "grep -e foo -r lib" }]);
	assert.deepEqual(parseExploreCommand("git grep needle"), [{ kind: "search", query: "needle", path: undefined, command: "git grep needle" }]);
	assert.deepEqual(parseExploreCommand("ag pattern lib"), [{ kind: "search", query: "pattern", path: "lib", command: "ag pattern lib" }]);
	assert.deepEqual(parseExploreCommand("find . -name '*.ts'"), [{ kind: "search", query: "*.ts", path: ".", command: "find . -name *.ts" }]);
	assert.deepEqual(parseExploreCommand("find src -type f"), [{ kind: "list", path: "src", command: "find src -type f" }]);
	assert.deepEqual(parseExploreCommand("fd main src"), [{ kind: "search", query: "main", path: "src", command: "fd main src" }]);
	assert.deepEqual(parseExploreCommand("fd main"), [{ kind: "search", query: "main", command: "fd main" }]);
	assert.deepEqual(parseExploreCommand("fd docs/"), [{ kind: "list", path: "docs", command: "fd docs/" }]);
	assert.deepEqual(parseExploreCommand("ls docs"), [{ kind: "list", path: "docs", command: "ls docs" }]);
	assert.deepEqual(parseExploreCommand("ls -la"), [{ kind: "list", path: undefined, command: "ls -la" }]);
	assert.deepEqual(parseExploreCommand("tree -L 2 src"), [{ kind: "list", path: "src", command: "tree -L 2 src" }]);
	assert.deepEqual(parseExploreCommand("git ls-files lib"), [{ kind: "list", path: "lib", command: "git ls-files lib" }]);
});

test("formatting stages, cd, a leading echo, and true say nothing about a command (codex)", () => {
	assert.deepEqual(parseExploreCommand("rg TODO | head -n 20")?.map((action) => action.kind), ["search"]);
	assert.deepEqual(parseExploreCommand("rg TODO | wc -l")?.map((action) => action.kind), ["search"]);
	assert.deepEqual(parseExploreCommand("cat README.md | head -5"), [read("README.md")]);
	assert.deepEqual(parseExploreCommand("cd src && rg x"), [{ kind: "search", query: "x", path: undefined, command: "rg x" }]);
	assert.deepEqual(parseExploreCommand("echo --- && cat a.ts"), [read("a.ts")]);
	assert.deepEqual(parseExploreCommand("rg x src || true")?.map((action) => action.kind), ["search"]);
	assert.deepEqual(parseExploreCommand("rg a\nrg b")?.map((action) => action.kind), ["search", "search"]);
	assert.deepEqual(parseExploreCommand("ls src; cat README.md")?.map((action) => action.kind), ["list", "read"]);
});

test("a command that runs anything else is a command it ran (codex)", () => {
	for (const command of [
		"npm test", "rg x src; sleep 4", "cat package.json | jq .scripts", "git status", "echo hi",
		"cat a.ts > b.ts", "cat $(ls)", "cat `ls`", "rg x &", "cat 'unterminated", "(cd src && ls)", "", "true",
		"python3 -c 'print(1)'", "sh -c 'echo fixture failure >&2; exit 2'",
	]) {
		assert.equal(parseExploreCommand(command), undefined, command);
	}
});

test("Pi's own tools explore as the commands they stand for", () => {
	assert.deepEqual(exploreActions("read", { path: "src/app.ts" }), [read("app.ts")]);
	assert.deepEqual(exploreActions("read", { file_path: "docs/notes.md" }), [read("notes.md")]);
	assert.equal(exploreActions("read", {}), undefined, "a read whose path has not streamed in names nothing yet");
	assert.deepEqual(exploreActions("grep", { pattern: "TODO\nmore", path: "src" }), [{ kind: "search", query: "TODO", path: "src", command: "grep" }]);
	assert.deepEqual(exploreActions("find", { pattern: "*.ts" }), [{ kind: "search", query: "*.ts", path: undefined, command: "find" }]);
	assert.equal(exploreActions("grep", {}), undefined);
	assert.deepEqual(exploreActions("ls", {}), [{ kind: "list", path: undefined, command: "ls" }]);
	assert.deepEqual(exploreActions("ls", { path: "lib/" }), [{ kind: "list", path: "lib", command: "ls" }]);
	assert.deepEqual(exploreActions("bash", { command: "rg -n x src" })?.map((action) => action.kind), ["search"]);
	assert.deepEqual(exploreActions("powershell", { command: "cat README.md" }), [read("README.md")]);
	assert.equal(exploreActions("bash", { command: "npm test" }), undefined);
	assert.equal(exploreActions("bash", {}), undefined);
	for (const name of ["edit", "write", "web_search"]) assert.equal(exploreActions(name, { path: "a" }), undefined, name);
});

test("exploration lines merge consecutive reads and keep each failure on its own line", () => {
	const plain = (calls: Parameters<typeof exploreLines>[0]) => exploreLines(calls)
		.map((line) => `${line.verb} ${line.parts.map((part) => part.text).join("")}${line.failure?.text ?? ""}`);
	assert.deepEqual(plain([
		{ actions: [read("README.md")] }, { actions: [read("notes.md")] }, { actions: [read("README.md")] },
		{ actions: [{ kind: "search", query: "export", path: "src", command: "rg" }] },
		{ actions: [{ kind: "list", path: "docs", command: "ls docs" }] },
		{ actions: [{ kind: "list", command: "ls -la" }] },
		{ actions: [{ kind: "search", command: "rg --json" }] },
		{ actions: [read("util.ts")] },
	]), ["Read README.md, notes.md", "Search export in src", "List docs", "List ls -la", "Search rg --json", "Read util.ts"]);
	const failed = { text: " (exit 2)", quiet: false };
	assert.deepEqual(plain([
		{ actions: [read("a.ts")] }, { actions: [read("gone.ts")], failure: failed }, { actions: [read("b.ts")] }, { actions: [read("c.ts")] },
	]), ["Read a.ts", "Read gone.ts (exit 2)", "Read b.ts, c.ts"], "a failed read is never merged");
	assert.deepEqual(plain([{ actions: [{ kind: "list", command: "ls" }, read("a.ts")], failure: failed }]),
		["List ls", "Read a.ts (exit 2)"], "a compound command's failure ends its last line");
	const separators = exploreLines([{ actions: [read("a")] }, { actions: [read("b")] }])[0]!.parts;
	assert.deepEqual(separators.map((part) => part.dim === true), [false, true, false], "commas are dim");
	const search = exploreLines([{ actions: [{ kind: "search", query: "x", path: "lib", command: "rg" }] }])[0]!.parts;
	assert.deepEqual(search.map((part) => [part.text, part.dim === true]), [["x", false], [" in ", true], ["lib", false]]);
});

test("a command's exit code comes from Pi's status line, and a search's exit 1 is quiet", () => {
	assert.deepEqual(shellOutcome("fixture failure\n\n\nCommand exited with code 2"), { exitCode: 2, output: "fixture failure" });
	assert.deepEqual(shellOutcome("Command exited with code 1"), { exitCode: 1, output: "" });
	assert.deepEqual(shellOutcome("partial\n\nCommand timed out after 5 seconds"), { output: "partial\n\nCommand timed out after 5 seconds" },
		"a timeout keeps its line, the only place that says why");
	assert.deepEqual(shellOutcome("ok\r\n"), { output: "ok" });
	const search: ExploreAction = { kind: "search", query: "x", command: "rg x" };
	const list: ExploreAction = { kind: "list", command: "ls" };
	assert.deepEqual(exploreFailure("bash", "\n\nCommand exited with code 1", true, [search]), { text: " (exit 1)", quiet: true });
	assert.deepEqual(exploreFailure("bash", "cat: nope.txt\n\nCommand exited with code 1", true, [read("nope.txt")]), { text: " (exit 1)", quiet: false },
		"only a search's exit 1 is quiet");
	assert.deepEqual(exploreFailure("bash", "x\n\nCommand exited with code 2", true, [search]), { text: " (exit 2)", quiet: false });
	assert.deepEqual(exploreFailure("bash", "\n\nCommand exited with code 1", true, [list, search]), { text: " (command exit 1)", quiet: true },
		"a compound command has one exit code for all it did");
	assert.deepEqual(exploreFailure("bash", "Command aborted", true, [search]), { text: " (failed)", quiet: false });
	assert.deepEqual(exploreFailure("read", "ENOENT", true, [read("a")]), { text: " (failed)", quiet: false });
	assert.equal(exploreFailure("read", "ok", false, [read("a")]), undefined);
});

test("output tails and empty output read as Codex shows them", () => {
	assert.deepEqual(tailLines("1\n2\n3\n4\n5\n"), ["3", "4", "5"]);
	assert.deepEqual(tailLines("only"), ["only"]);
	assert.deepEqual(tailLines("a\r\nb"), ["a", "b"]);
	for (const empty of ["", "  \n", "(no output)", "\n(no output)\n"]) assert.equal(isEmptyOutput(empty), true, JSON.stringify(empty));
	assert.equal(isEmptyOutput("(no output) but more"), false);
});

test("commands are highlighted the same way on every Pi: program, flags, strings, variables, operators", async () => {
	const { highlightCommand } = await import("../extensions/compact-tools-codex-rows.ts");
	const marked = { fg: (color: string, text: string) => `<${color}>${text}</>` } as never;
	assert.deepEqual(highlightCommand("rg -n 'export' src | head -n 5 && echo \"$HOME\" # done", marked), [
		"<syntaxFunction>rg</> <syntaxKeyword>-n</> <syntaxString>'export'</> src <syntaxOperator>|</> <syntaxFunction>head</> "
		+ "<syntaxKeyword>-n</> <syntaxNumber>5</> <syntaxOperator>&&</> <syntaxFunction>echo</> <syntaxString>\"$HOME\"</> <syntaxComment># done</>",
	]);
	assert.deepEqual(highlightCommand("FOO=1 make ${TARGET} > out.log 2>&1", marked), [
		"FOO=1 <syntaxFunction>make</> <syntaxVariable>${TARGET}</> <syntaxOperator>></> out.log <syntaxNumber>2</><syntaxOperator>>&</><syntaxNumber>1</>",
	], "an assignment is not the program; a redirection does not start a command");
	assert.deepEqual(highlightCommand("echo 'one\ntwo'\nls", marked), [
		"<syntaxFunction>echo</> <syntaxString>'one</>", "<syntaxString>two'</>", "<syntaxFunction>ls</>",
	], "a string over two lines keeps its color on each, and a new line starts a command");
	assert.deepEqual(highlightCommand("echo \"unterminated", marked), ["<syntaxFunction>echo</> <syntaxString>\"unterminated</>"]);
	assert.deepEqual(highlightCommand("", marked), [""]);
});

test("wrapping keeps a grapheme whole and measures it by the columns it takes", async () => {
	const { wrapSegments } = await import("../extensions/compact-tools-codex.ts");
	const rows = (text: string, width: number) => wrapSegments([{ text }], width, width).map((row) => row.map((part) => part.text).join(""));
	assert.deepEqual(rows("👩‍💻 dev", 2), ["👩‍💻", "de", "v"], "a joined emoji is one glyph two columns wide");
	assert.deepEqual(rows("🇰🇷🇯🇵", 2), ["🇰🇷", "🇯🇵"], "a flag is one glyph");
	assert.deepEqual(rows("ééé", 2), ["éé", "é"], "a combining accent stays on its letter");
	assert.deepEqual(rows("漢字かな", 3), ["漢", "字", "か", "な"], "a wide glyph never splits across rows");
	assert.deepEqual(rows("a b c", 3), ["a b", "c"]);
});

test("a pattern over several lines shows its first line and that more follows", () => {
	const line = exploreLines([{ actions: parseExploreCommand("rg 'one\ntwo' src")! }])[0]!;
	assert.deepEqual(line.parts.map((part) => part.text), ["one …", " in ", "src"]);
});
