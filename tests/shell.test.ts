/**
 * Both summary styles fold a command that only looks around into a group that hides
 * it. These pin the guarantee that makes that safe: a command that writes a file or
 * runs another program is never folded, in either style, and quoting is read the
 * way the shell reads it.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { classifyShellCommand } from "../extensions/compact-tools-claude.ts";
import { parseExploreCommand } from "../extensions/compact-tools-codex.ts";
import { isHarmlessRedirect, parseShell, writesOrRuns } from "../extensions/compact-tools-shell.ts";

/** Commands that name a program that usually only reads, yet change the disk or run something else. */
const WRITES_OR_RUNS = [
	"cat README.md | xargs rm -f",
	"find . -name '*.log' | xargs rm",
	"cat README.md | tee copied.md",
	"rg TODO src | tee todos.txt",
	"find . -delete",
	"find . -name x -exec rm {} \\;",
	"find . -execdir mv {} {}.bak +",
	"find . -ok rm {} \\;",
	"find . -fprint list.txt",
	"fd tmp -x rm",
	"fd tmp -X rm",
	"fd tmp --exec rm",
	"fd tmp --exec-batch rm",
	"rg --pre ./decrypt.sh secret",
	"rg --pre=./decrypt.sh secret",
	"sort -o sorted.txt input.txt",
	"sort -no sorted.txt input.txt",
	"sort --output=sorted.txt input.txt",
	"uniq input.txt output.txt",
	"tree -o tree.txt",
	"sed -i 's/a/b/' file.txt",
	"sed -i.bak 's/a/b/' file.txt",
	"sed --in-place s/a/b/ file.txt",
	"ls | sed --in-place s/a/b/ file.txt",
	"sed -n -e 1p -e 'w copy.txt' original.txt",
	"sed -n '1,5w out.txt' file.txt",
	"sed -n 's/a/b/w out.txt' file.txt",
	"sed -n '1e date' file.txt",
	"sed -n -f script.sed file.txt",
	"cat in.txt | sed -n -e'w out.txt'",
	"sed -ne 'w out.txt' in.txt",
	"sed -n -e1w\\ out.txt in.txt",
	"sed -nfscript.sed in.txt",
	"git grep -O hello",
	"git grep -nO hello",
	"git grep --open-files-in-pager='sh -c x' hello",
	"git -c core.pager='sh -c x' grep hello",
	"ag --pager 'sh -c x' foo",
	"ack --pager='sh -c x' foo",
	"bat --pager 'sh -c x' README.md",
	"sort --compress-program=gzip big.txt",
	"rg --hostname-bin ./hostname foo",
	"awk 'BEGIN { system(\"rm x\") }'",
	"awk '{ print > \"out.txt\" }' in.txt",
	"awk '{ print | \"sh\" }' in.txt",
	"awk -f prog.awk in.txt",
	"cat a > b",
	"cat a >> b",
	"rg x src &> out.txt",
	"cat $(rm -rf build)",
	"cat `rm -rf build`",
	"cat \"$(rm -rf build)\"",
	"diff <(ls a) <(ls b)",
	"(cd src && rm -rf build)",
	"ls & rm -rf build",
	"cat <<EOF\nrm -rf build\nEOF",
];

test("no command that writes or runs something folds into a group, in either style", () => {
	for (const command of WRITES_OR_RUNS) {
		assert.equal(parseExploreCommand(command), undefined, `codex: ${command}`);
		assert.equal(classifyShellCommand(command), undefined, `claude: ${command}`);
	}
});

test("what only reads still folds: a search that drops errors, a numbered sed print, formatting stages", () => {
	assert.equal(classifyShellCommand("rg x src 2>/dev/null"), "search", "output thrown away writes nothing");
	assert.equal(classifyShellCommand("rg x src 2>&1 | head -n 5"), "search", "joining two streams writes nothing");
	assert.equal(classifyShellCommand("rg x src >/dev/null 2>&1"), "search");
	assert.equal(classifyShellCommand("cat a.ts | sort | uniq"), "read");
	assert.equal(classifyShellCommand("awk '{ print $1 }' a.txt"), "read");
	assert.equal(classifyShellCommand("sort -n a.txt"), "read");
	assert.equal(classifyShellCommand("find . -name '*.ts'"), "search");
	assert.deepEqual(parseExploreCommand("sed -n 1,20p a.ts")?.map((action) => action.kind), ["read"]);
	assert.deepEqual(parseExploreCommand("sed -n -e 5p a.ts")?.map((action) => action.kind), ["read"], "-e with a print script still reads");
	assert.equal(parseExploreCommand("sed -ne 5p a.ts"), undefined, "Codex reads a sed print only with a separate -n");
	assert.deepEqual(parseExploreCommand("git grep -n needle")?.map((action) => action.kind), ["search"], "a git grep that opens no pager searches");
	assert.equal(classifyShellCommand("ag foo src"), "search");
	assert.equal(classifyShellCommand("sort -u a.txt"), "read");
	assert.deepEqual(parseExploreCommand("sed -n 's/a/b/p' a.ts"), undefined, "a substitution is not one of Codex's reads");
	assert.deepEqual(parseExploreCommand("rg TODO src | sort | uniq -c")?.map((action) => action.kind), ["search"]);
	assert.deepEqual(parseExploreCommand("find . -name '*.ts' | head -n 3")?.map((action) => action.kind), ["search"]);
	// Codex reads only plain words; a redirection, even to /dev/null, is a command it ran.
	assert.equal(parseExploreCommand("rg x src 2>/dev/null"), undefined);
});

