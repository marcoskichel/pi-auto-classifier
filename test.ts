import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import outputClassifier from "./index.ts";

function runNoComments(source: string): { code: number; output: string } {
	const file = path.join(
		fs.mkdtempSync(path.join(os.tmpdir(), "no-comments-")),
		"probe.ts",
	);
	fs.writeFileSync(file, source);
	try {
		execFileSync("node", ["no-comments.ts", file], { encoding: "utf8" });
		return { code: 0, output: "" };
	} catch (error) {
		const failure = error as { status: number; stderr: string };
		return { code: failure.status, output: failure.stderr };
	}
}

type Handler = (event: never, ctx: never) => Promise<unknown>;
type Call = (event: unknown, ctx: unknown) => Promise<unknown>;

function setup() {
	const handlers: Record<string, Handler> = {};
	const commands: Record<string, { handler: Handler }> = {};
	const sent: unknown[] = [];
	const pi = {
		on: (name: string, fn: Handler) => {
			handlers[name] = fn;
		},
		registerCommand: (name: string, spec: { handler: Handler }) => {
			commands[name] = spec;
		},
		sendMessage: (message: unknown) => sent.push(message),
	};

	let status = "";
	const notices: string[] = [];
	const ctx = {
		cwd: process.cwd(),
		hasUI: true,
		ui: {
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

	outputClassifier(pi as unknown as ExtensionAPI);
	return {
		handlers: handlers as Record<string, Call>,
		commands: commands as Record<string, { handler: Call }>,
		sent,
		ctx,
		notices,
		badge: () => status,
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

test("session_start shows classifier state in the status bar", async () => {
	const app = setup();
	await app.handlers.session_start({}, app.ctx);
	assert.match(app.badge(), /classifier \(\d+\)/);
});

test("toggle flips the badge and notifies", async () => {
	const app = setup();
	await app.handlers.session_start({}, app.ctx);
	await app.commands.classifier.handler([], app.ctx);
	assert.match(app.badge(), /classifier off/);
	assert.deepEqual(app.notices, ["Output classifier disabled"]);
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
