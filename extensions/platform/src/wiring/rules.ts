import path from "node:path";
import {
  CONFIG_DIR_NAME,
  type ExtensionAPI,
  type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import type {
  ActorRole,
  CapabilityPolicy,
  ToolSource,
} from "../core/policy/index.ts";
import type { ResolvedProjectIdentity } from "../core/projects/index.ts";
import {
  MAX_RULE_ACTIVATION_PATHS,
  createFileSystemRuleCatalog,
  type RuleActivation,
  type RuleCatalog,
} from "../rules/index.ts";

interface RulesCapabilityOptions {
  readonly pi: ExtensionAPI;
  readonly agentDir: string;
  readonly actor: ActorRole;
  readonly policy: CapabilityPolicy;
}

interface RulesSessionContext {
  readonly project: ResolvedProjectIdentity;
  readonly projectTrusted: boolean;
  readonly ctx: ExtensionContext;
}

function projectRoot(project: ResolvedProjectIdentity) {
  if (project.kind === "git") return project.currentWorktree;
  return project.canonicalCwd;
}

function diagnosticText(code: string, message: string) {
  return `[${code}] ${message}`;
}

function formatActivation(activation: RuleActivation) {
  if (activation.rules.length === 0) return undefined;
  return [
    "## Activated path-scoped rules",
    ...activation.rules.flatMap((rule) => [
      `### ${rule.id}`,
      `Source scope: ${rule.source.kind} (${rule.source.trust})`,
      rule.content,
    ]),
  ].join("\n\n");
}

function boundActivationPaths(paths: Set<string>) {
  const values = [...paths];
  return {
    paths: values.slice(0, MAX_RULE_ACTIVATION_PATHS),
    truncated: values.length > MAX_RULE_ACTIVATION_PATHS,
  };
}

function promptPaths(prompt: string) {
  const paths = new Set<string>();
  const patterns = [
    /`([^`\r\n]+[\\/][^`\r\n]+)`/g,
    /(?:^|\s)@([^\s,;]+[\\/][^\s,;]+)/g,
    /\b([A-Za-z0-9_.-]+[\\/][A-Za-z0-9_./\\-]+\.[A-Za-z0-9]+)\b/g,
  ];
  for (const pattern of patterns) {
    for (const match of prompt.matchAll(pattern)) {
      const candidate = match[1]?.trim();
      if (candidate && candidate.length <= 4_096) paths.add(candidate);
      if (paths.size > MAX_RULE_ACTIVATION_PATHS)
        return boundActivationPaths(paths);
    }
  }
  return boundActivationPaths(paths);
}

function toolPaths(event: {
  toolName: string;
  input: Record<string, unknown>;
}) {
  const paths = new Set<string>();
  const add = (value: unknown) => {
    if (
      typeof value === "string" &&
      value.length > 0 &&
      value.length <= 4_096
    ) {
      paths.add(value);
    }
    if (Array.isArray(value)) {
      for (const item of value.slice(0, 64)) add(item);
    }
  };
  for (const key of [
    "path",
    "paths",
    "file",
    "files",
    "cwd",
    "target",
    "directory",
    "renamedFrom",
  ]) {
    add(event.input[key]);
  }
  return boundActivationPaths(paths);
}

function toolResultPaths(event: {
  toolName: string;
  content: readonly { type: string; text?: string }[];
  details?: unknown;
}) {
  const paths = new Set<string>();
  let truncated = false;
  if (typeof event.details === "object" && event.details !== null) {
    const detailPaths = toolPaths({
      toolName: event.toolName,
      input: event.details as Record<string, unknown>,
    });
    truncated ||= detailPaths.truncated;
    for (const candidate of detailPaths.paths) paths.add(candidate);
  }
  if (["rg", "fd", "grep", "find", "ls"].includes(event.toolName)) {
    const text = event.content
      .filter(
        (block): block is { type: "text"; text: string } =>
          block.type === "text" && typeof block.text === "string",
      )
      .map((block) => block.text)
      .join("\n")
      .slice(0, 64 * 1024);
    for (const line of text.split(/\r?\n/).slice(0, 256)) {
      const trimmed = line.trim();
      const rgPath = /^(.+?):\d+(?::\d+)?:/.exec(trimmed)?.[1];
      const candidate = rgPath ?? trimmed;
      if (
        candidate &&
        candidate.length <= 4_096 &&
        !candidate.includes("\0") &&
        /[\\/]|\.[a-z0-9]{1,16}$/i.test(candidate)
      ) {
        paths.add(candidate);
        if (paths.size > MAX_RULE_ACTIVATION_PATHS) truncated = true;
      }
    }
  }
  const bounded = boundActivationPaths(paths);
  return { paths: bounded.paths, truncated: truncated || bounded.truncated };
}

export function createRulesCapability(options: RulesCapabilityOptions) {
  const { pi, agentDir, actor, policy } = options;
  let catalog: RuleCatalog | undefined;
  let epochCounter = 0;
  let currentEpoch = "startup";

  const nextEpoch = (context: ExtensionContext) => {
    currentEpoch = `${context.sessionManager.getSessionId()}:${context.sessionManager.getLeafId() ?? "root"}:${++epochCounter}`;
    return currentEpoch;
  };

  const notifyDiagnostics = (
    context: ExtensionContext,
    diagnostics: readonly { code: string; message: string }[],
  ) => {
    for (const diagnostic of diagnostics) {
      context.ui.notify(
        `Rule ${diagnosticText(diagnostic.code, diagnostic.message)}`,
        diagnostic.code.includes("ignored") ? "warning" : "error",
      );
    }
  };

  pi.registerCommand("rules", {
    description: "Inspect or reload path-scoped lazy rules.",
    handler: async (args, context) => {
      if (!context.hasUI) {
        throw new Error("Rule commands require TUI or RPC UI mode.");
      }
      if (!catalog) {
        context.ui.notify("Rules are not initialized.", "error");
        return;
      }
      if (args.trim() === "reload") {
        const result = await catalog.reload();
        notifyDiagnostics(context, result.diagnostics);
        context.ui.notify(`Reloaded ${result.rules.length} rule(s).`, "info");
        return;
      }
      const inspection = catalog.inspect();
      const lines = inspection.rules.map(
        (rule) =>
          `${rule.active ? "active" : "inactive"} ${rule.id} - ${rule.reason} - ${rule.source.path}`,
      );
      const diagnostics = inspection.diagnostics.map((entry) =>
        diagnosticText(entry.code, entry.message),
      );
      context.ui.notify(
        [...lines, ...diagnostics].join("\n") ||
          "No path-scoped rules configured.",
        diagnostics.length > 0 ? "warning" : "info",
      );
    },
  });

  pi.on("before_agent_start", async (event, context) => {
    if (!catalog) return;
    const epoch = nextEpoch(context);
    const extracted = promptPaths(event.prompt);
    if (extracted.truncated) {
      context.ui.notify(
        `Rule activation considered the first ${MAX_RULE_ACTIVATION_PATHS} prompt paths.`,
        "warning",
      );
    }
    if (extracted.paths.length === 0) return;
    const activation = await catalog.activate({
      paths: extracted.paths,
      contextEpoch: epoch,
    });
    notifyDiagnostics(context, activation.diagnostics);
    const content = formatActivation(activation);
    if (content) return { systemPrompt: `${event.systemPrompt}\n\n${content}` };
  });

  pi.on("context", (event) => {
    if (!catalog) return;
    return {
      messages: event.messages.filter((message) => {
        if (
          message.role !== "custom" ||
          message.customType !== "platform-lazy-rules"
        ) {
          return true;
        }
        const details = message.details;
        return (
          typeof details === "object" &&
          details !== null &&
          "contextEpoch" in details &&
          details.contextEpoch === currentEpoch
        );
      }),
    };
  });

  const deliverActivation = (activation: RuleActivation) => {
    const content = formatActivation(activation);
    if (!content) return false;
    pi.sendMessage(
      {
        customType: "platform-lazy-rules",
        content,
        display: true,
        details: {
          contextEpoch: currentEpoch,
          rules: activation.rules.map((rule) => ({
            id: rule.id,
            source: rule.source.kind,
          })),
        },
      },
      { deliverAs: "steer" },
    );
    return true;
  };

  pi.on("tool_call", async (event, context) => {
    if (!catalog) return;
    const extracted = toolPaths({
      toolName: event.toolName,
      input: event.input as Record<string, unknown>,
    });
    if (extracted.truncated) {
      context.ui.notify(
        `Rule activation considered the first ${MAX_RULE_ACTIVATION_PATHS} tool paths.`,
        "warning",
      );
    }
    if (extracted.paths.length === 0) return;
    const activation = await catalog.activate({
      paths: extracted.paths,
      contextEpoch: currentEpoch,
    });
    notifyDiagnostics(context, activation.diagnostics);
    if (deliverActivation(activation)) {
      const metadata = pi
        .getAllTools()
        .find((tool) => tool.name === event.toolName);
      const source: ToolSource =
        metadata?.sourceInfo.source === "builtin"
          ? "builtin"
          : metadata?.sourceInfo.source === "sdk"
            ? "sdk"
            : "custom";
      const decision = policy.decide(
        { kind: "tool", name: event.toolName, source },
        actor,
        { kind: "normal" },
      );
      if (decision.sideEffecting || decision.kind !== "allow") {
        return {
          block: true,
          reason:
            "Path-scoped rules activated before a potentially side-effecting operation. Review the injected rules, then retry the operation.",
        };
      }
    }
  });

  pi.on("tool_result", async (event, context) => {
    if (!catalog) return;
    const extracted = toolResultPaths({
      toolName: event.toolName,
      content: event.content,
      details: event.details,
    });
    if (extracted.truncated) {
      context.ui.notify(
        `Rule activation considered the first ${MAX_RULE_ACTIVATION_PATHS} result paths.`,
        "warning",
      );
    }
    if (extracted.paths.length === 0) return;
    const activation = await catalog.activate({
      paths: extracted.paths,
      contextEpoch: currentEpoch,
    });
    notifyDiagnostics(context, activation.diagnostics);
    deliverActivation(activation);
  });

  return {
    async start(input: RulesSessionContext) {
      const root = projectRoot(input.project);
      catalog = createFileSystemRuleCatalog({
        project: input.project,
        locations: {
          user: path.join(agentDir, "rules"),
          ...(root
            ? { project: path.join(root, CONFIG_DIR_NAME, "rules") }
            : {}),
          projectTrusted: input.projectTrusted,
        },
      });
      currentEpoch = nextEpoch(input.ctx);
      const result = await catalog.discover();
      notifyDiagnostics(input.ctx, result.diagnostics);
      return result;
    },
    stop() {
      catalog = undefined;
    },
    catalog: () => catalog,
  };
}
