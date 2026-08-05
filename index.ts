import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { uuidv7 } from "@earendil-works/pi-ai";
import { complete } from "@earendil-works/pi-ai/compat";
import {
	CONFIG_DIR_NAME,
	type ExtensionAPI,
	type ExtensionContext,
} from "@earendil-works/pi-coding-agent";

const DEFAULT_MODEL_SPEC = "anthropic/claude-haiku-4-5";
const CONFIG_FILE_NAME = "output-classifier.json";
const GLOBAL_CONFIG_PATH = path.join(
	os.homedir(),
	CONFIG_DIR_NAME,
	"agent",
	CONFIG_FILE_NAME,
);
const DEBUG_LOG_PATH = process.env.PI_OUTPUT_CLASSIFIER_DEBUG;
const MIN_REPLY_LENGTH = 40;
const STATUS_KEY = "output-classifier";
const FEEDBACK_MESSAGE_TYPE = "output-classifier";
const PROJECT_RULES_DIR = path.join(".pi", "output-rules");
const GLOBAL_RULES_DIR = path.join(
	path.dirname(fileURLToPath(import.meta.url)),
	"rules",
);

type Rule = { name: string; text: string };
type Violation = { rule: string; reason: string };
type Verdict = { pass: boolean; violations: Violation[] };
type ClassifierConfig = { model?: string };

type TextBlock = { type: "text"; text: string };

function debugLog(line: string): void {
	if (DEBUG_LOG_PATH) {
		fs.appendFileSync(DEBUG_LOG_PATH, `${line}\n`);
	}
}

function readConfigFile(filePath: string): ClassifierConfig {
	try {
		return JSON.parse(fs.readFileSync(filePath, "utf8")) as ClassifierConfig;
	} catch {
		return {};
	}
}

function resolveModelSpec(cwd: string): string {
	const projectConfigPath = path.join(cwd, CONFIG_DIR_NAME, CONFIG_FILE_NAME);
	return (
		process.env.PI_OUTPUT_CLASSIFIER_MODEL ??
		readConfigFile(projectConfigPath).model ??
		readConfigFile(GLOBAL_CONFIG_PATH).model ??
		DEFAULT_MODEL_SPEC
	);
}

function readRulesFromDir(dir: string): Rule[] {
	if (!fs.existsSync(dir)) {
		return [];
	}
	return fs
		.readdirSync(dir)
		.filter((file) => file.endsWith(".md"))
		.sort()
		.map((file) => ({
			name: file,
			text: fs.readFileSync(path.join(dir, file), "utf8").trim(),
		}));
}

function loadRules(cwd: string): Rule[] {
	return [
		...readRulesFromDir(GLOBAL_RULES_DIR),
		...readRulesFromDir(path.join(cwd, PROJECT_RULES_DIR)),
	];
}

function isTextBlock(block: unknown): block is TextBlock {
	return (
		typeof block === "object" &&
		block !== null &&
		(block as TextBlock).type === "text" &&
		typeof (block as TextBlock).text === "string"
	);
}

function textFromContent(content: unknown): string {
	if (typeof content === "string") {
		return content.trim();
	}
	if (Array.isArray(content)) {
		return content
			.filter(isTextBlock)
			.map((block) => block.text)
			.join("\n")
			.trim();
	}
	return "";
}

function buildClassifierPrompt(rules: Rule[], reply: string): string {
	const rulesText = rules
		.map((rule) => `### ${rule.name}\n${rule.text}`)
		.join("\n\n");
	return [
		"You are a strict compliance checker for an AI coding assistant's final reply.",
		"Judge the reply text alone against the rules below.",
		"It does not matter what style the user asked for; the rules always apply.",
		"Fail the reply when any rule is clearly violated, for example: preamble before the answer,",
		"filler or trivia, rambling prose, dominant passive voice, or a buried answer.",
		"",
		"<rules>",
		rulesText,
		"</rules>",
		"",
		"<reply>",
		reply,
		"</reply>",
		"",
		'Respond with ONLY this JSON, nothing else: {"pass": true|false, "violations": [{"rule": "<rule heading>", "reason": "short reason"}, ...]}',
	].join("\n");
}

