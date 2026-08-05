import tsParser from "@typescript-eslint/parser";
import humanFirst from "eslint-plugin-human-first";
import perfectionist from "eslint-plugin-perfectionist";

export default [
	{
		files: ["**/*.ts"],
		ignores: ["test.ts"],
		languageOptions: { parser: tsParser },
		plugins: { "human-first": humanFirst, perfectionist },
		rules: {
			"human-first/no-comments": ["error", { allow: ["ponytail:"] }],
			"max-lines-per-function": [
				"error",
				{ max: 25, skipBlankLines: true, skipComments: true },
			],
			"perfectionist/sort-modules": [
				"error",
				{
					type: "unsorted",
					groups: [
						["declare-enum", "export-enum", "enum"],
						["declare-interface", "declare-type", "interface", "type"],
						["export-interface", "export-type"],
						["function", "async-function"],
						["export-function", "export-async-function"],
						["declare-class", "class", "export-class"],
						[
							"export-default-class",
							"export-default-function",
							"export-default-interface",
						],
					],
				},
			],
		},
	},
];
