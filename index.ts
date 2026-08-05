import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { uuidv7 } from "@earendil-works/pi-ai";
import { complete } from "@earendil-works/pi-ai/compat";
import { CONFIG_DIR_NAME, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";

const DEFAULT_MODEL_SPEC = "anthropic/claude-haiku-4-5";
const CONFIG_FILE_NAME = "output-classifier.json";
const GLOBAL_CONFIG_PATH = path.join(os.homedir(), CONFIG_DIR_NAME, "agent", CONFIG_FILE_NAME);
const DEBUG_LOG_PATH = process.env.PI_OUTPUT_CLASSIFIER_DEBUG;
const MAX_REWRITE_ATTEMPTS = 2;
const MIN_REPLY_LENGTH = 40;
const STATUS_KEY = "output-classifier";
const FEEDBACK_MESSAGE_TYPE = "output-classifier";
const PROJECT_RULES_DIR = path.join(".pi", "output-rules");
const GLOBAL_RULES_DIR = path.join(path.dirname(new URL(import.meta.url).pathname), "rules");

type Rule = { name: string; text: string };
type Verdict = { pass: boolean; violations: string[] };
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
	return [...readRulesFromDir(GLOBAL_RULES_DIR), ...readRulesFromDir(path.join(cwd, PROJECT_RULES_DIR))];
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
	const rulesText = rules.map((rule) => `### ${rule.name}\n${rule.text}`).join("\n\n");
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
		'Respond with ONLY this JSON, nothing else: {"pass": true|false, "violations": ["short reason", ...]}',
	].join("\n");
}

function parseVerdict(raw: string): Verdict {
	const jsonCandidate = raw.match(/\{[\s\S]*\}/)?.[0];
	if (!jsonCandidate) {
		debugLog(`unparseable verdict: ${raw}`);
		return { pass: true, violations: [] };
	}
	try {
		const parsed = JSON.parse(jsonCandidate) as { pass?: boolean; violations?: string[] };
		return {
			pass: parsed.pass !== false,
			violations: Array.isArray(parsed.violations) ? parsed.violations : [],
		};
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
		debugLog(`no auth for ${modelSpec}: ${auth.ok ? "missing key" : auth.error}`);
		return { pass: true, violations: [] };
	}

	const response = await complete(
		model,
		{
			messages: [
				{ role: "user", content: [{ type: "text", text: prompt }], timestamp: Date.now() },
			],
		},
		{ apiKey: auth.apiKey, headers: auth.headers, env: auth.env, sessionId: uuidv7() },
	);

	if (response.stopReason === "error") {
		throw new Error((response as { errorMessage?: string }).errorMessage ?? "classifier request failed");
	}

	const verdict = parseVerdict(response.content.filter(isTextBlock).map((block) => block.text).join("\n"));
	debugLog(`verdict: ${JSON.stringify(verdict)}`);
	return verdict;
}

function buildRewriteFeedback(draft: string, violations: string[]): string {
	return [
		"Your draft reply below was withheld from the user because it violates the output rules:",
		...violations.map((violation) => `- ${violation}`),
		"",
		"<draft>",
		draft,
		"</draft>",
		"",
		"Write a replacement reply that complies with the rules.",
		"Output only the replacement reply. Do not call tools, do not apologize, do not mention this correction.",
	].join("\n");
}

function withheldPlaceholder(message: { content: unknown }): object {
	return {
		...message,
		content: [{ type: "text", text: "(draft withheld by output classifier, rewriting)" }],
	};
}

function setStatus(ctx: ExtensionContext, text: string): void {
	if (ctx.hasUI) {
		ctx.ui.setStatus(STATUS_KEY, text);
	}
}

const ENABLED_MARK = "\u25CF";
const DISABLED_MARK = "\u25CB";

export default function outputClassifier(pi: ExtensionAPI) {
	let rules: Rule[] = [];
	let modelSpec = DEFAULT_MODEL_SPEC;
	let isEnabled = true;
	let rewriteAttempts = 0;

	function requestRewrite(ctx: ExtensionContext, draft: string, violations: string[]): void {
		rewriteAttempts++;
		setStatus(ctx, `${ENABLED_MARK} tldr: fail, rewriting (${rewriteAttempts}/${MAX_REWRITE_ATTEMPTS})`);
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

	function giveUp(ctx: ExtensionContext, violations: string[]): void {
		rewriteAttempts = 0;
		setStatus(ctx, `${ENABLED_MARK} tldr: fail (gave up)`);
		if (ctx.hasUI) {
			ctx.ui.notify(`Output still violates rules: ${violations.join("; ")}`, "warning");
		}
	}

	function isFinalAssistantReply(message: {
		role?: string;
		stopReason?: string;
	}): boolean {
		return message.role === "assistant" && message.stopReason === "stop";
	}

	async function classifyReply(ctx: ExtensionContext, reply: string): Promise<Verdict | undefined> {
		setStatus(ctx, `${ENABLED_MARK} tldr: checking...`);
		try {
			return await requestVerdict(ctx, modelSpec, buildClassifierPrompt(rules, reply));
		} catch (error) {
			debugLog(`classifier error: ${String(error)}`);
			setStatus(ctx, `${ENABLED_MARK} tldr: check failed (skipped)`);
			return undefined;
		}
	}

	function showIdleStatus(ctx: ExtensionContext): void {
		setStatus(
			ctx,
			isEnabled ? `${ENABLED_MARK} tldr: ${rules.length} rule(s)` : `${DISABLED_MARK} tldr: off`,
		);
	}

	function toggle(ctx: ExtensionContext): void {
		isEnabled = !isEnabled;
		showIdleStatus(ctx);
		if (ctx.hasUI) {
			ctx.ui.notify(`Output classifier ${isEnabled ? "enabled" : "disabled"}`, "info");
		}
	}

	pi.on("session_start", async (_event, ctx) => {
		rules = loadRules(ctx.cwd);
		modelSpec = resolveModelSpec(ctx.cwd);
		if (rules.length > 0) {
			showIdleStatus(ctx);
		}
	});

	pi.on("input", async (event) => {
		if (event.source !== "extension") {
			rewriteAttempts = 0;
		}
	});

	pi.on("message_end", async (event, ctx) => {
		if (!isEnabled || rules.length === 0 || !isFinalAssistantReply(event.message)) {
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
			rewriteAttempts = 0;
			setStatus(ctx, `${ENABLED_MARK} tldr: pass`);
			return;
		}

		if (rewriteAttempts >= MAX_REWRITE_ATTEMPTS) {
			giveUp(ctx, verdict.violations);
			return;
		}

		requestRewrite(ctx, reply, verdict.violations);
		return { message: withheldPlaceholder(event.message) as typeof event.message };
	});

	pi.registerCommand("tldr", {
		description: "Toggle the output classifier (STE/TLDR rules) on or off",
		handler: async (_args, ctx) => toggle(ctx),
	});

	pi.registerShortcut("ctrl+alt+t", {
		description: "Toggle the output classifier",
		handler: async (ctx) => toggle(ctx),
	});
}
