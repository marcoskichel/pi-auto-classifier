import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import autoClassifier, {
	applyOnceRules,
	emptiedReply,
	parseCatalog,
	parseRule,
	rulesViolation,
	withheldLines,
} from "./index.ts";

function runNoComments(source: string): { code: number; output: string } {
	const file = path.join(
		fs.mkdtempSync(path.join(os.tmpdir(), "no-comments-")),
		"probe.ts",
	);
	fs.writeFileSync(file, source);
	try {
		execFileSync(
			"node",
			[path.join(import.meta.dirname, "no-comments.ts"), file],
			{ encoding: "utf8" },
		);
		return { code: 0, output: "" };
	} catch (error) {
		const failure = error as { status: number; stderr: string };
		return { code: failure.status, output: failure.stderr };
	}
}

type Handler = (event: never, ctx: never) => Promise<unknown>;
type Call = (event: unknown, ctx: unknown) => Promise<unknown>;
type Renderer = (
	entry: unknown,
	options: { expanded: boolean },
	theme: unknown,
) => { render: (width: number) => string[] };

function setup() {
	const handlers: Record<string, Handler> = {};
	const commands: Record<string, { handler: Handler }> = {};
	const sent: unknown[] = [];
	const entries: { customType: string; data: unknown }[] = [];
	const renderers: Record<string, Renderer> = {};
	const pi = {
		on: (name: string, fn: Handler) => {
			handlers[name] = fn;
		},
		registerCommand: (name: string, spec: { handler: Handler }) => {
			commands[name] = spec;
		},
		registerEntryRenderer: (customType: string, fn: Renderer) => {
			renderers[customType] = fn;
		},
		sendMessage: (message: unknown) => sent.push(message),
		appendEntry: (customType: string, data: unknown) =>
			entries.push({ customType, data }),
	};

	let status = "";
	const notices: string[] = [];
	const keys: string[] = [];
	let menuLines: string[] = [];
	const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "classifier-cwd-"));
	fs.mkdirSync(path.join(cwd, ".pi", "output-rules"), { recursive: true });
	fs.writeFileSync(
		path.join(cwd, ".pi", "output-rules", "tldr.md"),
		"# TLDR\nLead with the answer.",
	);
	const ctx = {
		cwd,
		hasUI: true,
		mode: "tui",
		ui: {
			custom: async (
				factory: (
					tui: unknown,
					theme: unknown,
					kb: unknown,
					done: () => void,
				) => {
					render: (width: number) => string[];
					handleInput: (data: string) => void;
				},
			) => {
				let open = true;
				const theme = {
					fg: (_color: string, text: string) => text,
					bold: (text: string) => text,
				};
				const component = factory(
					{ requestRender: () => {} },
					theme,
					{},
					() => {
						open = false;
					},
				);
				menuLines = component.render(80);
				for (const key of keys.splice(0)) {
					if (!open) {
						break;
					}
					component.handleInput(key);
					menuLines = component.render(80);
				}
			},
			setStatus: (_key: string, text: string) => {
				status = text;
			},
			notify: (text: string) => notices.push(text),
			setWidget: () => {},
		},
		modelRegistry: {
			find: () => undefined,
			getApiKeyAndHeaders: async () => ({ ok: false, error: "no auth" }),
		},
	};

	autoClassifier(pi as unknown as ExtensionAPI);
	return {
		handlers: handlers as Record<string, Call>,
		commands: commands as Record<string, { handler: Call }>,
		sent,
		entries,
		renderers,
		ctx,
		notices,
		keys,
		badge: () => status,
		menu: () => menuLines,
	};
}

test("no-comments flags a plain comment", () => {
	const result = runNoComments("// explain\nconst x = 1;\n");
	assert.equal(result.code, 1);
	assert.match(result.output, /unexpected comment/);
});

test("no-comments allows the ponytail prefix", () => {
	assert.equal(runNoComments("/* ponytail: known ceiling */\n").code, 0);
});

test("no-comments ignores comment lookalikes in literals", () => {
	const source = [
		'const url = "https://example.com";',
		"const re = /\\/\\/ nope/;",
		"const tpl = `// nope`;",
		"",
	].join("\n");
	assert.equal(runNoComments(source).code, 0);
});

