import assert from "node:assert/strict";
import test from "node:test";

import outputClassifier from "./index.ts";

type Handler = (event: any, ctx: any) => Promise<any>;

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

	let widget: { render: (width: number) => string[] } | undefined;
	const notices: string[] = [];
	const ctx = {
		cwd: process.cwd(),
		hasUI: true,
		ui: {
			setStatus: () => {},
			notify: (text: string) => notices.push(text),
			setWidget: (_key: string, factory: (tui: any, theme: any) => any) => {
				widget = factory(
					{ requestRender: () => {} },
					{ fg: (_color: string, text: string) => text },
				);
			},
		},
		modelRegistry: {
			find: () => undefined,
			getApiKeyAndHeaders: async () => ({ ok: false, error: "no auth" }),
		},
	};

	outputClassifier(pi as any);
	return {
		handlers,
		commands,
		sent,
		ctx,
		notices,
		badge: () => widget?.render(60).join("") ?? "",
	};
}

test("session_start mounts a badge that renders classifier state", async () => {
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
