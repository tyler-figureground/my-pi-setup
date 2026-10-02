import assert from "node:assert/strict";
import { test } from "node:test";
import { toolResultPaths } from "./src/wiring/rules.ts";

function extract(text: string, toolName = "rg") {
  return toolResultPaths({ toolName, content: [{ type: "text", text }] });
}

test("search context lines deduplicate to real Windows paths, not Markdown content", () => {
  const file = String.raw`G:\Shared drives\ARCHITECTURE\_tools\Architecture-Prompts\02 Architecture Projects\Liberty - 80-23 64th Lane.md`;
  const lines = [
    `${file}:1:# Project`,
    ...Array.from({ length: 185 }, (_, i) => `${file}-${i + 2}-Read G:\\other\\PROJECT.md`),
    "--",
    "[Output truncated: full output saved to C:/temp/result.txt]",
  ];
  assert.deepEqual(extract(lines.join("\n")), { paths: [file], truncated: false });
});

test("search parses match, column and context prefixes but not unprefixed content", () => {
  assert.deepEqual(extract([
    "src/a.ts:12:3:match",
    "src/a.ts-13-context",
    "src/b.ts:5:match",
    "docs/guide.md-2-",
    "--",
    "Read src/not-a-result.ts",
    "rg: src/missing.ts: Permission denied",
  ].join("\n")), {
    paths: ["src/a.ts", "src/b.ts", "docs/guide.md"], truncated: false,
  });
});

test("grep context uses the same parser; filename listing still accepts bare paths", () => {
  assert.deepEqual(extract("src/a.ts-2-context", "grep").paths, ["src/a.ts"]);
  for (const tool of ["fd", "find", "ls"]) {
    assert.deepEqual(extract("src/a.ts\ndocs/guide.md", tool).paths, ["src/a.ts", "docs/guide.md"]);
  }
});

test("actual distinct search paths still report the activation cap", () => {
  const result = extract(Array.from({ length: 40 }, (_, i) => `src/${i}.ts:1:match`).join("\n"));
  assert.equal(result.paths.length, 32);
  assert.equal(result.truncated, true);
});