test("session_start with no rules points at /classifier-install", async () => {
	process.env.PI_AUTO_CLASSIFIER_USER_DIR = fs.mkdtempSync(
		path.join(os.tmpdir(), "empty-user-"),
	);
	try {
		const app = setup();
		app.ctx.cwd = fs.mkdtempSync(path.join(os.tmpdir(), "no-rules-"));
		await app.handlers.session_start({}, app.ctx);
		assert.match(app.badge(), /no rules \(\/classifier-install\)/);
	} finally {
		delete process.env.PI_AUTO_CLASSIFIER_USER_DIR;
	}
});

test("session_start shows classifier state in the status bar", async () => {
	const app = setup();
	await app.handlers.session_start({}, app.ctx);
	assert.match(app.badge(), /classifier \(\d+\)/);
});

test("the top row marks every rule off, then restores them", async () => {
	const app = setup();
	await app.handlers.session_start({}, app.ctx);
	app.keys.push("\u001b[B", "\r", "\u001b[A", "\r");
	await app.commands.classifier.handler([], app.ctx);
	assert.match(app.badge(), /classifier off/);
	assert.ok(app.menu().every((line) => !line.includes("\u25CF")));
	app.keys.push("\r", "\u001b");
	await app.commands.classifier.handler([], app.ctx);
	const rows = app.menu();
	assert.ok(rows.some((line) => line.includes("\u25CB ")));
	assert.ok(rows.some((line) => line.includes("\u25CF ")));
});

test("menu toggles a single rule and keeps the cursor in place", async () => {
	const app = setup();
	await app.handlers.session_start({}, app.ctx);
	const total = Number(app.badge().match(/classifier \((\d+)\)/)?.[1]);
	app.keys.push("\u001b[B", "\r");
	await app.commands.classifier.handler([], app.ctx);
	assert.match(app.badge(), new RegExp(`classifier \\(${total - 1}\\)`));
	assert.ok(app.menu().some((line) => line.startsWith("> \u25CB ")));
});

test("menu toggles a rule back on", async () => {
	const app = setup();
	await app.handlers.session_start({}, app.ctx);
	const total = Number(app.badge().match(/classifier \((\d+)\)/)?.[1]);
	app.keys.push("\u001b[B", "\r", "\r", "\u001b");
	await app.commands.classifier.handler([], app.ctx);
	assert.match(app.badge(), new RegExp(`classifier \\(${total}\\)`));
});

test("s saves toggles and a new session restores them", async () => {
	const config = path.join(
		fs.mkdtempSync(path.join(os.tmpdir(), "classifier-config-")),
		"auto-classifier.json",
	);
	fs.writeFileSync(config, '{"model":"anthropic/keep-me"}');
	process.env.PI_AUTO_CLASSIFIER_CONFIG = config;
	try {
		const app = setup();
		await app.handlers.session_start({}, app.ctx);
		const total = Number(app.badge().match(/classifier \((\d+)\)/)?.[1]);
		app.keys.push("\u001b[B", "\r", "s", "\u001b");
		await app.commands.classifier.handler([], app.ctx);
		assert.deepEqual(app.notices, ["Classifier state saved for new sessions"]);
		const next = setup();
		await next.handlers.session_start({}, next.ctx);
		assert.match(next.badge(), new RegExp(`classifier \\(${total - 1}\\)`));
		assert.equal(
			JSON.parse(fs.readFileSync(config, "utf8")).model,
			"anthropic/keep-me",
		);
	} finally {
		delete process.env.PI_AUTO_CLASSIFIER_CONFIG;
	}
});

test("message_start blanks assistant draft text", async () => {
	const app = setup();
	await app.handlers.session_start({}, app.ctx);
	const message = {
		role: "assistant",
		content: [{ type: "text", text: "secret draft" }],
	};
	await app.handlers.message_start({ message }, app.ctx);
	assert.deepEqual(message.content, [{ type: "text", text: "" }]);
});

test("message_start leaves user messages alone", async () => {
	const app = setup();
	await app.handlers.session_start({}, app.ctx);
	const message = { role: "user", content: [{ type: "text", text: "hello" }] };
	await app.handlers.message_start({ message }, app.ctx);
	assert.deepEqual(message.content, [{ type: "text", text: "hello" }]);
});

