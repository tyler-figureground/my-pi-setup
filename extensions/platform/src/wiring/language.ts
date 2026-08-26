import { readFile, realpath } from "node:fs/promises";
import path from "node:path";
import { StringEnum } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import type {
  LanguageIntelligence,
  LanguageQuery,
  LanguageQueryKind,
} from "../language/index.ts";

const OPERATION_TOOLS = [
  "lsp_diagnostics",
  "lsp_symbols",
  "lsp_navigate",
  "lsp_hover",
  "lsp_call_hierarchy",
] as const;
const ALL_LANGUAGE_TOOLS = new Set<string>([
  "language_tools",
  ...OPERATION_TOOLS,
]);

export interface LanguageCapability {
  start(language: LanguageIntelligence): void;
  stop(): Promise<void>;
}

export interface CreateLanguageCapabilityOptions {
  readonly readDocument?: (absolutePath: string) => Promise<string>;
  readonly canonicalizeDocument?: (absolutePath: string) => Promise<string>;
}

function normalizedPath(cwd: string, input: string) {
  const withoutAt = input.startsWith("@") ? input.slice(1) : input;
  return path.resolve(cwd, withoutAt);
}

function textResult(value: unknown) {
  const text = JSON.stringify(value, null, 2);
  return { content: [{ type: "text" as const, text }], details: value };
}

function throwFailure<T>(outcome: {
  readonly ok: boolean;
  readonly value?: T;
  readonly error?: { readonly message: string };
}) {
  if (!outcome.ok)
    throw new Error(outcome.error?.message ?? "Language request failed.");
  return outcome.value as T;
}

function toolsForQueries(queries: ReadonlySet<LanguageQueryKind>) {
  const tools: string[] = [];
  if (queries.has("diagnostics")) tools.push("lsp_diagnostics");
  if (queries.has("documentSymbols") || queries.has("workspaceSymbols"))
    tools.push("lsp_symbols");
  if (
    queries.has("definition") ||
    queries.has("references") ||
    queries.has("implementations")
  )
    tools.push("lsp_navigate");
  if (queries.has("hover")) tools.push("lsp_hover");
  if (queries.has("callHierarchy")) tools.push("lsp_call_hierarchy");
  return tools;
}

