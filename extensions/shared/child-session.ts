import { realpathSync } from "node:fs";
import * as path from "node:path";
import {
  createEventBus,
  DefaultResourceLoader,
  getAgentDir,
  ProjectTrustStore,
  SettingsManager,
  type AgentSession,
  type SessionShutdownEvent,
} from "@earendil-works/pi-coding-agent";
import {
  bindExecutionRole,
  type ChildExecutionRole,
} from "./execution-role.ts";

const CHILD_SHUTDOWN_TIMEOUT_MS = 5_000;

/** Tools that headless children must not receive. Everything else stays enabled. */
export const CHILD_EXCLUDED_TOOL_NAMES = [
  "subagent_spawn",
  "subagent_wait",
  "subagent_cancel",
  "subagent_check",
  "subagent_list",
  "workflow",
  "ask_user",
] as const;

/** Fresh SDK options avoid turning the denylist into an accidental allowlist. */
export function childToolPolicy(_role: ChildExecutionRole) {
  return { excludeTools: [...CHILD_EXCLUDED_TOOL_NAMES] };
}

export interface ChildResourceOptions {
  role: ChildExecutionRole;
  cwd: string;
  projectTrusted: boolean;
  appendSystemPrompt?: string[];
  agentDir?: string;
}

/** Load normal global/package resources and trust-gated project resources. */
export async function createChildResources(options: ChildResourceOptions) {
  const cwd = realpathSync.native(path.resolve(options.cwd));
  const agentDir = options.agentDir ?? getAgentDir();
  const settingsManager = SettingsManager.create(cwd, agentDir, {
    projectTrusted: options.projectTrusted,
  });
  const eventBus = createEventBus();
  bindExecutionRole(eventBus, options.role);
  const loader = new DefaultResourceLoader({
    cwd,
    agentDir,
    settingsManager,
    eventBus,
    ...(options.appendSystemPrompt
      ? { appendSystemPrompt: options.appendSystemPrompt }
      : {}),
  });
  await loader.reload();
  return {
    role: options.role,
    loader,
    settingsManager,
    sessionOptions: childToolPolicy(options.role),
  };
}

/**
 * Same-directory children inherit the live parent decision. An alternate cwd
 * is trusted only when Pi's persisted trust store explicitly trusts it (or a
 * containing directory); unreadable/invalid trust data fails closed.
 */
function canonicalTrustPath(value: string) {
  let canonical = path.normalize(value);
  if (process.platform !== "win32") return canonical;
  if (canonical.startsWith("\\\\?\\UNC\\")) {
    canonical = `\\\\${canonical.slice("\\\\?\\UNC\\".length)}`;
  } else if (canonical.startsWith("\\\\?\\")) {
    canonical = canonical.slice("\\\\?\\".length);
  }
  return canonical.toLowerCase();
}

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
      canonicalTrustPath(childCwd) === canonicalTrustPath(parentCwd)
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