test("message_end ignores replies below the length floor", async () => {
	const app = setup();
	await app.handlers.session_start({}, app.ctx);
	const message = {
		role: "assistant",
		stopReason: "stop",
		content: [{ type: "text", text: "ok" }],
	};
	assert.equal(await app.handlers.message_end({ message }, app.ctx), undefined);
	assert.deepEqual(app.sent, []);
});

test("message_end never re-classifies an emptied reply", async () => {
	const app = setup();
	await app.handlers.session_start({}, app.ctx);
	const idle = app.badge();
	const message = { role: "assistant", stopReason: "stop", content: [] };
	assert.equal(await app.handlers.message_end({ message }, app.ctx), undefined);
	assert.deepEqual(app.sent, []);
	assert.deepEqual(app.entries, []);
	assert.equal(app.badge(), idle);
});

test("emptiedReply drops the text and keeps the role", () => {
	const message = {
		role: "assistant",
		stopReason: "stop",
		content: [{ type: "text", text: "draft" }],
	};
	assert.deepEqual(emptiedReply(message), {
		role: "assistant",
		stopReason: "stop",
		content: [],
	});
});

test("the entry renderer draws what the classifier appends", () => {
	const app = setup();
	const violations = [{ rule: "ste.md", reason: "passive voice" }];
	const renderer = app.renderers["auto-classifier-withheld"];
	const theme = { fg: (_color: string, text: string) => text };
	const draw = (data: unknown, expanded: boolean) =>
		renderer({ data }, { expanded }, theme)
			.render(120)
			.map((line) => line.trim());
	assert.deepEqual(draw({ violations }, true), [
		"Withheld by classifier. rule: ste.md",
		"passive voice",
	]);
	assert.deepEqual(draw(undefined, false), ["Withheld by classifier. rule:"]);
});

test("withheldLines drops the hint when no key is bound", () => {
	assert.deepEqual(
		withheldLines([{ rule: "ste.md", reason: "passive voice" }], false, ""),
		["Withheld by classifier. rule: ste.md"],
	);
});

test("withheldLines keeps a judge reason on one line", () => {
	const violations = [
		{ rule: "ste.md\nfake", reason: "passive\nvoice\u001b[31m" },
	];
	assert.deepEqual(withheldLines(violations, true, "ctrl+o"), [
		"Withheld by classifier. rule: ste.md fake",
		"  passive voice [31m",
	]);
});

test("withheldLines collapses to one line and expands to the reasons", () => {
	const violations = [
		{ rule: "tldr.md", reason: "buried answer" },
		{ rule: "ste.md", reason: "passive voice" },
	];
	assert.deepEqual(withheldLines(violations, false, "ctrl+o"), [
		"Withheld by classifier. rule: tldr.md, ste.md (ctrl+o to expand)",
	]);
	assert.deepEqual(withheldLines(violations, true, "ctrl+o"), [
		"Withheld by classifier. rule: tldr.md, ste.md",
		"  buried answer",
		"  passive voice",
	]);
});

test("withheldLines lists each rule once", () => {
	const violations = [
		{ rule: "ste.md", reason: "passive voice" },
		{ rule: "ste.md", reason: "long sentence" },
	];
	assert.deepEqual(withheldLines(violations, false, "ctrl+o"), [
		"Withheld by classifier. rule: ste.md (ctrl+o to expand)",
	]);
});

test("message_end passes the reply through when no model is configured", async () => {
	const app = setup();
	await app.handlers.session_start({}, app.ctx);
	const message = {
		role: "assistant",
		stopReason: "stop",
		content: [{ type: "text", text: "x".repeat(80) }],
	};
	assert.equal(await app.handlers.message_end({ message }, app.ctx), undefined);
	assert.deepEqual(app.sent, []);
	assert.match(app.badge(), /classifier/);
});

test("tool_call fails open and counts project tool rules", async () => {
	const app = setup();
	const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "tool-rules-"));
	fs.mkdirSync(path.join(cwd, ".pi", "tool-rules"), { recursive: true });
	fs.writeFileSync(
		path.join(cwd, ".pi", "tool-rules", "no-branch.md"),
		"Block git switch. Tell the assistant to use a worktree.",
	);
	const bare = setup();
	await bare.handlers.session_start({}, { ...bare.ctx, cwd: os.tmpdir() });
	const baseline = Number(bare.badge().match(/classifier \((\d+)\)/)?.[1]);
	const ctx = { ...app.ctx, cwd };
	await app.handlers.session_start({}, ctx);
	assert.match(app.badge(), new RegExp(`classifier \\(${baseline + 1}\\)`));
	const blocked = await app.handlers.tool_call(
		{ toolName: "bash", input: { command: "git switch -c feat" } },
		ctx,
	);
	assert.equal(blocked, undefined);
});

