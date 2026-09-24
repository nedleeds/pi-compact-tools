import { closeSync, mkdirSync, openSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { getAgentDir, type ExtensionContext } from "@earendil-works/pi-coding-agent";

// release-notes.json must contain an entry for the shipped package version.
function releaseNotes(version: string): readonly string[] | undefined {
	const entries = JSON.parse(readFileSync(new URL("../release-notes.json", import.meta.url), "utf8")) as Record<string, string[]>;
	return entries[version];
}

export function installedVersion(): string {
	const manifest = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { version: string };
	return manifest.version;
}

/** A one-time transcript status, styled with Pi's own dim (dark-gray) status color. */
export function showReleaseNotice(
	ctx: ExtensionContext,
	version = installedVersion(),
	agentDir = getAgentDir(),
): boolean {
	if (ctx.mode !== "tui" || !/^\d+\.\d+\.\d+(?:[-+][\w.-]+)?$/.test(version)) return false;
	let notes: readonly string[] | undefined;
	try {
		notes = releaseNotes(version);
	} catch {
		return false;
	}
	if (!notes?.length) return false;
	const directory = join(agentDir, "compact-tools-notices");
	const marker = join(directory, version);
	try {
		mkdirSync(directory, { recursive: true });
		// Exclusive creation also prevents two Pi processes from showing it twice.
		const fd = openSync(marker, "wx");
		closeSync(fd);
	} catch {
		// Already seen, or state can't be stored: don't repeatedly interrupt startup.
		return false;
	}
	ctx.ui.notify(`pi-compact-tools updated to v${version}\n${notes.map((note) => `  • ${note}`).join("\n")}`, "info");
	return true;
}
