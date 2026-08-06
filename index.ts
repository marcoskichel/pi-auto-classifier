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
const CONFIG_FILE_NAME = "auto-classifier.json";
const GLOBAL_CONFIG_PATH = path.join(
	os.homedir(),
	CONFIG_DIR_NAME,
	"agent",
	CONFIG_FILE_NAME,
);
const DEBUG_LOG_PATH = process.env.PI_AUTO_CLASSIFIER_DEBUG;
const MIN_REPLY_LENGTH = 40;
const STATUS_KEY = "auto-classifier";
const FEEDBACK_MESSAGE_TYPE = "auto-classifier";
const PROJECT_RULES_DIR = path.join(".pi", "output-rules");
const PROJECT_TOOL_RULES_DIR = path.join(".pi", "tool-rules");
const USER_DIR = path.join(os.homedir(), CONFIG_DIR_NAME, "agent");
const GLOBAL_RULES_DIR = path.join(
	path.dirname(fileURLToPath(import.meta.url)),
	"rules",
);
const MAX_TOOL_INPUT_CHARS = 4000;
const MAX_USER_REQUEST_CHARS = 2000;
const FEEDBACK_PREFIX = "Your draft reply below was withheld";
const TOOL_PROMPT_HEADER = [
	"You are a strict policy checker for an AI coding assistant's tool calls.",
	"Judge the tool call below against the rules. Fail it only when a rule clearly forbids it.",
	"Each violation reason goes back to the assistant as a direct order, so write it as an",
	"imperative instruction that names the action to take instead. Never address the user.",
].join("\n");
const ENABLED_MARK = "\u25CF";
const DISABLED_MARK = "\u25CB";

type Rule = { name: string; text: string };
type Violation = { rule: string; reason: string };
type Verdict = {
	pass: boolean;
	violations: Violation[];
	userAsked?: boolean;
};
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
		process.env.PI_AUTO_CLASSIFIER_MODEL ??
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
		...readRulesFromDir(path.join(USER_DIR, "output-rules")),
		...readRulesFromDir(path.join(cwd, PROJECT_RULES_DIR)),
	];
}

function loadToolRules(cwd: string): Rule[] {
	return [
		...readRulesFromDir(path.join(USER_DIR, "tool-rules")),
		...readRulesFromDir(path.join(cwd, PROJECT_TOOL_RULES_DIR)),
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

function buildToolPrompt(
	rules: Rule[],
	toolName: string,
	input: unknown,
	userRequest: string,
): string {
	const rulesText = rules
		.map((rule) => `### ${rule.name}\n${rule.text}`)
		.join("\n\n");
	return [
		TOOL_PROMPT_HEADER,
		"",
		"<user_request>",
		userRequest.slice(0, MAX_USER_REQUEST_CHARS),
		"</user_request>",
		"",
		"<rules>",
		rulesText,
		"</rules>",
		"",
		`<tool name="${toolName}">`,
		JSON.stringify(input ?? {}).slice(0, MAX_TOOL_INPUT_CHARS),
		"</tool>",
		"",
		'Respond with ONLY this JSON, nothing else: {"pass": true|false, "violations": [{"rule": "<rule heading>", "reason": "instruction for the assistant"}, ...]}',
	].join("\n");
}

function buildOverridePrompt(
	rules: Rule[],
	violations: Violation[],
	toolName: string,
	input: unknown,
	userRequest: string,
): string {
	const blocked = rules
		.filter((rule) => violations.some((v) => v.rule === rule.name))
		.map((rule) => `### ${rule.name}\n${rule.text}`)
		.join("\n\n");
	return [
		"A policy rule blocked a tool call. Decide whether the user already ordered that action.",
		"Answer yes when the user request asks for this action, or asks for something that needs it.",
		"Answer no when the rule states that it holds even when the user asks for the action.",
		"Answer no when the request never mentions this action.",
		"",
		"<user_request>",
		userRequest.slice(0, MAX_USER_REQUEST_CHARS),
		"</user_request>",
		"",
		"<blocked_rules>",
		blocked,
		"</blocked_rules>",
		"",
		`<tool name="${toolName}">`,
		JSON.stringify(input ?? {}).slice(0, MAX_TOOL_INPUT_CHARS),
		"</tool>",
		"",
		'Respond with ONLY this JSON, nothing else: {"userAsked": true|false}',
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
			userAsked?: boolean;
		};
		const entries = Array.isArray(parsed.violations) ? parsed.violations : [];
		return {
			pass: parsed.pass !== false,
			violations: entries.map(toViolation),
			userAsked: parsed.userAsked === true,
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
		`${FEEDBACK_PREFIX} from the user because it violates the output rules:`,
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
				text: "(draft withheld by auto classifier, rewriting)",
			},
		],
	} as T;
}

function isFinalAssistantReply(message: EndedMessage): boolean {
	return message.role === "assistant" && message.stopReason === "stop";
}

class Classifier {
	private rules: Rule[] = [];
	private toolRules: Rule[] = [];
	private userRequest = "";
	private modelSpec = DEFAULT_MODEL_SPEC;
	private isEnabled = true;
	private readonly pi: ExtensionAPI;

