import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { uuidv7 } from "@earendil-works/pi-ai";
import { complete } from "@earendil-works/pi-ai/compat";
import {
	CONFIG_DIR_NAME,
	type ExtensionAPI,
	type ExtensionContext,
	keyText,
} from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";

const DEFAULT_MODEL_SPEC = "anthropic/claude-haiku-4-5";
const CONFIG_FILE_NAME = "auto-classifier.json";
function globalConfigPath(): string {
	return (
		process.env.PI_AUTO_CLASSIFIER_CONFIG ??
		path.join(os.homedir(), CONFIG_DIR_NAME, "agent", CONFIG_FILE_NAME)
	);
}
const DEBUG_LOG_PATH = process.env.PI_AUTO_CLASSIFIER_DEBUG;
const MIN_REPLY_LENGTH = 40;
const STATUS_KEY = "auto-classifier";
const FEEDBACK_MESSAGE_TYPE = "auto-classifier";
const PROJECT_RULES_DIR = path.join(".pi", "output-rules");
const PROJECT_TOOL_RULES_DIR = path.join(".pi", "tool-rules");
function userDir(): string {
	return (
		process.env.PI_AUTO_CLASSIFIER_USER_DIR ??
		path.join(os.homedir(), CONFIG_DIR_NAME, "agent")
	);
}
function userRulesDir(): string {
	return path.join(userDir(), "output-rules");
}
const CATALOG_URL =
	"https://api.github.com/repos/marcoskichel/pi-auto-classifier/contents/rules";
const MAX_TOOL_INPUT_CHARS = 4000;
const MAX_USER_REQUEST_CHARS = 2000;
const FEEDBACK_PREFIX = "Your draft reply below was withheld";
const FRONTMATTER = /^---\n([\s\S]*?)\n---\n?/;
const ONCE_KEY = /^once:[ \t]*(.*)$/m;
const WITHHELD_ENTRY_TYPE = "auto-classifier-withheld";
const EXPAND_KEY = "app.tools.expand";
const TOOL_PROMPT_HEADER = [
	"You are a strict policy checker for an AI coding assistant's tool calls.",
	"Judge the tool call below against the rules. Fail it only when a rule clearly forbids it.",
	"Judge only what the rules explicitly state. Never invent requirements (model names, APIs,",
	"style) that the rules do not mention.",
	"Each violation reason goes back to the assistant as a direct order, so write it as an",
	"imperative instruction that names the action to take instead. Never address the user.",
].join("\n");
const ENABLED_MARK = "\u25CF";
const DISABLED_MARK = "\u25CB";

type Rule = { name: string; text: string; once?: string };
export type CatalogEntry = { name: string; downloadUrl: string };
type Violation = { rule: string; reason: string };
type Verdict = {
	pass: boolean;
	violations: Violation[];
	userAsked?: boolean;
};
type ClassifierConfig = {
	model?: string;
	enabled?: boolean;
	disabledRules?: string[];
};
type WithheldEntry = { violations: Violation[] };
type MenuTheme = {
	fg(color: "accent" | "text" | "dim", text: string): string;
	bold(text: string): string;
};
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
		readConfigFile(globalConfigPath()).model ??
		DEFAULT_MODEL_SPEC
	);
}

function saveGlobalConfig(patch: ClassifierConfig): void {
	const file = globalConfigPath();
	const merged = { ...readConfigFile(file), ...patch };
	fs.mkdirSync(path.dirname(file), { recursive: true });
	fs.writeFileSync(file, `${JSON.stringify(merged, null, 2)}\n`);
}

function readRulesFromDir(dir: string): Rule[] {
	if (!fs.existsSync(dir)) {
		return [];
	}
	return fs
		.readdirSync(dir)
		.filter((file) => file.endsWith(".md"))
		.sort((a, b) => a.localeCompare(b))
		.map((file) =>
			parseRule(file, fs.readFileSync(path.join(dir, file), "utf8")),
		);
}

export function parseRule(name: string, raw: string): Rule {
	const front = raw.match(FRONTMATTER);
	if (!front) {
		return { name, text: raw.trim() };
	}
	const text = raw.slice(front[0].length).trim();
	const once = front[1].match(ONCE_KEY);
	return once ? { name, text, once: once[1].trim() } : { name, text };
}

function loadRules(cwd: string): Rule[] {
	return [
		...readRulesFromDir(userRulesDir()),
		...readRulesFromDir(path.join(cwd, PROJECT_RULES_DIR)),
	];
}

