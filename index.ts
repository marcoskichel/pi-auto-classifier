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
	type Theme,
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
const ENABLED_MARK = "\u25CF";
const DISABLED_MARK = "\u25CB";
const BADGE_HINT = "/classifier to toggle";

type Rule = { name: string; text: string };
type Violation = { rule: string; reason: string };
type Verdict = { pass: boolean; violations: Violation[] };
type ClassifierConfig = { model?: string };
type TextBlock = { type: "text"; text: string };
type DraftMessage = { role?: string; content?: unknown };
type EndedMessage = DraftMessage & { stopReason?: string };

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
		.sort((a, b) => a.localeCompare(b))
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
			.flatMap((block) => (isTextBlock(block) ? [block.text] : []))
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

function toViolation(entry: unknown): Violation {
	if (typeof entry === "string") {
		return { rule: "unspecified", reason: entry };
	}
	const fields = entry as { rule?: unknown; reason?: unknown };
	return {
		rule: typeof fields.rule === "string" ? fields.rule : "unspecified",
		reason: typeof fields.reason === "string" ? fields.reason : "rule violated",
	};
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
		const entries = Array.isArray(parsed.violations) ? parsed.violations : [];
		return {
			pass: parsed.pass !== false,
			violations: entries.map(toViolation),
		};
	} catch {
		debugLog(`invalid verdict JSON: ${jsonCandidate}`);
		return { pass: true, violations: [] };
	}
}

function userMessage(text: string) {
	return {
		role: "user" as const,
		content: [{ type: "text" as const, text }],
		timestamp: Date.now(),
	};
}

async function resolveModelAuth(ctx: ExtensionContext, modelSpec: string) {
	const [provider, ...modelIdParts] = modelSpec.split("/");
	const model = ctx.modelRegistry.find(provider, modelIdParts.join("/"));
	if (!model) {
		debugLog(`model not found: ${modelSpec}`);
		return undefined;
	}
	const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
	if (!auth.ok || !auth.apiKey) {
		debugLog(
			`no auth for ${modelSpec}: ${auth.ok ? "missing key" : auth.error}`,
		);
		return undefined;
	}
	return { model, apiKey: auth.apiKey, headers: auth.headers, env: auth.env };
}

