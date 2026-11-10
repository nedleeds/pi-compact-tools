import { chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { dirname, join } from "node:path";
import { CONFIG_DIR_NAME, getAgentDir, type ExtensionAPI, type ExtensionContext, type ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { DISPLAY_STYLES, type CompactToolsConfig, type DisplayStyle } from "./compact-tools-types.ts";
import { loadConfig } from "./compact-tools-config.ts";
import { chooseToolDisplay } from "./compact-tools-chooser.ts";

type Scope = "global" | "project";
type DisplaySetting = "thinking" | "working";
const DISPLAY_SETTINGS = ["thinking", "working"] as const;
const DISPLAY_VALUES = ["native", "styled"] as const;
const SETTING_CHOICES: Record<DisplaySetting, string> = {
	thinking: "Thinking display — native or styled",
	working: "Working indicator — native or styled",
};
const SCOPES: readonly Scope[] = ["global", "project"];
const HELP = "Usage: /compact-tools [compact|claude|codex|off] [global|project]\nWithout a scope the style is saved globally, or to this project when its settings choose the style.\n/compact-tools status · /compact-tools help\nCtrl+O expands rows; /silent toggles quiet mode. All styles, including off, switch at once, even while tools run.";
const DISPLAY_HELP = "Usage: /compact-tools thinking|working [native|styled] [global|project]\nNative preserves Pi's display; styled enables the extension's override. Silent mode still hides these displays.\nWithout a scope, saves where that setting is configured. Changes apply live; the tool style stays unchanged.";
const BUSY = "Wait for the current response to finish before changing tool styles.";
const CHOICES: Record<DisplayStyle, string> = {
	compact: "Compact — one expandable row per tool call",
	claude: "Claude — group reads and searches",
	codex: "Codex — explored groups and output tails, like Codex CLI",
	off: "Off — restore Pi's native UI",
};

export function configPath(cwd: string, scope: Scope): string {
	return scope === "global" ? join(getAgentDir(), "compact-tools.json")
		: join(cwd, CONFIG_DIR_NAME, "compact-tools.json");
}

/** Preserve unrelated and future settings. Never overwrite a malformed file. */
export function saveStyle(path: string, style: DisplayStyle): void {
	saveSettings(path, { style });
}

function saveSettings(path: string, settings: Partial<Pick<CompactToolsConfig, "style" | DisplaySetting>>): void {
	let linked = false;
	try {
		linked = lstatSync(path).isSymbolicLink();
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
	}
	// Update dotfiles-managed targets without replacing the link. A dangling link
	// is an error, not permission to silently disconnect it.
	if (linked) path = realpathSync(path);
	let data: Record<string, unknown> = {};
	let mode = 0o600;
	try {
		const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
		if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
			throw new Error("expected a JSON object");
		}
		data = parsed as Record<string, unknown>;
		mode = statSync(path).mode & 0o777;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
	}
	mkdirSync(dirname(path), { recursive: true });
	// Beside the target so the rename stays atomic, and short so a long target name still fits.
	const temporary = join(dirname(path), `.compact-tools-${randomUUID()}.tmp`);
	try {
		writeFileSync(temporary, `${JSON.stringify({ ...data, ...settings }, null, 2)}\n`, { mode: 0o600, flag: "wx" });
		// The creation mode passes through the umask; set the original mode exactly.
		chmodSync(temporary, mode);
		renameSync(temporary, path);
	} finally {
		rmSync(temporary, { force: true });
	}
}

/** Whether a trusted project's own settings choose the style, which then outranks the global one. */
function projectSetsStyle(cwd: string, trusted: boolean, key: "style" | DisplaySetting = "style"): boolean {
	if (!trusted) return false;
	try {
		const parsed: unknown = JSON.parse(readFileSync(configPath(cwd, "project"), "utf8"));
		return !!parsed && typeof parsed === "object" && !Array.isArray(parsed) && key in parsed;
	} catch {
		return false;
	}
}

function describePath(path: string): string {
	return `${path} (${existsSync(path) ? "exists" : "not created"})`;
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

/**
 * Draw the saved style in place, without a reload, and say whether it could: a switch
 * between any style, including native/off, changes only UI routing. It applies
 * at once while a response runs, with no tool registry or transcript changes.
 */
export type ApplyStyle = (cwd: string, trusted: boolean, ctx: ExtensionContext) => boolean;

async function changeDisplaySetting(
	key: DisplaySetting,
	parts: string[],
	ctx: ExtensionCommandContext,
	getConfig: () => CompactToolsConfig,
	applyStyle?: ApplyStyle,
): Promise<void> {
	if (parts.length > 2 || (parts[0] !== undefined && !DISPLAY_VALUES.includes(parts[0] as typeof DISPLAY_VALUES[number]))
		|| (parts[1] !== undefined && !SCOPES.includes(parts[1] as Scope))) {
		ctx.ui.notify(DISPLAY_HELP, "warning");
		return;
	}
	if (!applyStyle && !ctx.isIdle()) {
		ctx.ui.notify(BUSY, "warning");
		return;
	}
	let value = parts[0];
	let scope = parts[1] as Scope | undefined;
	const projectDecides = projectSetsStyle(ctx.cwd, ctx.isProjectTrusted(), key);
	if (value === undefined) {
		if (ctx.mode !== "tui") { ctx.ui.notify(DISPLAY_HELP, "info"); return; }
		const selected = await ctx.ui.select(`${key === "thinking" ? "Thinking display" : "Working indicator"} (current: ${getConfig()[key] ? "styled" : "native"})`, [
			"Native — preserve Pi's display", "Styled — use compact-tools display",
		]);
		if (selected === undefined) return;
		value = selected.startsWith("Native") ? "native" : "styled";
		const scopes = projectDecides
			? ["Project — this trusted project only", "Global — all projects (this project keeps its own setting)"]
			: ["Global — all projects", ...(ctx.isProjectTrusted() ? ["Project — this trusted project only"] : [])];
		const selectedScope = await ctx.ui.select(`Save ${key} where?`, scopes);
		if (selectedScope === undefined) return;
		scope = selectedScope.startsWith("Project") ? "project" : "global";
	}
	scope ??= projectDecides ? "project" : "global";
	if (scope === "project" && !ctx.isProjectTrusted()) {
		ctx.ui.notify("Project settings require a trusted project. No file was changed.", "warning");
		return;
	}
	if (!applyStyle && !ctx.isIdle()) { ctx.ui.notify(BUSY, "warning"); return; }
	try {
		saveSettings(configPath(ctx.cwd, scope), { [key]: value === "styled" });
	} catch (error) {
		ctx.ui.notify(`Could not save ${key}: ${errorMessage(error)}. No settings were replaced.`, "error");
		return;
	}
	const effective = loadConfig(ctx.cwd, ctx.isProjectTrusted());
	const where = scope === "project" ? "this project" : "global settings";
	if (scope === "global" && effective[key] !== (value === "styled")) {
		ctx.ui.notify(`Saved ${key} ${value} to global settings, but this project keeps its own ${key} setting. Run /compact-tools ${key} ${value} to switch it here.`, "warning");
		return;
	}
	if (applyStyle?.(ctx.cwd, ctx.isProjectTrusted(), ctx)) {
		ctx.ui.notify(`Switched ${key} to ${value} (saved to ${where}).`, "info");
		return;
	}
	if (!ctx.isIdle()) {
		ctx.ui.notify(`Saved ${key} ${value} to ${where}. Run /reload once the response finishes.`, "warning");
		return;
	}
	ctx.ui.notify(`Switching ${key} to ${value} (saved to ${where}). Reloading…`, "info");
	const ui = ctx.ui;
	try { await ctx.reload(); }
	catch (error) { ui.notify(`Setting was saved, but reload failed: ${errorMessage(error)}. Run /reload to apply it.`, "error"); }
}

export function registerCompactToolsCommand(pi: ExtensionAPI, getConfig: () => CompactToolsConfig, applyStyle?: ApplyStyle): void {
	pi.registerCommand("compact-tools", {
		description: "Choose tool rows, native/styled thinking and working displays, or show settings",
		getArgumentCompletions: (prefix) => {
			const typed = prefix.trimStart().toLowerCase();
			const parts = typed.split(/\s+/);
			const scoped = parts.length === 2 && DISPLAY_STYLES.includes(parts[0] as DisplayStyle);
			const setting = DISPLAY_SETTINGS.find((key) => key === parts[0]);
			const settingValues = setting && parts.length === 2
				? DISPLAY_VALUES.map((value) => `${setting} ${value}`)
				: setting && parts.length === 3 && DISPLAY_VALUES.includes(parts[1] as typeof DISPLAY_VALUES[number])
					? SCOPES.map((scope) => `${setting} ${parts[1]} ${scope}`)
					: undefined;
			const values = settingValues ?? (scoped ? SCOPES.map((scope) => `${parts[0]} ${scope}`) : [...DISPLAY_STYLES, ...DISPLAY_SETTINGS, "status", "help"]);
			// Pi applies a shown completion on Enter instead of running the command, so a value already
			// typed in full is not offered again: Enter then runs it the first time.
			const items = values.filter((value) => value.startsWith(typed) && value !== typed.trimEnd()).map((value) => ({ value, label: value }));
			return items.length ? items : null;
		},
		handler: async (args, ctx) => {
			const parts = args.trim() ? args.trim().toLowerCase().split(/\s+/) : [];
			if (parts.length === 1 && parts[0] === "help") {
				ctx.ui.notify(`${HELP}\n${DISPLAY_HELP}`, "info");
				return;
			}
			if (parts.length === 1 && parts[0] === "status") {
				const config = getConfig();
				ctx.ui.notify([
					`Style: ${config.style} · configured mode: ${config.mode} · preview: ${config.previewLines} lines`,
					`Thinking display: ${config.thinking ? "styled" : "native"} · working indicator: ${config.working ? "styled" : "native"}`,
					`Global: ${describePath(configPath(ctx.cwd, "global"))}`,
					`Project: ${describePath(configPath(ctx.cwd, "project"))} (${ctx.isProjectTrusted() ? "trusted; overrides global" : "untrusted; ignored"})`,
					"/silent is a session toggle; Ctrl+O expands rows.",
				].join("\n"), "info");
				return;
			}
			const setting = DISPLAY_SETTINGS.find((key) => key === parts[0]);
			if (setting) {
				await changeDisplaySetting(setting, parts.slice(1), ctx, getConfig, applyStyle);
				return;
			}
			if (parts.length > 2 || (parts.length > 0 && !DISPLAY_STYLES.includes(parts[0] as DisplayStyle))
				|| (parts[1] !== undefined && !SCOPES.includes(parts[1] as Scope))) {
				ctx.ui.notify(HELP, "warning");
				return;
			}
			// Only a host/integration without live UI routing requires an idle reload.
			const named = parts[0] as DisplayStyle | undefined;
			if (named && !ctx.isIdle() && !applyStyle) {
				ctx.ui.notify(BUSY, "warning");
				return;
			}
			let style = named;
			// Unnamed, the style is saved where it is decided: a trusted project that sets one would
			// otherwise outrank a global save, and the switch would seem to do nothing.
			let scope: Scope = (parts[1] as Scope | undefined) ?? (projectSetsStyle(ctx.cwd, ctx.isProjectTrusted()) ? "project" : "global");
			if (!style) {
				if (ctx.mode !== "tui") {
					ctx.ui.notify(HELP, "info");
					return;
				}
				const selected = await chooseToolDisplay(ctx, `Tool style and displays (current: ${getConfig().style})`, Object.values(CHOICES), Object.values(SETTING_CHOICES));
				const selectedSetting = DISPLAY_SETTINGS.find((key) => SETTING_CHOICES[key] === selected);
				if (selectedSetting) {
					await changeDisplaySetting(selectedSetting, [], ctx, getConfig, applyStyle);
					return;
				}
				style = DISPLAY_STYLES.find((value) => CHOICES[value] === selected);
				if (!style) return;
				// A project that sets its own style outranks a global save, so it is offered first and the global
				// choice says it will not show here.
				const projectDecides = projectSetsStyle(ctx.cwd, ctx.isProjectTrusted());
				const scopes = projectDecides
					? ["Project — this trusted project only", "Global — all projects (this project keeps its own style)"]
					: ["Global — all projects", ...(ctx.isProjectTrusted() ? ["Project — this trusted project only"] : [])];
				const selectedScope = await ctx.ui.select("Save style where?", scopes);
				if (!selectedScope) return;
				scope = selectedScope.startsWith("Project") ? "project" : "global";
			}
			if (scope === "project" && !ctx.isProjectTrusted()) {
				ctx.ui.notify("Project settings require a trusted project. No file was changed.", "warning");
				return;
			}
			// The agent may have started while the user was choosing in a dialog.
			const reloads = !applyStyle;
			if (reloads && !ctx.isIdle()) {
				ctx.ui.notify(BUSY, "warning");
				return;
			}
			const path = configPath(ctx.cwd, scope);
			try {
				saveStyle(path, style);
			} catch (error) {
				ctx.ui.notify(`Could not save ${path}: ${errorMessage(error)}. No settings were replaced.`, "error");
				return;
			}
			const effective = loadConfig(ctx.cwd, ctx.isProjectTrusted()).style;
			const where = scope === "project" ? "this project" : "global settings";
			// Paths stay out of these lines, which Pi keeps in the chat; /compact-tools status shows them.
			if (scope === "global" && effective !== style) {
				// Saved, but this project's own style still decides what is drawn here: nothing switches.
				ctx.ui.notify(`Saved ${style} to global settings, but this project keeps its own ${effective} style. Run /compact-tools ${style} to switch it here.`, "warning");
				return;
			}
			if (!reloads && applyStyle!(ctx.cwd, ctx.isProjectTrusted(), ctx)) {
				ctx.ui.notify(`Switched to ${style} style (saved to ${where}).`, "info");
				return;
			}
			if (!ctx.isIdle()) {
				ctx.ui.notify(`Saved ${style} style to ${where}. It applies once the response finishes; run /reload then.`, "warning");
				return;
			}
			ctx.ui.notify(style === "off"
				? `Restoring Pi's native UI (saved to ${where}). Reloading…`
				: `Switching to ${style} style (saved to ${where}). Reloading…`, "info");
			// Reloading makes this ctx stale, so a failure is reported through the UI held from before.
			const ui = ctx.ui;
			try {
				await ctx.reload();
			} catch (error) {
				ui.notify(`Style was saved, but reload failed: ${errorMessage(error)}. Run /reload to apply it.`, "error");
			}
		},
	});
}