	constructor(pi: ExtensionAPI) {
		this.pi = pi;
	}

	start(ctx: ExtensionContext): void {
		this.rules = loadRules(ctx.cwd);
		this.toolRules = loadToolRules(ctx.cwd);
		this.modelSpec = resolveModelSpec(ctx.cwd);
		if (this.rules.length + this.toolRules.length > 0) {
			this.showIdleStatus(ctx);
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
		if (event.message.role === "user") {
			this.captureUserRequest(textFromContent(event.message.content));
			return undefined;
		}
		const reply = this.replyToCheck(event.message);
		if (reply === undefined) {
			return undefined;
		}
		const verdict = await this.classifyReply(ctx, reply);
		if (!verdict) {
			return undefined;
		}
		if (verdict.pass) {
			this.setStatus(ctx, `${ENABLED_MARK} classifier \u2713`);
			return undefined;
		}
		this.requestRewrite(ctx, reply, verdict.violations);
		return { message: withheldPlaceholder(event.message) };
	}

	private async classifyToolCall(
		ctx: ExtensionContext,
		event: { toolName: string; input: unknown },
	): Promise<Verdict | undefined> {
		try {
			debugLog(
				buildToolPrompt(
					this.toolRules,
					event.toolName,
					event.input,
					this.userRequest,
				),
			);
			return await requestVerdict(
				ctx,
				this.modelSpec,
				buildToolPrompt(
					this.toolRules,
					event.toolName,
					event.input,
					this.userRequest,
				),
			);
		} catch (error) {
			debugLog(`tool classifier error: ${String(error)}`);
			this.setStatus(ctx, `${ENABLED_MARK} classifier ?`);
			return undefined;
		}
	}

	private async userAskedFor(
		ctx: ExtensionContext,
		event: { toolName: string; input: unknown },
		violations: Violation[],
	): Promise<boolean> {
		if (this.userRequest.length === 0) {
			return false;
		}
		try {
			const answer = await requestVerdict(
				ctx,
				this.modelSpec,
				buildOverridePrompt(
					this.toolRules,
					violations,
					event.toolName,
					event.input,
					this.userRequest,
				),
			);
			return answer.userAsked === true;
		} catch (error) {
			debugLog(`override check failed: ${String(error)}`);
			return false;
		}
	}

	captureUserRequest(text: string): void {
		if (text.length > 0 && !text.startsWith(FEEDBACK_PREFIX)) {
			this.userRequest = text;
		}
	}

	async onToolCall(
		event: { toolName: string; input: unknown },
		ctx: ExtensionContext,
	): Promise<{ block: true; reason: string } | undefined> {
		if (!this.isEnabled || this.toolRules.length === 0) {
			return undefined;
		}
		this.setStatus(ctx, `${ENABLED_MARK} classifier \u2026`);
		const verdict = await this.classifyToolCall(ctx, event);
		if (!verdict) {
			return undefined;
		}
		if (verdict.pass || verdict.violations.length === 0) {
			this.showIdleStatus(ctx);
			return undefined;
		}
		if (await this.userAskedFor(ctx, event, verdict.violations)) {
			this.setStatus(ctx, `${ENABLED_MARK} classifier \u2713 user asked`);
			return undefined;
		}
		this.setStatus(ctx, `${ENABLED_MARK} classifier \u2298 ${event.toolName}`);
		return {
			block: true,
			reason: verdict.violations.map(formatViolation).join("\n"),
		};
	}

	toggle(ctx: ExtensionContext): void {
		this.isEnabled = !this.isEnabled;
		this.showIdleStatus(ctx);
		if (ctx.hasUI) {
			ctx.ui.notify(
				`Auto classifier ${this.isEnabled ? "enabled" : "disabled"}`,
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

	private setStatus(ctx: ExtensionContext, text: string): void {
		if (ctx.hasUI) {
			ctx.ui.setStatus(STATUS_KEY, text);
		}
	}

	private showIdleStatus(ctx: ExtensionContext): void {
		this.setStatus(
			ctx,
			this.isEnabled
				? `${ENABLED_MARK} classifier (${this.rules.length + this.toolRules.length})`
				: `${DISABLED_MARK} classifier off`,
		);
	}
}

export default function autoClassifier(pi: ExtensionAPI) {
	const classifier = new Classifier(pi);
	const hideDraft = async (event: { message: DraftMessage }) =>
		classifier.hideDraft(event.message);

	pi.on("session_start", async (_event, ctx) => classifier.start(ctx));
	pi.on("message_start", hideDraft);
	pi.on("message_update", hideDraft);
	pi.on("message_end", async (event, ctx) =>
		classifier.onMessageEnd(event, ctx),
	);
	pi.on("input", async (event) => classifier.captureUserRequest(event.text));
	pi.on("tool_call", async (event, ctx) => classifier.onToolCall(event, ctx));
	pi.registerCommand("classifier", {
		description:
			"Toggle the classifier (output rules in .pi/output-rules/, tool rules in .pi/tool-rules/) on or off",
		handler: async (_args, ctx) => classifier.toggle(ctx),
	});
}
