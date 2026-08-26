import { existsSync, realpathSync } from "node:fs";
import * as path from "node:path";
import {
  createEventBus,
  DefaultResourceLoader,
  getAgentDir,
  ProjectTrustStore,
  SettingsManager,
  type AgentSession,
  type LoadExtensionsResult,
  type SessionShutdownEvent,
} from "@earendil-works/pi-coding-agent";
import {
  bindExecutionRole,
  type ChildExecutionRole,
} from "./execution-role.ts";

const CHILD_SHUTDOWN_TIMEOUT_MS = 5_000;

/** Canonical display form used wherever paths cross platform module seams. */
export function normalizeCanonicalPath(value: string) {
  let normalized = path.normalize(value);
  if (process.platform !== "win32") return normalized;
  if (normalized.startsWith("\\\\?\\UNC\\")) {
    normalized = `\\\\${normalized.slice("\\\\?\\UNC\\".length)}`;
  } else if (normalized.startsWith("\\\\?\\")) {
    normalized = normalized.slice("\\\\?\\".length);
  }
  const portable = normalized.replaceAll("\\", "/");
  return /^[a-z]:/i.test(portable)
    ? `${portable[0]?.toUpperCase()}${portable.slice(1)}`
    : portable;
}

/** Case-insensitive comparison key on Windows; display form elsewhere. */
export function canonicalPathKey(value: string) {
  const canonical = normalizeCanonicalPath(value);
  return process.platform === "win32" ? canonical.toLowerCase() : canonical;
}

/** Tools that headless children must not receive. Everything else stays enabled. */
export const CHILD_EXCLUDED_TOOL_NAMES = [
  "subagent_spawn",
  "subagent_wait",
  "subagent_cancel",
  "subagent_check",
  "subagent_list",
  "workflow",
  "workspace_list",
  "ask_user",
] as const;

/** Extensions whose public surface and session lifecycle belong to a parent. */
export const CHILD_EXCLUDED_EXTENSION_NAMES = [
  "ask-user",
  "copy-all",
  "git-info",
  "model-info",
  "platform",
  "subagents",
  "summaries",
  "ui-customization",
  "workflows",
] as const;

const compatibilityChildPolicy = {
  excludedTools: CHILD_EXCLUDED_TOOL_NAMES,
  excludedExtensions: CHILD_EXCLUDED_EXTENSION_NAMES,
};

const childRolePolicies = {
  subagent: compatibilityChildPolicy,
  workflow: compatibilityChildPolicy,
  review: compatibilityChildPolicy,
  scheduled: compatibilityChildPolicy,
  "goal-worker": compatibilityChildPolicy,
} as const satisfies Record<
  ChildExecutionRole,
  {
    excludedTools: readonly string[];
    excludedExtensions: readonly string[];
  }
>;

function childExtensionName(filePath: string) {
  const portable = normalizeCanonicalPath(filePath);
  const basename = path.posix.basename(portable);
  const entryName = basename.replace(/\.[^.]+$/, "");
  return entryName === "index"
    ? path.posix.basename(path.posix.dirname(portable))
    : entryName;
}

export function filterChildExtensions(
  base: LoadExtensionsResult,
  role: ChildExecutionRole,
) {
  const excluded = new Set<string>(childRolePolicies[role].excludedExtensions);
  return {
    ...base,
    extensions: base.extensions.filter(
      (extension) => !excluded.has(childExtensionName(extension.resolvedPath)),
    ),
  };
}

/** Fresh SDK options avoid turning the denylist into an accidental allowlist. */
export function childToolPolicy(
  role: ChildExecutionRole,
  restrictions: {
    readonly allowedTools?: readonly string[];
    readonly disallowedTools?: readonly string[];
  } = {},
) {
  const excludeTools = [
    ...new Set([
      ...childRolePolicies[role].excludedTools,
      ...(restrictions.disallowedTools ?? []),
    ]),
  ];
  return {
    ...(restrictions.allowedTools
      ? { tools: [...restrictions.allowedTools] }
      : {}),
    excludeTools,
  };
}

export function workspaceContainsWriteTarget(
  workspaceRoot: string,
  cwd: string,
  target: string,
) {
  try {
    const root = realpathSync.native(path.resolve(workspaceRoot));
    const requested = path.resolve(cwd, target);
    const canonical = existsSync(requested)
      ? realpathSync.native(requested)
      : path.join(
          realpathSync.native(path.dirname(requested)),
          path.basename(requested),
        );
    const nested = path.relative(root, canonical);
    return (
      nested !== ".." &&
      !nested.startsWith(`..${path.sep}`) &&
      !path.isAbsolute(nested)
    );
  } catch {
    return false;
  }
}

export interface ChildResourceOptions {
  role: ChildExecutionRole;
  cwd: string;
  projectTrusted: boolean;
  allowProjectResources?: boolean;
  allowContextFiles?: boolean;
  appendSystemPrompt?: string[];
  allowedTools?: readonly string[];
  disallowedTools?: readonly string[];
  writeRoot?: string;
  agentDir?: string;
}