export function parseCatalog(json: unknown): CatalogEntry[] {
	if (!Array.isArray(json)) {
		return [];
	}
	return json.flatMap((file) => {
		const fields = file as { name?: unknown; download_url?: unknown };
		return typeof fields.name === "string" &&
			fields.name.endsWith(".md") &&
			typeof fields.download_url === "string"
			? [{ name: fields.name, downloadUrl: fields.download_url }]
			: [];
	});
}

async function fetchText(url: string): Promise<string> {
	const response = await fetch(url);
	if (!response.ok) {
		throw new Error(`HTTP ${response.status} for ${url}`);
	}
	return response.text();
}

async function fetchCatalog(): Promise<CatalogEntry[]> {
	return parseCatalog(JSON.parse(await fetchText(CATALOG_URL)));
}

function loadToolRules(cwd: string): Rule[] {
	return [
		...readRulesFromDir(path.join(userDir(), "tool-rules")),
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
		'Copy each "rule" value verbatim from its ### heading above. Never invent a name.',
		'Respond with ONLY this JSON, nothing else: {"pass": true|false, "violations": [{"rule": "<### heading>", "reason": "short reason"}, ...]}',
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

function blockedRulesText(rules: Rule[], violations: Violation[]): string {
	return rules
		.filter((rule) =>
			violations.some(
				(v) => v.rule === rule.name || rule.text.includes(v.rule),
			),
		)
		.map((rule) => `### ${rule.name}\n${rule.text}`)
		.join("\n\n");
}

function buildOverridePrompt(
	rules: Rule[],
	violations: Violation[],
	toolName: string,
	input: unknown,
	userRequest: string,
): string {
	const blocked = blockedRulesText(rules, violations);
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

function normalizeName(text: string): string {
	return text.toLowerCase().replace(/[^a-z0-9]/g, "");
}

function ruleAliases(rule: Rule): string[] {
	return [rule.name.replace(/\.md$/, ""), rule.text.match(/^#\s+(.+)$/m)?.[1]]
		.map((alias) => normalizeName(alias ?? ""))
		.filter((alias) => alias.length > 0);
}

export function rulesViolation(violation: Violation, rule: Rule): boolean {
	const reported = normalizeName(violation.rule);
	return (
		reported.length > 0 &&
		(rule.text.includes(violation.rule) ||
			ruleAliases(rule).some(
				(alias) => reported.includes(alias) || alias.includes(reported),
			))
	);
}

export function applyOnceRules(
	rules: Rule[],
	violations: Violation[],
	spent: string[],
): { violations: Violation[]; spent: string[] } {
	const capped = rules.filter((rule) => rule.once !== undefined);
	const used = new Set(spent);
	const kept: Violation[] = [];
	for (const violation of violations) {
		const rule = capped.find((candidate) =>
			rulesViolation(violation, candidate),
		);
		if (!rule) {
			kept.push(violation);
			continue;
		}
		if (used.has(rule.name)) {
			continue;
		}
		used.add(rule.name);
		kept.push(rule.once ? { ...violation, reason: rule.once } : violation);
	}
	return { violations: kept, spent: [...used] };
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

export function emptiedReply<T extends object>(message: T): T {
	return { ...message, content: [] } as T;
}

function oneLine(text: string): string {
	return [...text]
		.map((char) => (char < " " || char === "\u007f" ? " " : char))
		.join("")
		.replace(/\s+/g, " ")
		.trim();
}

export function withheldLines(
	violations: Violation[],
	expanded: boolean,
	expandKey: string,
): string[] {
	const rules = [
		...new Set(violations.map((violation) => oneLine(violation.rule))),
	];
	const head = `Withheld by classifier. rule: ${rules.join(", ")}`;
	if (expanded) {
		return [
			head,
			...violations.map((violation) => `  ${oneLine(violation.reason)}`),
		];
	}
	return [expandKey ? `${head} (${expandKey} to expand)` : head];
}

function isFinalAssistantReply(message: EndedMessage): boolean {
	return message.role === "assistant" && message.stopReason === "stop";
}

class Classifier {
	private rules: Rule[] = [];
	private toolRules: Rule[] = [];
	private readonly disabledRules = new Set<string>();
	private userRequest = "";
	private spent: string[] = [];
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
		const saved = readConfigFile(globalConfigPath());
		this.isEnabled = saved.enabled !== false;
		if (ctx.hasUI && this.rules.length + this.toolRules.length === 0) {
			ctx.ui.notify(
				"Classifier: no rules installed. Run /classifier-install to pick one from the catalog.",
				"warning",
			);
		}
		for (const name of saved.disabledRules ?? []) {
			this.disabledRules.add(name);
		}
		this.showIdleStatus(ctx);
	}

	private activeRules(rules: Rule[]): Rule[] {
		return rules.filter((rule) => !this.disabledRules.has(rule.name));
	}

	hideDraft(message: DraftMessage): void {
		if (
			this.isEnabled &&
			this.activeRules(this.rules).length > 0 &&
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
		const limited = applyOnceRules(this.rules, verdict.violations, this.spent);
		const violations = limited.violations;
		if (violations.length === 0) {
			this.setStatus(ctx, `${ENABLED_MARK} classifier \u2713`);
			return undefined;
		}
		this.spent = limited.spent;
		this.requestRewrite(ctx, reply, violations);
		this.announceWithheld(violations);
		return { message: emptiedReply(event.message) };
	}

	private async classifyToolCall(
		ctx: ExtensionContext,
		event: { toolName: string; input: unknown },
	): Promise<Verdict | undefined> {
		try {
			debugLog(
				buildToolPrompt(
					this.activeRules(this.toolRules),
					event.toolName,
					event.input,
					this.userRequest,
				),
			);
			return await requestVerdict(
				ctx,
				this.modelSpec,
				buildToolPrompt(
					this.activeRules(this.toolRules),
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
					this.activeRules(this.toolRules),
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
		if (text.startsWith(FEEDBACK_PREFIX)) {
			return;
		}
		this.spent = [];
		if (text.length > 0) {
			this.userRequest = text;
		}
	}

	async onToolCall(
		event: { toolName: string; input: unknown },
		ctx: ExtensionContext,
	): Promise<{ block: true; reason: string } | undefined> {
		if (!this.isEnabled || this.activeRules(this.toolRules).length === 0) {
			return undefined;
		}
		this.setStatus(ctx, `${ENABLED_MARK} classifier \u2026`);
		const verdict = await this.classifyToolCall(ctx, event);
		if (!verdict) {
			return undefined;
		}
		const active = this.activeRules(this.toolRules);
		const violations = verdict.violations.filter((violation) =>
			active.some((rule) => rulesViolation(violation, rule)),
		);
		if (verdict.pass || violations.length === 0) {
			this.showIdleStatus(ctx);
			return undefined;
		}
		if (await this.userAskedFor(ctx, event, violations)) {
			this.setStatus(ctx, `${ENABLED_MARK} classifier \u2713 user asked`);
			return undefined;
		}
		this.setStatus(ctx, `${ENABLED_MARK} classifier \u2298 ${event.toolName}`);
		return {
			block: true,
			reason: violations.map(formatViolation).join("\n"),
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

	saveState(ctx: ExtensionContext): void {
		try {
			saveGlobalConfig({
				enabled: this.isEnabled,
				disabledRules: [...this.disabledRules],
			});
		} catch (error) {
			debugLog(`save failed: ${String(error)}`);
			if (ctx.hasUI) {
				ctx.ui.notify(`Classifier save failed: ${String(error)}`, "error");
			}
			return;
		}
		if (ctx.hasUI) {
			ctx.ui.notify("Classifier state saved for new sessions", "info");
		}
	}

	menuRows(): string[] {
		return [
			`${this.isEnabled ? ENABLED_MARK : DISABLED_MARK} classifier (all rules)`,
			...[...this.rules, ...this.toolRules].map(
				(rule) =>
					`${this.isEnabled && !this.disabledRules.has(rule.name) ? ENABLED_MARK : DISABLED_MARK} ${rule.name}`,
			),
		];
	}

	toggleRow(index: number, ctx: ExtensionContext): void {
		if (index === 0) {
			this.isEnabled = !this.isEnabled;
		} else {
			const rule = [...this.rules, ...this.toolRules][index - 1];
			if (rule && !this.disabledRules.delete(rule.name)) {
				this.disabledRules.add(rule.name);
			}
		}
		this.showIdleStatus(ctx);
	}

	private async pickCatalogRule(
		ctx: ExtensionContext,
	): Promise<CatalogEntry | undefined> {
		const installed = new Set(loadRules(ctx.cwd).map((rule) => rule.name));
		const available = (await fetchCatalog()).filter(
			(entry) => !installed.has(entry.name),
		);
		if (available.length === 0) {
			ctx.ui.notify("No new rules available in the catalog", "info");
			return undefined;
		}
		const choice = await ctx.ui.select(
			"Install a rule to ~/.pi/agent/output-rules/",
			available.map((entry) => entry.name),
		);
		return available.find((candidate) => candidate.name === choice);
	}

	async installRule(ctx: ExtensionContext): Promise<void> {
		if (!ctx.hasUI) {
			return;
		}
		try {
			const entry = await this.pickCatalogRule(ctx);
			if (!entry) {
				return;
			}
			const text = await fetchText(entry.downloadUrl);
			fs.mkdirSync(userRulesDir(), { recursive: true });
			fs.writeFileSync(path.join(userRulesDir(), entry.name), text);
			this.rules = loadRules(ctx.cwd);
			this.showIdleStatus(ctx);
			ctx.ui.notify(`Installed ${entry.name}`, "info");
		} catch (error) {
			debugLog(`install failed: ${String(error)}`);
			ctx.ui.notify(`Rule install failed: ${String(error)}`, "error");
		}
	}

	async openMenu(ctx: ExtensionContext): Promise<void> {
		if (ctx.mode !== "tui") {
			this.toggle(ctx);
			return;
		}
		await ctx.ui.custom<void>((tui, theme, _keybindings, done) =>
			this.menuComponent(ctx, tui, theme, done),
		);
	}

	private menuComponent(
		ctx: ExtensionContext,
		tui: { requestRender(): void },
		theme: MenuTheme,
		done: () => void,
	) {
		let cursor = 0;
		return {
			render: () => {
				const rows = this.menuRows();
				cursor = Math.min(cursor, rows.length - 1);
				return [
					theme.fg("accent", theme.bold("Classifier rules")),
					...rows.map((row, i) =>
						i === cursor
							? theme.fg("accent", `> ${row}`)
							: theme.fg("text", `  ${row}`),
					),
					theme.fg("dim", "↑↓ move • enter toggle • s save • esc close"),
				];
			},
			handleInput: (data: string) => {
				const rows = this.menuRows().length;
				if (data === "\u001b[A") {
					cursor = (cursor - 1 + rows) % rows;
				} else if (data === "\u001b[B") {
					cursor = (cursor + 1) % rows;
				} else if (data === "\r" || data === "\n" || data === " ") {
					this.toggleRow(cursor, ctx);
				} else if (data === "s" || data === "S") {
					this.saveState(ctx);
				} else if (data === "\u001b" || data === "\u0003") {
					done();
					return;
				}
				tui.requestRender();
			},
			invalidate: () => {},
		};
	}

	private replyToCheck(message: EndedMessage): string | undefined {
		if (
			!this.isEnabled ||
			this.activeRules(this.rules).length === 0 ||
			!isFinalAssistantReply(message)
		) {
			return undefined;
		}
		const reply = textFromContent(message.content);
		if (reply.length < MIN_REPLY_LENGTH) {
			return undefined;
		}
		return reply;
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
				buildClassifierPrompt(this.activeRules(this.rules), reply),
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

	private announceWithheld(violations: Violation[]): void {
		try {
			this.pi.appendEntry<WithheldEntry>(WITHHELD_ENTRY_TYPE, { violations });
		} catch (error) {
			debugLog(`entry skipped, session is shutting down: ${String(error)}`);
		}
	}

	private setStatus(ctx: ExtensionContext, text: string): void {
		if (ctx.hasUI) {
			ctx.ui.setStatus(STATUS_KEY, text);
		}
	}

	private showIdleStatus(ctx: ExtensionContext): void {
		if (!this.isEnabled) {
			this.setStatus(ctx, `${DISABLED_MARK} classifier off`);
			return;
		}
		if (this.rules.length + this.toolRules.length === 0) {
			this.setStatus(ctx, `${DISABLED_MARK} classifier (no rules)`);
			return;
		}
		const count =
			this.activeRules(this.rules).length +
			this.activeRules(this.toolRules).length;
		this.setStatus(ctx, `${ENABLED_MARK} classifier (${count})`);
	}
}

function registerCommands(pi: ExtensionAPI, classifier: Classifier) {
	pi.registerCommand("classifier", {
		description:
			"Toggle the classifier or individual rules (output rules in .pi/output-rules/, tool rules in .pi/tool-rules/)",
		handler: async (_args, ctx) => classifier.openMenu(ctx),
	});
	pi.registerCommand("classifier-install", {
		description:
			"Pick a rule from the catalog on GitHub and install it to ~/.pi/agent/output-rules/",
		handler: async (_args, ctx) => classifier.installRule(ctx),
	});
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
	pi.registerEntryRenderer<WithheldEntry>(
		WITHHELD_ENTRY_TYPE,
		(entry, { expanded }, theme) => {
			const violations = entry.data?.violations ?? [];
			const lines = withheldLines(violations, expanded, keyText(EXPAND_KEY));
			return new Text(theme.fg("muted", lines.join("\n")), 1, 0);
		},
	);
	pi.on("input", async (event) => classifier.captureUserRequest(event.text));
	pi.on("tool_call", async (event, ctx) => classifier.onToolCall(event, ctx));
	registerCommands(pi, classifier);
}
