import * as fs from "node:fs";
import ts from "typescript";

const ALLOWED_PREFIXES = ["ponytail:"];

function commentsIn(source: string): { line: number; text: string }[] {
	const scanner = ts.createScanner(
		ts.ScriptTarget.Latest,
		false,
		ts.LanguageVariant.Standard,
		source,
	);
	const found: { line: number; text: string }[] = [];
	let token = scanner.scan();
	while (token !== ts.SyntaxKind.EndOfFileToken) {
		const isComment =
			token === ts.SyntaxKind.SingleLineCommentTrivia ||
			token === ts.SyntaxKind.MultiLineCommentTrivia;
		if (isComment) {
			const text = scanner
				.getTokenText()
				.replace(/^\/[/*]+|\*\/$/g, "")
				.trim();
			const line = source.slice(0, scanner.getTokenStart()).split("\n").length;
			found.push({ line, text });
		}
		token = scanner.scan();
	}
	return found;
}

function isAllowed(text: string): boolean {
	return ALLOWED_PREFIXES.some((prefix) => text.startsWith(prefix));
}

const files = process.argv.slice(2);
let failures = 0;
for (const file of files) {
	const source = fs.readFileSync(file, "utf8");
	for (const comment of commentsIn(source)) {
		if (!isAllowed(comment.text)) {
			const allowed = ALLOWED_PREFIXES.join(", ");
			console.error(
				`${file}:${comment.line} unexpected comment. Code should be self-documenting. Allowed prefixes: ${allowed}`,
			);
			failures += 1;
		}
	}
}
if (failures > 0) {
	console.error(`\n${failures} comment(s) found.`);
	process.exit(1);
}