/** Load normal global/package resources and trust-gated project resources. */
export async function createChildResources(options: ChildResourceOptions) {
  const cwd = realpathSync.native(path.resolve(options.cwd));
  const agentDir = options.agentDir ?? getAgentDir();
  const settingsManager = SettingsManager.create(cwd, agentDir, {
    projectTrusted:
      options.allowProjectResources === false ? false : options.projectTrusted,
  });
  const eventBus = createEventBus();
  bindExecutionRole(eventBus, options.role);
  const loader = new DefaultResourceLoader({
    cwd,
    agentDir,
    settingsManager,
    eventBus,
    ...(options.allowContextFiles === false ? { noContextFiles: true } : {}),
    extensionsOverride: (base) => filterChildExtensions(base, options.role),
    ...(options.appendSystemPrompt
      ? { appendSystemPrompt: options.appendSystemPrompt }
      : {}),
    ...(options.writeRoot
      ? {
          extensionFactories: [
            {
              name: "guarded-workspace-write-root",
              factory: (pi) => {
                pi.on("tool_call", (event) => {
                  if (event.toolName !== "write" && event.toolName !== "edit") {
                    return;
                  }
                  const input = event.input as { path?: unknown };
                  if (
                    typeof input.path !== "string" ||
                    !workspaceContainsWriteTarget(
                      options.writeRoot!,
                      cwd,
                      input.path,
                    )
                  ) {
                    return {
                      block: true,
                      terminate: true,
                      reason:
                        "Guarded workspace child cannot write outside its leased workspace.",
                    };
                  }
                });
              },
            },
          ],
        }
      : {}),
  });
  await loader.reload();
  return {
    role: options.role,
    loader,
    settingsManager,
    sessionOptions: childToolPolicy(options.role, {
      allowedTools: options.allowedTools,
      disallowedTools: options.disallowedTools,
    }),
  };
}

/**
 * Same-directory children inherit the live parent decision. An alternate cwd
 * is trusted only when Pi's persisted trust store explicitly trusts it (or a
 * containing directory); unreadable/invalid trust data fails closed.
 */
export function resolveStandaloneChildProjectContext(options: {
  parentCwd: string;
  childCwd: string;
  parentTrusted: boolean;
  agentDir?: string;
}) {
  try {
    const childCwd = realpathSync.native(path.resolve(options.childCwd));
    const parentCwd = realpathSync.native(path.resolve(options.parentCwd));
    const projectTrusted =
      canonicalPathKey(childCwd) === canonicalPathKey(parentCwd)
        ? options.parentTrusted
        : new ProjectTrustStore(options.agentDir ?? getAgentDir()).get(
            childCwd,
          ) === true;
    return { cwd: childCwd, projectTrusted };
  } catch {
    return { cwd: path.resolve(options.childCwd), projectTrusted: false };
  }
}

export function resolveStandaloneChildProjectTrust(
  options: Parameters<typeof resolveStandaloneChildProjectContext>[0],
) {
  return resolveStandaloneChildProjectContext(options).projectTrusted;
}

/** Start child extension session hooks/resources in headless print mode. */
export async function bindChildSessionExtensions(
  session: Pick<AgentSession, "bindExtensions">,
) {
  await session.bindExtensions({ mode: "print" });
}

interface ChildExtensionRunner {
  hasHandlers(eventType: string): boolean;
  emit(event: SessionShutdownEvent): Promise<unknown>;
}

export interface DisposableChildSession {
  readonly extensionRunner: ChildExtensionRunner;
  dispose(): void;
}

const childShutdowns = new WeakMap<object, Promise<void>>();

function waitBounded(operation: Promise<unknown>, timeoutMs: number) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<void>((resolve) => {
    timer = setTimeout(resolve, timeoutMs);
  });
  return Promise.race([
    operation.then(
      () => undefined,
      () => undefined,
    ),
    timeout,
  ])
    .catch(() => {})
    .finally(() => {
      if (timer) clearTimeout(timer);
    });
}

/**
 * Emit child session_shutdown once, then dispose once. Hook failures and a
 * bounded hook deadline never prevent disposal.
 */
export function shutdownAndDisposeChildSession(
  session: DisposableChildSession,
  options: { timeoutMs?: number } = {},
) {
  const existing = childShutdowns.get(session);
  if (existing) return existing;

  const shutdown = (async () => {
    try {
      if (session.extensionRunner.hasHandlers("session_shutdown")) {
        await waitBounded(
          session.extensionRunner.emit({
            type: "session_shutdown",
            reason: "quit",
          }),
          options.timeoutMs ?? CHILD_SHUTDOWN_TIMEOUT_MS,
        );
      }
    } catch {
      // Extension runner inspection/emission is best-effort during teardown.
    } finally {
      try {
        session.dispose();
      } catch {
        // Disposal is terminal and must remain idempotent for callers.
      }
    }
  })();

  childShutdowns.set(session, shutdown);
  return shutdown;
}
