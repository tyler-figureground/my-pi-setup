import assert from "node:assert/strict";
import test from "node:test";
import { decodeLanguageServerConfiguration } from "./src/language/config.ts";

const prior = [
  {
    id: "prior",
    command: { executable: "prior-server" },
    selectors: [{ languageId: "prior", extensions: [".prior"] }],
    queries: ["diagnostics" as const],
  },
];

test("language config decodes strict argv routes", () => {
  const decoded = decodeLanguageServerConfiguration(
    [
      {
        id: "typescript",
        command: {
          argv: ["typescript-language-server", "--stdio"],
          env: { TSS_LOG: "-level off" },
        },
        selectors: [{ languageId: "typescript", extensions: [".ts", ".tsx"] }],
        queries: ["diagnostics", "definition", "references"],
        initializationOptions: { preferences: {} },
      },
    ],
    prior,
  );
  assert.deepEqual(decoded.diagnostics, []);
  assert.deepEqual(decoded.servers[0]?.command, {
    executable: "typescript-language-server",
    args: ["--stdio"],
    env: { TSS_LOG: "-level off" },
  });
});

test("one malformed server rejects the source atomically and preserves prior config", () => {
  const decoded = decodeLanguageServerConfiguration(
    [
      {
        id: "valid",
        command: { argv: ["valid-server"] },
        selectors: [{ languageId: "valid", extensions: [".valid"] }],
        queries: ["diagnostics"],
      },
      {
        id: "unsafe",
        command: "unsafe shell string",
        selectors: [],
        queries: ["diagnostics"],
      },
    ],
    prior,
  );
  assert.deepEqual(decoded.servers, prior);
  assert.ok(
    decoded.diagnostics.some(({ path }) =>
      path.startsWith("languageServers[1]"),
    ),
  );
});
