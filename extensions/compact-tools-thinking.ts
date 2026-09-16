import { getAgentDir, type ExtensionAPI, type ExtensionContext, type Theme } from "@earendil-works/pi-coding-agent";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
	isKeyRelease,
	isKeyRepeat,
	Key,
	matchesKey,
	stripTerminalSequences,
	truncateToWidth,
	wrapTextWithAnsi,
} from "@earendil-works/pi-tui";

export type ThinkingView = "summary" | "detail" | "hidden";
export type ThinkingPhase = "summary" | "detail" | "summary-after-detail" | "hidden";

type ThinkingRenderOptions = {
	styleSummary?: (summary: string, sectionIndex: number) => string;
	styleDetailPrefix?: (prefix: string) => string;
	controls?: string | ((hasDetail: boolean) => string | undefined);
	styleControlPrefix?: (prefix: string) => string;
};

const NEXT_PHASE: Record<ThinkingPhase, ThinkingPhase> = {
	summary: "detail",
	detail: "summary-after-detail",
	"summary-after-detail": "hidden",
	hidden: "summary",
};

export function thinkingViewForPhase(phase: ThinkingPhase): ThinkingView {
	return phase === "summary-after-detail" ? "summary" : phase;
}

export function nextThinkingPhase(phase: ThinkingPhase): ThinkingPhase {
	return NEXT_PHASE[phase];
}

export type ThinkingToggleInput = "toggle" | "repeat" | "release";

export function classifyThinkingToggleInput(data: string): ThinkingToggleInput | undefined {
	if (!matchesKey(data, Key.ctrl("t"))) return undefined;
	if (isKeyRelease(data)) return "release";
	return isKeyRepeat(data) ? "repeat" : "toggle";
}

function plainSummary(line: string): string {
	return line
		.replace(/^\s{0,3}#{1,6}\s+/u, "")
		.replace(/^\s*[-*+]\s+/u, "")
		.replace(/\[([^\]]+)\]\([^)]*\)/gu, "$1")
		.replace(/[*_~`]/gu, "")
		.replace(/\s+/gu, " ")
		.trim();
}

type ThinkingSection = { summary: string; detail: string };

function splitThinkingSections(markdown: string): ThinkingSection[] {
	const normalized = markdown.includes("\r") ? markdown.replace(/\r\n?/gu, "\n") : markdown;
	const lines = normalized.split("\n");
	let first = -1;
	let summary = "";
	for (let index = 0; index < lines.length; index++) {
		summary = plainSummary(lines[index]!);
		if (summary) {
			first = index;
			break;
		}
	}
	if (first < 0) return [{ summary: "Thinking...", detail: "" }];
	const sections: ThinkingSection[] = [];
	let detail: string[] = [];
	let inFence = false;
	const flush = () => {
		sections.push({ summary, detail: detail.join("\n").trim() });
		detail = [];
	};
	for (let index = first + 1; index < lines.length; index++) {
		const line = lines[index]!;
		const fence = /^\s*(```|~~~)/u.test(line);
		if (!inFence) {
			const boldHeading = line.match(/^\s*\*\*(.+?)\*\*\s*$/u)?.[1];
			const markdownHeading = line.match(/^\s{0,3}#{1,6}\s+(.+?)\s*$/u)?.[1];
			const heading = boldHeading ?? markdownHeading;
			if (heading) {
				flush();
				summary = plainSummary(heading);
				continue;
			}
		}
		detail.push(line);
		if (fence) inFence = !inFence;
	}
	flush();
	return sections;
}