test("rulesViolation rejects invented rule names", () => {
	const rule = {
		name: "no-branch-switch.md",
		text: "# Never switch branches\nUse a worktree.",
	};
	assert.equal(
		rulesViolation({ rule: "no-branch-switch.md", reason: "x" }, rule),
		true,
	);
	assert.equal(
		rulesViolation({ rule: "Never switch branches", reason: "x" }, rule),
		true,
	);
	assert.equal(
		rulesViolation({ rule: "use-valid-model-names", reason: "x" }, rule),
		false,
	);
});

test("parseRule reads the once key and strips the frontmatter", () => {
	assert.deepEqual(
		parseRule("tldr.md", "---\nonce: be shorter\n---\n\n# TLDR\nbody"),
		{
			name: "tldr.md",
			text: "# TLDR\nbody",
			once: "be shorter",
		},
	);
	assert.deepEqual(parseRule("ste.md", "# STE\nbody\n"), {
		name: "ste.md",
		text: "# STE\nbody",
	});
	assert.deepEqual(
		parseRule("x.md", "---\nfoo: bar\n---\n# X").once,
		undefined,
	);
});

test("a once rule fails one time per turn and carries its own message", () => {
	const rules = [
		parseRule("tldr.md", "---\nonce: be shorter\n---\n\n# TLDR"),
		parseRule("ste.md", "# ASD-STE100 Simplified Technical English"),
	];
	const violations = [
		{ rule: "TLDR", reason: "rambling" },
		{ rule: "ASD-STE100 Simplified Technical English", reason: "passive" },
		{ rule: "tldr.md", reason: "still rambling" },
	];
	assert.deepEqual(applyOnceRules(rules, violations, []), {
		violations: [
			{ rule: "TLDR", reason: "be shorter" },
			{ rule: "ASD-STE100 Simplified Technical English", reason: "passive" },
		],
		spent: ["tldr.md"],
	});
	assert.deepEqual(applyOnceRules(rules, violations, ["tldr.md"]), {
		violations: [
			{ rule: "ASD-STE100 Simplified Technical English", reason: "passive" },
		],
		spent: ["tldr.md"],
	});
});

test("a once rule matches when the judge reports a bullet line as the rule", () => {
	const rules = [
		parseRule(
			"tldr.md",
			"---\nonce: be shorter\n---\n\n# TLDR\n- Lead with the answer or result. No preamble.",
		),
	];
	const violations = [
		{ rule: "Lead with the answer or result. No preamble.", reason: "buried" },
	];
	assert.deepEqual(applyOnceRules(rules, violations, []), {
		violations: [
			{
				rule: "Lead with the answer or result. No preamble.",
				reason: "be shorter",
			},
		],
		spent: ["tldr.md"],
	});
	assert.deepEqual(applyOnceRules(rules, violations, ["tldr.md"]), {
		violations: [],
		spent: ["tldr.md"],
	});
});

test("a once rule with no message keeps the judge reason", () => {
	const rules = [parseRule("brevity.md", "---\nonce:\n---\n# Brevity")];
	assert.deepEqual(
		applyOnceRules(rules, [{ rule: "brevity.md", reason: "too long" }], []),
		{
			violations: [{ rule: "brevity.md", reason: "too long" }],
			spent: ["brevity.md"],
		},
	);
});

test("parseCatalog keeps only .md files with a download url", () => {
	assert.deepEqual(
		parseCatalog([
			{ name: "tldr.md", download_url: "https://x/tldr.md" },
			{ name: "README.txt", download_url: "https://x/README.txt" },
			{ name: "broken.md" },
			"junk",
		]),
		[{ name: "tldr.md", downloadUrl: "https://x/tldr.md" }],
	);
	assert.deepEqual(parseCatalog({ message: "rate limited" }), []);
});