function parseVerdict(raw: string): Verdict {
	const jsonCandidate = raw.match(/\{[\s\S]*\}/)?.[0];
	if (!jsonCandidate) {
		debugLog(`unparseable verdict: ${raw}`);
		return { pass: true, violations: [] };
	}
	try {
		const parsed = JSON.parse(jsonCandidate) as {
			pass?: boolean;
			violations?: unknown[];
		};
		const violations = (
			Array.isArray(parsed.violations) ? parsed.violations : []
		).map((entry): Violation => {
			if (typeof entry === "string") {
				return { rule: "unspecified", reason: entry };
			}
			const obj = entry as { rule?: unknown; reason?: unknown };
			return {
				rule: typeof obj.rule === "string" ? obj.rule : "unspecified",
				reason: typeof obj.reason === "string" ? obj.reason : "rule violated",
			};
		});
		return { pass: parsed.pass !== false, violations };
	} catch {
		debugLog(`invalid verdict JSON: ${jsonCandidate}`);
		return { pass: true, violations: [] };
	}
}

async function requestVerdict(
	ctx: ExtensionContext,
	modelSpec: string,
	prompt: string,
): Promise<Verdict> {
	const [provider, ...modelIdParts] = modelSpec.split("/");
	const model = ctx.modelRegistry.find(provider, modelIdParts.join("/"));
	if (!model) {
		debugLog(`model not found: ${modelSpec}`);
		return { pass: true, violations: [] };
	}

	const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
	if (!auth.ok || !auth.apiKey) {
		debugLog(
			`no auth for ${modelSpec}: ${auth.ok ? "missing key" : auth.error}`,
		);
		return { pass: true, violations: [] };
	}

	const response = await complete(
		model,
		{
			messages: [
				{
					role: "user",
					content: [{ type: "text", text: prompt }],
					timestamp: Date.now(),
				},
			],
		},
		{
			apiKey: auth.apiKey,
			headers: auth.headers,
			env: auth.env,
			sessionId: uuidv7(),
		},
	);

	if (response.stopReason === "error") {
		throw new Error(
			(response as { errorMessage?: string }).errorMessage ??
				"classifier request failed",
		);
	}

	const verdict = parseVerdict(
		response.content
			.filter(isTextBlock)
			.map((block) => block.text)
			.join("\n"),
	);
	debugLog(`verdict: ${JSON.stringify(verdict)}`);
	return verdict;
}

function formatViolation(violation: Violation): string {
	return `[${violation.rule}] ${violation.reason}`;
}

function buildRewriteFeedback(draft: string, violations: Violation[]): string {
	return [
		"Your draft reply below was withheld from the user because it violates the output rules:",
		...violations.map((violation) => `- ${formatViolation(violation)}`),
		"",
		"<draft>",
		draft,
		"</draft>",
		"",
		"Write a replacement reply that complies with the rules.",
		"Output only the replacement reply. Do not call tools, do not apologize, do not mention this correction.",
	].join("\n");
}

// ponytail: relies on pi emitting extension events before TUI listeners with a shared
// message reference, and on message_update carrying a per-event shallow copy of the
// partial message (agent-loop.js). If pi ever clones events for extensions, drafts
// become visible again during streaming and this needs a real upstream hide API.
function maskDraftText(message: { role?: string; content?: unknown }): void {
	if (!Array.isArray(message.content)) {
		return;
	}
	message.content = message.content.map((block) =>
		isTextBlock(block) ? { ...block, text: "" } : block,
	);
}

function withheldPlaceholder(message: { content: unknown }): object {
	return {
		...message,
		content: [
			{
				type: "text",
				text: "(draft withheld by output classifier, rewriting)",
			},
		],
	};
}

const ENABLED_MARK = "\u25CF";
const DISABLED_MARK = "\u25CB";
const TOGGLE_SHORTCUT = "ctrl+alt+b";

