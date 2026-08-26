import path from "node:path";
import type { JsonValue } from "../core/result.ts";
import type { LanguageIntelligence } from "../language/index.ts";
import type { ReviewCapture, ReviewEvidenceAdapter } from "./index.ts";

const MAX_FILES = 32;
const MAX_FILE_BYTES = 2 * 1024 * 1024;

function snapshot(value: unknown): JsonValue {
  return JSON.parse(JSON.stringify(value)) as JsonValue;
}

export function createLanguageReviewEvidence(
  language: LanguageIntelligence,
): ReviewEvidenceAdapter {
  const opened = new Set<string>();

  return {
    source: "lsp",
    async collect(capture: ReviewCapture, signal?: AbortSignal) {
      if (capture.requested.kind !== "uncommitted") {
        return {
          id: "lsp:diagnostics",
          source: "lsp",
          status: "unavailable",
          summary:
            "Historical review targets require an isolated language-server snapshot; live-root LSP evidence was not used.",
        };
      }
      const discovery = await language.discover();
      const extensions = new Set(
        discovery.value.servers
          .filter((server) => server.queries.includes("diagnostics"))
          .flatMap((server) =>
            server.extensions.map((value) => value.toLowerCase()),
          ),
      );
      const files = capture.files
        .filter(
          (file) =>
            extensions.has(path.extname(file.path).toLowerCase()) &&
            file.content?.worktree !== undefined,
        )
        .slice(0, MAX_FILES);
      if (files.length === 0) {
        return {
          id: "lsp:diagnostics",
          source: "lsp",
          status: "unavailable",
          summary:
            "No immutable target content matches a configured diagnostics server.",
        };
      }

      const results: unknown[] = [];
      let diagnosticCount = 0;
      let failures = 0;
      const evidenceDeadline = Date.now() + 5_000;
      for (const file of files) {
        signal?.throwIfAborted();
        const absolutePath = path.resolve(capture.root, file.path);
        const candidateLayers = [["worktree", file.content?.worktree]].filter(
          (entry): entry is [string, string] => typeof entry[1] === "string",
        );
        const seenContent = new Set<string>();
        const layers = candidateLayers.filter(([, text]) => {
          if (seenContent.has(text)) return false;
          seenContent.add(text);
          return true;
        });
        for (const [layer, text] of layers) {
          if (Buffer.byteLength(text) > MAX_FILE_BYTES) {
            failures++;
            results.push({
              path: file.path,
              layer,
              error: `Captured content exceeds ${MAX_FILE_BYTES} bytes.`,
            });
            continue;
          }
          try {
            const kind = opened.has(absolutePath) ? "change" : "open";
            let synchronized = await language.synchronize(
              [{ kind, path: absolutePath, text }],
              signal,
            );
            if (!synchronized.ok) {
              if (
                kind === "open" &&
                /already open/i.test(synchronized.error.message)
              ) {
                synchronized = await language.synchronize(
                  [{ kind: "change", path: absolutePath, text }],
                  signal,
                );
              } else if (
                kind === "change" &&
                /not open/i.test(synchronized.error.message)
              ) {
                synchronized = await language.synchronize(
                  [{ kind: "open", path: absolutePath, text }],
                  signal,
                );
              }
            }
            if (!synchronized.ok) throw new Error(synchronized.error.message);
            opened.add(absolutePath);
            let queried = await language.query(
              { kind: "diagnostics", path: absolutePath },
              signal,
            );
            if (!queried.ok) throw new Error(queried.error.message);
            while (
              queried.value.items.length === 0 &&
              Date.now() < evidenceDeadline
            ) {
              await new Promise((resolve) => setTimeout(resolve, 100));
              signal?.throwIfAborted();
              queried = await language.query(
                { kind: "diagnostics", path: absolutePath },
                signal,
              );
              if (!queried.ok) throw new Error(queried.error.message);
            }
            diagnosticCount += queried.value.items.length;
            results.push({ path: file.path, layer, result: queried.value });
          } catch (error) {
            failures++;
            results.push({
              path: file.path,
              layer,
              error: error instanceof Error ? error.message : String(error),
            });
          }
        }
      }
      const attempts = results.length;
      return {
        id: "lsp:diagnostics",
        source: "lsp",
        status:
          attempts === 0 || failures === attempts ? "unavailable" : "available",
        summary: `${diagnosticCount} diagnostic(s) across ${attempts - failures}/${attempts} immutable file layer(s).`,
        data: snapshot({
          results,
          truncatedFiles: Math.max(0, capture.files.length - files.length),
        }),
      };
    },
  };
}