function compactDetail(
	detail: string,
	availableWidth: number,
	stylePrefix: (prefix: string) => string,
): string {
	const output: string[] = [];
	let inFence = false;
	for (const logicalLine of detail.replace(/\t/gu, "   ").split("\n")) {
		const fence = /^\s*(```|~~~)/u.test(logicalLine);
		if (!inFence && fence) {
			// Fences need a real blockquote and blank delimiter to remain valid Markdown.
			output.push("", `> ${logicalLine}`);
			inFence = true;
			continue;
		}
		if (inFence) {
			output.push(logicalLine ? `> ${logicalLine}` : ">");
			if (fence) {
				inFence = false;
				output.push("");
			}
			continue;
		}
		if (!logicalLine) {
			output.push(`${stylePrefix("│")}  `);
			continue;
		}
		const wrapped = wrapTextWithAnsi(logicalLine, Math.max(1, availableWidth - 2));
		for (const line of wrapped) {
			output.push(`${stylePrefix("│ ")}${stripTerminalSequences(line)}  `);
		}
	}
	return output.join("\n");
}

function hardBreak(lines: string[]): string {
	return lines.map((line, index) => (index < lines.length - 1 ? `${line}  ` : line)).join("\n");
}

export function hasThinkingDetail(markdown: string): boolean {
	return splitThinkingSections(markdown).some(({ detail }) => detail.length > 0);
}

/** Display-only transformation; the original thinking remains unchanged in session/model context. */
export function renderThinkingView(
	markdown: string,
	view: ThinkingView,
	availableWidth: number,
	options: ThinkingRenderOptions = {},
): string {
	if (view === "hidden") return "Thinking...";
	const controls = options.controls ?? ((hasDetail: boolean) =>
		hasDetail ? "ctrl+t toggle • click to hide" : undefined);
	const styleControlPrefix = options.styleControlPrefix ?? ((prefix: string) => prefix);
	return splitThinkingSections(markdown)
		.map(({ summary, detail }, sectionIndex) => {
			const fittedSummary = stripTerminalSequences(
				truncateToWidth(summary, Math.max(1, availableWidth), "…"),
			);
			const title = options.styleSummary?.(fittedSummary, sectionIndex) ?? fittedSummary;
			const sectionControls = typeof controls === "function" ? controls(detail.length > 0) : controls;
			const controlLines = sectionControls
				? wrapTextWithAnsi(sectionControls, Math.max(1, availableWidth - 3)).map(
						(line, index) => `${index === 0 ? styleControlPrefix("└─ ") : "   "}${line}`,
					)
				: [];
			if (view === "detail" && detail) {
				const styleDetailPrefix = options.styleDetailPrefix ?? ((prefix: string) => prefix);
				const connector = `${styleDetailPrefix("│")}  `;
				const detailOutput = `${title}  \n${connector}\n${compactDetail(detail, availableWidth, styleDetailPrefix)}`;
				return controlLines.length > 0 ? `${detailOutput}\n${hardBreak(controlLines)}` : detailOutput;
			}
			return hardBreak([title, ...controlLines]);
		})
		.join("\n\n");
}

function getInitialThinkingPhase(): ThinkingPhase {
	try {
		const settings = JSON.parse(readFileSync(join(getAgentDir(), "settings.json"), "utf8")) as {
			hideThinkingBlock?: unknown;
		};
		return settings.hideThinkingBlock === true ? "hidden" : "summary";
	} catch {
		return "summary";
	}
}

export function isThinkingStreamEvent(eventType: string): boolean {
	return eventType === "thinking_start" || eventType === "thinking_delta";
}

const SHIMMER_FRAME_INTERVAL_MS = 80;

function shimmer(summary: string, theme: Theme, startedAt: number): string {
	const characters = [...summary];
	if (characters.length === 0) return summary;
	const sweepTail = 5;
	// Each logical section receives its own start time. The highlight therefore
	// enters at its first character instead of inheriting another section's
	// wall-clock phase.
	const elapsed = Math.max(0, Date.now() - startedAt);
	const center = Math.floor(elapsed / SHIMMER_FRAME_INTERVAL_MS) % (characters.length + sweepTail);
	let currentColor: Parameters<Theme["fg"]>[0] | undefined;
	let chunk = "";
	let output = "";
	for (let index = 0; index < characters.length; index++) {
		const distance = Math.abs(index - center);
		// Stay entirely in the sky-blue family: the active baseline is blue,
		// and the sweep fades through light blue into a near-white core.
		const color = distance === 0
			? "userMessageText"
			: distance === 1
				? "text"
				: distance === 2
					? "thinkingMax"
					: "thinkingXhigh";
		if (currentColor !== undefined && color !== currentColor) {
			output += theme.fg(currentColor, theme.bold(chunk));
			chunk = "";
		}
		currentColor = color;
		chunk += characters[index];
	}
	return currentColor === undefined ? output : output + theme.fg(currentColor, theme.bold(chunk));
}

export class ThinkingCycleController {
	private phase: ThinkingPhase = "summary";
	private unsubscribe: (() => void) | undefined;
	private theme: Theme | undefined;
	private thinkingStreamActive = false;
	private hasToggleableThinking = false;
	private refreshThinking: (() => void) | undefined;
	private readonly summarySweepStartedAt = new Map<number, number>();

	constructor(pi: ExtensionAPI) {
		pi.on("message_start", () => this.resetSweep());
		pi.on("message_update", (event) => {
			// `context.isStreaming` describes the whole assistant message. Tool-call
			// argument streaming therefore remains true after thinking has ended.
			// Track the actual provider event so the sweep ends on thinking_end.
			const eventType = event.assistantMessageEvent.type;
			if (eventType === "thinking_start") this.summarySweepStartedAt.clear();
			this.thinkingStreamActive = isThinkingStreamEvent(eventType);
		});
		pi.on("message_end", () => this.resetSweep());
		pi.on("tool_call", () => this.resetSweep());

		pi.registerMarkdownTransformer((markdown, context) => {
			if (context.messageType !== "assistant-thinking") return markdown;
			this.hasToggleableThinking ||= hasThinkingDetail(markdown);
			const theme = this.theme;
			const detailTextPrefix = theme?.getFgAnsi("thinkingText");
			return renderThinkingView(markdown, thinkingViewForPhase(this.phase), context.availableWidth, {
				styleSummary: theme
					? context.isStreaming && this.thinkingStreamActive
						? (summary, sectionIndex) => {
								let startedAt = this.summarySweepStartedAt.get(sectionIndex);
								if (startedAt === undefined) {
									startedAt = Date.now();
									this.summarySweepStartedAt.set(sectionIndex, startedAt);
								}
								return shimmer(summary, theme, startedAt);
							}
						: (summary) => theme.fg("thinkingMax", theme.bold(summary))
					: undefined,
				// border styling resets the foreground; resume detail gray immediately.
				styleDetailPrefix: theme && detailTextPrefix
					? (prefix) => theme.fg("border", prefix) + detailTextPrefix
					: undefined,
				controls: theme
					? (hasDetail) => hasDetail
						? theme.fg(
								"borderAccent",
								`${theme.italic("ctrl+t")} toggle • ${theme.italic("click")} to hide`,
							)
						: undefined
					: undefined,
				styleControlPrefix: theme ? (prefix) => theme.fg("border", prefix) : undefined,
			});
		});
	}

	private resetSweep(): void {
		this.thinkingStreamActive = false;
		this.summarySweepStartedAt.clear();
	}

	bind(ctx: ExtensionContext): void {
		this.unsubscribe?.();
		this.theme = ctx.ui.theme;
		this.thinkingStreamActive = false;
		this.hasToggleableThinking = false;
		this.summarySweepStartedAt.clear();
		// Match Pi's persisted host visibility after startup or /reload. When the
		// host is hidden, Markdown transformers are not invoked at all. Pi wraps
		// this label in thinkingText, so an inner thinkingMax span is required to
		// keep it consistent with completed summary titles.
		this.phase = getInitialThinkingPhase();
		const hiddenLabel = this.theme.fg("thinkingMax", this.theme.bold("Thinking..."));
		// Pi does not currently expose transcript invalidation directly. Updating
		// this label rebuilds assistant Markdown and requests a render without
		// changing the message or its hidden/visible state.
		this.refreshThinking = () => ctx.ui.setHiddenThinkingLabel(hiddenLabel);
		this.refreshThinking();
		this.unsubscribe = ctx.ui.onTerminalInput((data) => {
			const input = classifyThinkingToggleInput(data);
			if (input === undefined) return undefined;
			// Kitty-capable macOS terminals report held keys as repeat events. Treating
			// those as presses can skip detail before the user sees it.
			if (input === "release" || input === "repeat") return { consume: true };
			// With no provider-supplied detail, leave Ctrl+T to Pi's normal
			// visible/hidden toggle instead of inserting an identical detail phase.
			if (!this.hasToggleableThinking) return undefined;
			this.phase = nextThinkingPhase(this.phase);
			if (this.phase === "detail" || this.phase === "summary-after-detail") {
				// Visible-to-visible transitions are owned by this extension. Rebuild the
				// Markdown and prevent Pi's built-in two-state toggle from hiding it.
				this.refreshThinking?.();
				return { consume: true };
			}
			// summary-after-detail -> hidden and hidden -> summary intentionally reach
			// Pi's existing two-state handler. This keeps visibility/settings in sync
			// and clears built-in per-block click overrides.
			return undefined;
		});
	}

	dispose(): void {
		this.unsubscribe?.();
		this.unsubscribe = undefined;
		this.refreshThinking = undefined;
		this.thinkingStreamActive = false;
		this.hasToggleableThinking = false;
		this.summarySweepStartedAt.clear();
		this.theme = undefined;
	}
}