export default function outputClassifier(pi: ExtensionAPI) {
	let rules: Rule[] = [];
	let modelSpec = DEFAULT_MODEL_SPEC;
	let isEnabled = true;
	// Each rule may force a rewrite only once per user turn.
	let blockedRules = new Set<string>();
	let badgeText = "";
	let requestBadgeRender: (() => void) | undefined;

	function setStatus(ctx: ExtensionContext, text: string): void {
		badgeText = text;
		if (requestBadgeRender) {
			requestBadgeRender();
		} else if (ctx.hasUI) {
			ctx.ui.setStatus(STATUS_KEY, text);
		}
	}

	function mountBadge(ctx: ExtensionContext): void {
		if (!ctx.hasUI || requestBadgeRender) {
			return;
		}
		ctx.ui.setWidget(
			STATUS_KEY,
			(tui, theme) => {
				requestBadgeRender = () => tui.requestRender();
				return {
					render(width: number) {
						const hint = `${TOGGLE_SHORTCUT} to toggle`;
						const plain = `${badgeText}  ${hint}`;
						const pad = " ".repeat(Math.max(0, width - plain.length));
						const styled =
							theme.fg(isEnabled ? "accent" : "dim", badgeText) +
							theme.fg("dim", `  ${hint}`);
						return [pad + styled];
					},
					invalidate() {},
				};
			},
			{ placement: "belowEditor" },
		);
	}

	function requestRewrite(
		ctx: ExtensionContext,
		draft: string,
		violations: Violation[],
	): void {
		setStatus(ctx, `${ENABLED_MARK} classifier \u270E rewriting`);
		try {
			pi.sendMessage(
				{
					customType: FEEDBACK_MESSAGE_TYPE,
					content: buildRewriteFeedback(draft, violations),
					display: false,
				},
				{ deliverAs: "followUp", triggerTurn: true },
			);
		} catch (error) {
			debugLog(`rewrite skipped, session is shutting down: ${String(error)}`);
		}
	}

	function giveUp(ctx: ExtensionContext, violations: Violation[]): void {
		blockedRules = new Set();
		setStatus(ctx, `${ENABLED_MARK} classifier \u2717`);
		if (ctx.hasUI) {
			ctx.ui.notify(
				`Output still violates rules: ${violations.map(formatViolation).join("; ")}`,
				"warning",
			);
		}
	}

	function isFinalAssistantReply(message: {
		role?: string;
		stopReason?: string;
	}): boolean {
		return message.role === "assistant" && message.stopReason === "stop";
	}

	async function classifyReply(
		ctx: ExtensionContext,
		reply: string,
	): Promise<Verdict | undefined> {
		setStatus(ctx, `${ENABLED_MARK} classifier \u2026`);
		try {
			return await requestVerdict(
				ctx,
				modelSpec,
				buildClassifierPrompt(rules, reply),
			);
		} catch (error) {
			debugLog(`classifier error: ${String(error)}`);
			setStatus(ctx, `${ENABLED_MARK} classifier ?`);
			return undefined;
		}
	}

	function showIdleStatus(ctx: ExtensionContext): void {
		setStatus(
			ctx,
			isEnabled
				? `${ENABLED_MARK} classifier (${rules.length})`
				: `${DISABLED_MARK} classifier off`,
		);
	}

	function toggle(ctx: ExtensionContext): void {
		isEnabled = !isEnabled;
		showIdleStatus(ctx);
		if (ctx.hasUI) {
			ctx.ui.notify(
				`Output classifier ${isEnabled ? "enabled" : "disabled"}`,
				"info",
			);
		}
	}

	pi.on("session_start", async (_event, ctx) => {
		rules = loadRules(ctx.cwd);
		modelSpec = resolveModelSpec(ctx.cwd);
		if (rules.length > 0) {
			mountBadge(ctx);
			showIdleStatus(ctx);
		}
	});

	pi.on("input", async (event) => {
		if (event.source !== "extension") {
			blockedRules = new Set();
		}
	});

	const hideStreamingDraft = async (event: {
		message: { role?: string; content?: unknown };
	}) => {
		if (isEnabled && rules.length > 0 && event.message.role === "assistant") {
			maskDraftText(event.message);
		}
	};
	pi.on("message_start", hideStreamingDraft);
	pi.on("message_update", hideStreamingDraft);

	pi.on("message_end", async (event, ctx) => {
		if (
			!isEnabled ||
			rules.length === 0 ||
			!isFinalAssistantReply(event.message)
		) {
			return;
		}

		const reply = textFromContent(event.message.content);
		if (reply.length < MIN_REPLY_LENGTH) {
			return;
		}

		const verdict = await classifyReply(ctx, reply);
		if (!verdict) {
			return;
		}

		if (verdict.pass) {
			blockedRules = new Set();
			setStatus(ctx, `${ENABLED_MARK} classifier \u2713`);
			return;
		}

		const freshViolations = verdict.violations.filter(
			(violation) => !blockedRules.has(violation.rule),
		);
		if (freshViolations.length === 0) {
			giveUp(ctx, verdict.violations);
			return;
		}
		for (const violation of freshViolations) {
			blockedRules.add(violation.rule);
		}

		requestRewrite(ctx, reply, verdict.violations);
		return {
			message: withheldPlaceholder(event.message) as typeof event.message,
		};
	});

	pi.registerCommand("classifier", {
		description:
			"Toggle the output classifier (rules in rules/ and .pi/output-rules/) on or off",
		handler: async (_args, ctx) => toggle(ctx),
	});

	pi.registerShortcut(TOGGLE_SHORTCUT, {
		description: "Toggle the output classifier",
		handler: async (ctx) => toggle(ctx),
	});
}