async function requestVerdict(
	ctx: ExtensionContext,
	modelSpec: string,
	prompt: string,
): Promise<Verdict> {
	const resolved = await resolveModelAuth(ctx, modelSpec);
	if (!resolved) {
		return { pass: true, violations: [] };
	}
	const response = await complete(
		resolved.model,
		{ messages: [userMessage(prompt)] },
		{ ...resolved, sessionId: uuidv7() },
	);
	if (response.stopReason === "error") {
		throw new Error(
			(response as { errorMessage?: string }).errorMessage ??
				"classifier request failed",
		);
	}
	const verdict = parseVerdict(textFromContent(response.content));
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

/* ponytail: relies on pi emitting extension events before TUI listeners with a shared
   message reference, and on message_update carrying a per-event shallow copy of the
   partial message (agent-loop.js). If pi ever clones events for extensions, drafts
   become visible again during streaming and this needs a real upstream hide API. */
function maskDraftText(message: DraftMessage): void {
	if (!Array.isArray(message.content)) {
		return;
	}
	message.content = message.content.map((block) =>
		isTextBlock(block) ? { ...block, text: "" } : block,
	);
}

function withheldPlaceholder<T extends object>(message: T): T {
	return {
		...message,
		content: [
			{
				type: "text",
				text: "(draft withheld by output classifier, rewriting)",
			},
		],
	} as T;
}

function isFinalAssistantReply(message: EndedMessage): boolean {
	return message.role === "assistant" && message.stopReason === "stop";
}

class Classifier {
	private rules: Rule[] = [];
	private modelSpec = DEFAULT_MODEL_SPEC;
	private isEnabled = true;
	private blockedRules = new Set<string>();
	private badgeText = "";
	private requestBadgeRender: (() => void) | undefined;
	private readonly pi: ExtensionAPI;

	constructor(pi: ExtensionAPI) {
		this.pi = pi;
	}

	start(ctx: ExtensionContext): void {
		this.rules = loadRules(ctx.cwd);
		this.modelSpec = resolveModelSpec(ctx.cwd);
		if (this.rules.length > 0) {
			this.mountBadge(ctx);
			this.showIdleStatus(ctx);
		}
	}

	onInput(event: { source?: string }): void {
		if (event.source !== "extension") {
			this.blockedRules = new Set();
		}
	}

	hideDraft(message: DraftMessage): void {
		if (
			this.isEnabled &&
			this.rules.length > 0 &&
			message.role === "assistant"
		) {
			maskDraftText(message);
		}
	}

	async onMessageEnd<M extends EndedMessage>(
		event: { message: M },
		ctx: ExtensionContext,
	): Promise<{ message: M } | undefined> {
		const reply = this.replyToCheck(event.message);
		if (reply === undefined) {
			return undefined;
		}
		const verdict = await this.classifyReply(ctx, reply);
		if (!verdict) {
			return undefined;
		}
		if (verdict.pass) {
			this.blockedRules = new Set();
			this.setStatus(ctx, `${ENABLED_MARK} classifier \u2713`);
			return undefined;
		}
		if (this.takeFreshViolations(verdict.violations).length === 0) {
			this.giveUp(ctx, verdict.violations);
			return undefined;
		}
		this.requestRewrite(ctx, reply, verdict.violations);
		return { message: withheldPlaceholder(event.message) };
	}

	toggle(ctx: ExtensionContext): void {
		this.isEnabled = !this.isEnabled;
		this.showIdleStatus(ctx);
		if (ctx.hasUI) {
			ctx.ui.notify(
				`Output classifier ${this.isEnabled ? "enabled" : "disabled"}`,
				"info",
			);
		}
	}

	private replyToCheck(message: EndedMessage): string | undefined {
		if (
			!this.isEnabled ||
			this.rules.length === 0 ||
			!isFinalAssistantReply(message)
		) {
			return undefined;
		}
		const reply = textFromContent(message.content);
		return reply.length < MIN_REPLY_LENGTH ? undefined : reply;
	}

	private takeFreshViolations(violations: Violation[]): Violation[] {
		const fresh = violations.filter(
			(violation) => !this.blockedRules.has(violation.rule),
		);
		for (const violation of fresh) {
			this.blockedRules.add(violation.rule);
		}
		return fresh;
	}

	private async classifyReply(
		ctx: ExtensionContext,
		reply: string,
	): Promise<Verdict | undefined> {
		this.setStatus(ctx, `${ENABLED_MARK} classifier \u2026`);
		try {
			return await requestVerdict(
				ctx,
				this.modelSpec,
				buildClassifierPrompt(this.rules, reply),
			);
		} catch (error) {
			debugLog(`classifier error: ${String(error)}`);
			this.setStatus(ctx, `${ENABLED_MARK} classifier ?`);
			return undefined;
		}
	}

	private requestRewrite(
		ctx: ExtensionContext,
		draft: string,
		violations: Violation[],
	): void {
		this.setStatus(ctx, `${ENABLED_MARK} classifier \u270E rewriting`);
		try {
			this.pi.sendMessage(
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

	private giveUp(ctx: ExtensionContext, violations: Violation[]): void {
		this.blockedRules = new Set();
		this.setStatus(ctx, `${ENABLED_MARK} classifier \u2717`);
		debugLog(
			`gave up, still violates: ${violations.map(formatViolation).join("; ")}`,
		);
	}

	private setStatus(ctx: ExtensionContext, text: string): void {
		this.badgeText = text;
		if (this.requestBadgeRender) {
			this.requestBadgeRender();
		} else if (ctx.hasUI) {
			ctx.ui.setStatus(STATUS_KEY, text);
		}
	}

	private showIdleStatus(ctx: ExtensionContext): void {
		this.setStatus(
			ctx,
			this.isEnabled
				? `${ENABLED_MARK} classifier (${this.rules.length})`
				: `${DISABLED_MARK} classifier off`,
		);
	}

	private badgeLine(theme: Theme, width: number): string {
		const plain = `${this.badgeText}  ${BADGE_HINT}`;
		const pad = " ".repeat(Math.max(0, width - plain.length));
		const styled =
			theme.fg(this.isEnabled ? "accent" : "dim", this.badgeText) +
			theme.fg("dim", `  ${BADGE_HINT}`);
		return pad + styled;
	}

	private mountBadge(ctx: ExtensionContext): void {
		if (!ctx.hasUI || this.requestBadgeRender) {
			return;
		}
		ctx.ui.setWidget(
			STATUS_KEY,
			(tui, theme) => {
				this.requestBadgeRender = () => tui.requestRender();
				return {
					render: (width: number) => [this.badgeLine(theme, width)],
					invalidate() {},
				};
			},
			{ placement: "belowEditor" },
		);
	}
}

export default function outputClassifier(pi: ExtensionAPI) {
	const classifier = new Classifier(pi);
	const hideDraft = async (event: { message: DraftMessage }) =>
		classifier.hideDraft(event.message);

	pi.on("session_start", async (_event, ctx) => classifier.start(ctx));
	pi.on("input", async (event) => classifier.onInput(event));
	pi.on("message_start", hideDraft);
	pi.on("message_update", hideDraft);
	pi.on("message_end", async (event, ctx) =>
		classifier.onMessageEnd(event, ctx),
	);
	pi.registerCommand("classifier", {
		description:
			"Toggle the output classifier (rules in rules/ and .pi/output-rules/) on or off",
		handler: async (_args, ctx) => classifier.toggle(ctx),
	});
}