test("quotes keep what is inside them: a quoted semicolon, pipe, or newline is text", () => {
	assert.deepEqual(parseExploreCommand('rg ";" src'), [{ kind: "search", query: ";", path: "src", command: "rg ; src" }]);
	assert.deepEqual(parseExploreCommand("rg 'a|b' src")?.map((action) => action.kind), ["search"]);
	assert.deepEqual(parseExploreCommand("rg 'a && b' src")?.map((action) => action.kind), ["search"]);
	assert.deepEqual(parseExploreCommand("rg 'one\ntwo' src"), [{ kind: "search", query: "one\ntwo", path: "src", command: "rg one\ntwo src" }],
		"a quoted newline stays in the pattern");
	assert.deepEqual(parseExploreCommand("rg a\nrg b")?.map((action) => action.kind), ["search", "search"], "an unquoted newline ends a command");
	assert.equal(classifyShellCommand('rg ";" src'), "search");
	assert.equal(classifyShellCommand("rg 'one\ntwo' src"), "search");
	assert.equal(classifyShellCommand('grep "a;rm -rf x" src'), "search", "a quoted command is only a pattern");
});

test("the shell is split the way it splits itself", () => {
	const words = (source: string) => parseShell(source)?.commands.map((command) => command.words);
	assert.deepEqual(words("rg -n 'export default' src"), [["rg", "-n", "export default", "src"]]);
	assert.deepEqual(words('echo "a \\"b\\" c" d'), [["echo", 'a "b" c', "d"]]);
	assert.deepEqual(words("echo a\\ b"), [["echo", "a b"]], "an escaped space joins words");
	assert.deepEqual(words("rg x \\\n  src"), [["rg", "x", "src"]], "a backslash before a newline continues the line");
	assert.deepEqual(words("ls # list it; then nothing"), [["ls"]], "a comment runs to the end of its line");
	assert.deepEqual(words("a#b"), [["a#b"]], "a hash inside a word is not a comment");
	assert.deepEqual(words("a&&b||c;d|e|&f"), [["a"], ["b"], ["c"], ["d"], ["e"], ["f"]]);
	assert.deepEqual(words("''"), [[""]], "an empty quoted word is still a word");
	assert.deepEqual(parseShell("rg x 2>&1 >/dev/null <in.txt")?.commands[0]?.redirects, [
		{ operator: "2>&", target: "1" }, { operator: ">", target: "/dev/null" }, { operator: "<", target: "in.txt" },
	]);
	assert.deepEqual(parseShell("echo 12>out")?.commands[0], { words: ["echo"], redirects: [{ operator: "12>", target: "out" }] });
	assert.deepEqual(parseShell("echo a2>out")?.commands[0], { words: ["echo", "a2"], redirects: [{ operator: ">", target: "out" }] },
		"only a word of digits names a descriptor");
	for (const opaque of ["cat $(ls)", "cat `ls`", 'echo "$(ls)"', "diff <(a) <(b)", "(ls)", "sleep 1 &"]) {
		assert.equal(parseShell(opaque)?.opaque, true, opaque);
	}
	assert.equal(parseShell("echo $HOME ${PATH}")?.opaque, false, "a variable is read, not run");
	for (const broken of ["echo 'open", 'echo "open', "cat <<EOF\nx\nEOF", "cat >", "cat > | x"]) {
		assert.equal(parseShell(broken), undefined, broken);
	}
});

test("a redirection is harmless only when it throws output away or joins two streams", () => {
	assert.equal(isHarmlessRedirect({ operator: ">", target: "/dev/null" }), true);
	assert.equal(isHarmlessRedirect({ operator: "2>", target: "/dev/null" }), true);
	assert.equal(isHarmlessRedirect({ operator: "&>", target: "/dev/null" }), true);
	assert.equal(isHarmlessRedirect({ operator: "2>&", target: "1" }), true);
	assert.equal(isHarmlessRedirect({ operator: ">&", target: "-" }), true);
	assert.equal(isHarmlessRedirect({ operator: ">", target: "out.txt" }), false);
	assert.equal(isHarmlessRedirect({ operator: ">>", target: "/dev/null2" }), false);
	assert.equal(isHarmlessRedirect({ operator: ">&", target: "out.txt" }), false, "`>&file` writes the file");
	assert.equal(isHarmlessRedirect({ operator: "<", target: "/dev/null" }), false);
});

test("a program that usually reads is caught when its options make it write or run", () => {
	for (const words of [["xargs"], ["tee"], ["find", ".", "-delete"], ["fd", "x", "--exec=rm"], ["sort", "-ro", "x"], ["uniq", "-c", "a", "b"],
		["sed", "-ni", "1p", "a"], ["sed", "--expression=w x", "a"], ["awk", "-v", "x=1", "{ system(x) }"]]) {
		assert.equal(writesOrRuns(words), true, words.join(" "));
	}
	for (const words of [["find", ".", "-name", "x"], ["fd", "x"], ["rg", "-r", "y", "x"], ["sort", "-r", "x"], ["uniq", "-c", "a"],
		["sed", "-n", "1p", "a"], ["sed", "s/we/us/g"], ["sed", "-n", "/write/p", "a"], ["awk", "-F", ":", "{ print $1 }", "a"], ["tree", "-L", "2"], ["cat", "x"]]) {
		assert.equal(writesOrRuns(words), false, words.join(" "));
	}
});