export function createLanguageCapability(
  pi: ExtensionAPI,
  options: CreateLanguageCapabilityOptions = {},
): LanguageCapability {
  const readDocument =
    options.readDocument ?? ((filePath) => readFile(filePath, "utf8"));
  const canonicalizeDocument = options.canonicalizeDocument ?? realpath;
  const opened = new Set<string>();
  let language: LanguageIntelligence | undefined;

  const syncPath = async (cwd: string, input: string, signal?: AbortSignal) => {
    const absolutePath = normalizedPath(cwd, input);
    const canonicalPath = await canonicalizeDocument(absolutePath);
    const key =
      process.platform === "win32"
        ? canonicalPath.replaceAll("\\", "/").toLowerCase()
        : canonicalPath;
    const text = await readDocument(canonicalPath);
    let kind: "change" | "open" = opened.has(key) ? "change" : "open";
    let outcome = await language!.synchronize(
      [{ kind, path: canonicalPath, text }],
      signal,
    );
    if (
      !outcome.ok &&
      kind === "change" &&
      /not open/i.test(outcome.error.message)
    ) {
      kind = "open";
      outcome = await language!.synchronize(
        [{ kind, path: canonicalPath, text }],
        signal,
      );
    }
    throwFailure(outcome);
    opened.add(key);
    return canonicalPath;
  };

  const executeQuery = async (request: LanguageQuery, signal?: AbortSignal) =>
    textResult(throwFailure(await language!.query(request, signal)));

  pi.registerTool({
    name: "language_tools",
    label: "Language Tools",
    description:
      "Discover and add project language-intelligence tools without starting a language server.",
    promptSnippet:
      "Discover deferred diagnostics and semantic navigation tools for the current project",
    promptGuidelines: [
      "Use language_tools only when diagnostics or semantic symbol navigation would help; repository-native checks remain authoritative.",
    ],
    parameters: Type.Object({
      query: Type.Optional(
        Type.String({
          description:
            "Language or semantic operation needed, used only for display and discovery context.",
          maxLength: 200,
        }),
      ),
    }),
    async execute(_toolCallId, params) {
      if (!language) throw new Error("Language intelligence is unavailable.");
      const discovery = throwFailure(await language.discover());
      const queries = new Set(
        discovery.servers.flatMap((server) => server.queries),
      );
      const added = toolsForQueries(queries).filter(
        (name) => !pi.getActiveTools().includes(name),
      );
      pi.setActiveTools([...new Set([...pi.getActiveTools(), ...added])]);
      return textResult({
        query: params.query,
        advisory: true,
        authority: "repository-native-checks",
        servers: discovery.servers,
        added,
      });
    },
  });

  pi.registerTool({
    name: "lsp_diagnostics",
    label: "LSP Diagnostics",
    description:
      "Return bounded advisory language-server diagnostics for one project file. Native typecheck/lint/build remains authoritative.",
    parameters: Type.Object({
      path: Type.String({
        description: "Project file path to synchronize and diagnose.",
      }),
    }),
    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      if (!language) throw new Error("Language intelligence is unavailable.");
      const filePath = await syncPath(ctx.cwd, params.path, signal);
      return executeQuery({ kind: "diagnostics", path: filePath }, signal);
    },
  });

  pi.registerTool({
    name: "lsp_symbols",
    label: "LSP Symbols",
    description:
      "Return bounded document or workspace symbols from a persistent language server.",
    parameters: Type.Object({
      scope: StringEnum(["document", "workspace"] as const, {
        description:
          "Document symbols require path; workspace symbols require query.",
      }),
      path: Type.Optional(
        Type.String({ description: "Project file path for document symbols." }),
      ),
      query: Type.Optional(
        Type.String({ description: "Workspace symbol name query." }),
      ),
    }),
    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      if (!language) throw new Error("Language intelligence is unavailable.");
      if (params.scope === "workspace")
        return executeQuery(
          { kind: "workspaceSymbols", query: params.query ?? "" },
          signal,
        );
      if (!params.path) throw new Error("Document symbols require path.");
      const filePath = await syncPath(ctx.cwd, params.path, signal);
      return executeQuery({ kind: "documentSymbols", path: filePath }, signal);
    },
  });

  const Position = Type.Object({
    line: Type.Integer({ minimum: 0, description: "Zero-based line." }),
    character: Type.Integer({
      minimum: 0,
      description: "Zero-based UTF-16 character.",
    }),
  });

  pi.registerTool({
    name: "lsp_navigate",
    label: "LSP Navigate",
    description:
      "Find definitions, references, or implementations at a zero-based source position.",
    parameters: Type.Object({
      operation: StringEnum([
        "definition",
        "references",
        "implementations",
      ] as const),
      path: Type.String({ description: "Project file path." }),
      position: Position,
    }),
    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      if (!language) throw new Error("Language intelligence is unavailable.");
      const filePath = await syncPath(ctx.cwd, params.path, signal);
      return executeQuery(
        { kind: params.operation, path: filePath, position: params.position },
        signal,
      );
    },
  });

  pi.registerTool({
    name: "lsp_hover",
    label: "LSP Hover",
    description: "Return type hover at a zero-based source position.",
    parameters: Type.Object({
      path: Type.String({ description: "Project file path." }),
      position: Position,
    }),
    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      if (!language) throw new Error("Language intelligence is unavailable.");
      const filePath = await syncPath(ctx.cwd, params.path, signal);
      return executeQuery(
        { kind: "hover", path: filePath, position: params.position },
        signal,
      );
    },
  });

  pi.registerTool({
    name: "lsp_call_hierarchy",
    label: "LSP Call Hierarchy",
    description:
      "Return bounded incoming or outgoing calls at a zero-based source position.",
    parameters: Type.Object({
      direction: StringEnum(["incoming", "outgoing"] as const),
      path: Type.String({ description: "Project file path." }),
      position: Position,
    }),
    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      if (!language) throw new Error("Language intelligence is unavailable.");
      const filePath = await syncPath(ctx.cwd, params.path, signal);
      return executeQuery(
        {
          kind: "callHierarchy",
          path: filePath,
          position: params.position,
          direction: params.direction,
        },
        signal,
      );
    },
  });

  pi.on("tool_result", async (event, ctx) => {
    if (
      !language ||
      event.isError ||
      (event.toolName !== "write" && event.toolName !== "edit")
    )
      return;
    const input = event.input as { path?: unknown };
    if (typeof input.path !== "string") return;
    try {
      await syncPath(ctx.cwd, input.path, ctx.signal);
    } catch {
      // Post-edit language synchronization is advisory and cannot change the tool result.
    }
  });

  return {
    start(nextLanguage) {
      language = nextLanguage;
      opened.clear();
      const withoutOperations = pi
        .getActiveTools()
        .filter((name) => !OPERATION_TOOLS.includes(name as never));
      pi.setActiveTools([...new Set([...withoutOperations, "language_tools"])]);
    },
    async stop() {
      language = undefined;
      opened.clear();
      pi.setActiveTools(
        pi.getActiveTools().filter((name) => !ALL_LANGUAGE_TOOLS.has(name)),
      );
    },
  };
}
