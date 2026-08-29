/**
 * Subagents — spawn background subagents on one of three backends
 * (pi, Claude Code, Codex) unified behind a single Effect service interface.
 *
 * Tools (for the parent LLM):
 * - subagent_spawn: fire-and-forget spawn (prompt, title, agent, working_dir,
 *   model, reasoning_effort). Max 4 running at once across all backends.
 * - subagent_wait: block until the listed subagents settle, return results.
 * - subagent_cancel: stop one or more running subagents.
 * - subagent_check: peek at a subagent's status and recent activity.
 * - subagent_list: list all subagents.
 *
 * Unawaited subagents queue their result as a follow-up message when they
 * settle. `/subagents` opens a picker + full interactive takeover view.
 *
 * Architecture: Effect v4 generators throughout (backends -> manager ->
 * runtime); this file is the async boundary where tool handlers run effects
 * against one shared ManagedRuntime. All three backends are real: pi runs
 * in-process SDK sessions, claude drives the Claude Agent SDK, codex speaks
 * JSON-RPC to a scoped `codex app-server` process.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { StringEnum } from "@earendil-works/pi-ai";
import type {
  ExtensionAPI,
  ExtensionCommandContext,
  ExtensionContext,
  ExtensionUIContext,
} from "@earendil-works/pi-coding-agent";
import {
  DEFAULT_MAX_BYTES,
  DEFAULT_MAX_LINES,
  formatSize,
  getMarkdownTheme,
  truncateHead,
} from "@earendil-works/pi-coding-agent";
import { Markdown, Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { deriveBtwTitle, isModelVisible } from "./src/by-the-way.ts";
import {
  BACKEND_NAMES,
  formatElapsed,
  latestText,
  REASONING_EFFORTS,
  type BackendName,
  type SpawnTask,
  type SubagentSnapshot,
} from "./src/domain.ts";
import {
  formatActivityStatus,
  formatContextUtilization,
} from "./src/format.ts";
import { SubagentManager, type SubagentManagerShape } from "./src/manager.ts";
import {
  buildSubagentResultMessage,
  buildSubagentSpawnResult,
  SUBAGENT_CANCEL_PARAMETER_DESCRIPTIONS,
  SUBAGENT_CANCEL_TOOL_DESCRIPTION,
  SUBAGENT_CHECK_PARAMETER_DESCRIPTIONS,
  SUBAGENT_CHECK_TOOL_DESCRIPTION,
  SUBAGENT_LIST_TOOL_DESCRIPTION,
  SUBAGENT_SPAWN_PARAMETER_DESCRIPTIONS,
  SUBAGENT_SPAWN_PROMPT_GUIDELINES,
  SUBAGENT_SPAWN_PROMPT_SNIPPET,
  SUBAGENT_SPAWN_TOOL_DESCRIPTION,
  SUBAGENT_WAIT_PARAMETER_DESCRIPTIONS,
  SUBAGENT_WAIT_TOOL_DESCRIPTION,
} from "./src/prompt.ts";
import { createDeferredResultDelivery } from "./src/result-delivery.ts";
import {
  createSubagentRuntime,
  runTool,
  type SubagentRuntime,
} from "./src/runtime.ts";
import { openSubagentPicker, openSubagentTakeover } from "./src/ui/takeover.ts";
import { createManagedLocalReviewer } from "./src/local-review.ts";
import { resolveStandaloneChildProjectContext } from "../shared/child-session.ts";
import type { ProfileCatalog } from "../platform/src/profiles/index.ts";
import { platformAgentServices } from "../platform/src/agents/services.ts";
import { bindNamedProfileExecutionPort } from "../platform/src/agents/named-profile-execution-service.ts";
import { createProjectIdentity } from "../platform/src/core/projects/index.ts";
import { bindLocalReviewer } from "../platform/src/review/reviewer-service.ts";
import { bindScheduledAgentExecutor } from "../shared/scheduled-agent.ts";
import { platformHookEventProducerFor } from "../platform/src/automation/platform-hook-event-sink.ts";
import {
  createScheduledAgentExecutor,
  type ScheduledSubagentManager,
} from "./src/scheduled-agent.ts";
import {
  createNamedProfileExecutionPort,
  type NamedProfileSubagentManager,
} from "./src/named-profile-execution.ts";
import type {
  WorkspaceInventory,
  WorkspaceLease,
  WorkspaceResult,
} from "../platform/src/workspaces/index.ts";

const SUBAGENT_OUTPUT_MAX_BYTES = 24 * 1024;
const WAIT_OUTPUT_MAX_BYTES = 48 * 1024;
const WAIT_PER_AGENT_MAX_BYTES = 16 * 1024;

interface BtwResultData {
  readonly id: string;
  readonly title: string;
  readonly status: SubagentSnapshot["status"];
  readonly errorText?: string;
  readonly prompt: string;
  readonly answer: string;
  readonly sessionFilePath?: string;
}

function inventoryDirtySummary(inventory: WorkspaceInventory) {
  return Object.entries(inventory)
    .filter(([key, value]) => key !== "entries" && value === true)
    .map(([key]) => key);
}

function describeSubagent(snap: SubagentSnapshot) {
  const details = [
    `${snap.backend}: ${snap.meta.modelLabel ?? "?"}`,
    formatContextUtilization(snap.usage),
    formatElapsed(snap),
    snap.profile ? `profile=${snap.profile.name}` : "",
    snap.workspace ? `workspace=${snap.workspace.workspaceId}` : "unisolated",
    snap.workspace ? snap.workspace.projectRoot : snap.cwd,
  ].filter(Boolean);
  return `${snap.id} [${snap.status}] "${snap.title}" (${details.join(", ")})`;
}

export function mapGuardedWorkspacePaths(
  snap: Pick<SubagentSnapshot, "workspace">,
  text: string,
) {
  return snap.workspace
    ? text
        .replaceAll(snap.workspace.path, snap.workspace.projectRoot)
        .replaceAll(
          snap.workspace.path.replaceAll("\\", "/"),
          snap.workspace.projectRoot.replaceAll("\\", "/"),
        )
    : text;
}

function truncatedOutput(
  snap: SubagentSnapshot,
  maxBytes = SUBAGENT_OUTPUT_MAX_BYTES,
): string {
  const rawOutput = snap.finalText || "(no output)";
  const output = mapGuardedWorkspacePaths(snap, rawOutput);
  const truncation = truncateHead(output, {
    maxBytes: Math.min(maxBytes, DEFAULT_MAX_BYTES),
    maxLines: Math.min(600, DEFAULT_MAX_LINES),
  });
  let text = truncation.content;
  if (truncation.truncated) {
    text += `\n\n[Output truncated: ${formatSize(truncation.outputBytes)} of ${formatSize(truncation.totalBytes)} shown. Full transcript in session file: ${snap.meta.sessionFilePath ?? "?"}]`;
  }
  return text;
}

export interface SubagentsExtensionOptions {
  profileCatalog?: ProfileCatalog;
  scheduledAgentManager?: () => Promise<ScheduledSubagentManager>;
  namedProfileManager?: () => Promise<NamedProfileSubagentManager>;
  spawn?: (
    harness: BackendName,
    task: SpawnTask,
    signal: AbortSignal | undefined,
  ) => Promise<SubagentSnapshot>;
}

export default function subagentsExtension(
  pi: ExtensionAPI,
  options: SubagentsExtensionOptions = {},
) {
  let runtime: SubagentRuntime | undefined;
  let managerPromise: Promise<SubagentManagerShape> | undefined;
  let sessionContext: ExtensionContext | undefined;
  let ui: ExtensionUIContext | undefined;
  let unsubStatus: (() => void) | undefined;
  let unbindLocalReviewer: (() => void) | undefined;
  let unbindScheduledAgentExecutor: (() => void) | undefined;
  let unbindNamedProfileExecutionPort: (() => void) | undefined;
  let unbindHookEvents: (() => void) | undefined;
  let scheduledManagerPromise: Promise<ScheduledSubagentManager> | undefined;
  let namedProfileManagerPromise:
    Promise<NamedProfileSubagentManager> | undefined;
  let scheduledGeneration = 0;
  let namedProfileGeneration = 0;
  let acceptingHookEvents = true;
  const scheduledLifecycle = new AbortController();
  const namedProfileLifecycle = new AbortController();
  const scheduledTitles = new Set<string>();
  const scheduledChildTitles = new Map<string, string>();
  const namedProfileTitles = new Set<string>();
  const namedProfileChildTitles = new Map<string, string>();
  const resultDelivery = createDeferredResultDelivery<SubagentSnapshot>();

  const getRuntime = () => (runtime ??= createSubagentRuntime());

  /** Resolve the manager service once per runtime and wire the extension hooks. */
  const getManager = () => {
    managerPromise ??= getRuntime()
      .runPromise(SubagentManager)
      .then((manager) => {
        if (acceptingHookEvents) {
          unbindHookEvents?.();
          unbindHookEvents = manager.bindHookEvents(
            platformHookEventProducerFor(pi.events, "subagents"),
          );
        }
        manager.view.setOnSettled(onSettled);
        unsubStatus?.();
        unsubStatus = manager.view.subscribe(() => updateStatus(manager));
        updateStatus(manager);
        return manager;
      });
    return managerPromise;
  };

  const updateStatus = (manager: SubagentManagerShape) => {
    if (!ui) return;
    const subs = manager.view.list();
    if (subs.length === 0) {
      ui.setStatus("subagents", undefined);
      return;
    }
    const running = subs.filter((snap) => snap.status === "running").length;
    const failed = subs.filter((snap) => snap.status === "error").length;
    const done = subs.length - running - failed;
    ui.setStatus(
      "subagents",
      formatActivityStatus(ui.theme, { running, done, failed }),
    );
  };

  const deliverResult = (snap: SubagentSnapshot) => {
    pi.sendMessage(
      {
        customType: "subagent-result",
        content: buildSubagentResultMessage({
          id: snap.id,
          title: snap.title,
          status: snap.status,
          errorText: snap.errorText,
          output: truncatedOutput(snap),
        }),
        display: true,
        details: { id: snap.id, title: snap.title, status: snap.status },
      },
      { deliverAs: "followUp", triggerTurn: true },
    );
  };

  const flushResults = () => {
    for (const snap of resultDelivery.drain()) deliverResult(snap);
  };

  const deliverBtwResult = (snap: SubagentSnapshot) => {
    // appendEntry is a synchronous SessionManager operation and emits an
    // entry_appended event, so it is safe while the parent is streaming and
    // never enters the model's context or follow-up queue.
    pi.appendEntry<BtwResultData>("btw-result", {
      id: snap.id,
      title: snap.title,
      status: snap.status,
      errorText: snap.errorText,
      prompt: snap.prompt,
      answer: truncatedOutput(snap),
      sessionFilePath: snap.meta.sessionFilePath,
    });
    ui?.notify(
      snap.status === "error"
        ? `by the way “${snap.title}” failed — reopen it with /subagents`
        : `by the way “${snap.title}” answered — reopen it with /subagents`,
      snap.status === "error" ? "error" : "info",
    );
  };

  const onSettled = (snap: SubagentSnapshot, consumed: boolean) => {
    // A shutdown can settle children while disposing their scopes. Never
    // append into a session whose extension runtime is already closing.
    if (!sessionContext) return;
    if (
      scheduledTitles.has(snap.title) ||
      scheduledChildTitles.has(snap.id) ||
      namedProfileTitles.has(snap.title) ||
      namedProfileChildTitles.has(snap.id)
    ) {
      resultDelivery.consume([snap.id]);
      return;
    }
    if (snap.origin === "btw") {
      deliverBtwResult({ ...snap, meta: { ...snap.meta } });
      return;
    }
    if (consumed) {
      resultDelivery.consume([snap.id]);
      return;
    }
    // Keep the result retractable while the parent is working. A later
    // subagent_wait can consume it before agent_settled flushes follow-ups.
    // Defer a copy: the live snapshot keeps mutating if the subagent is
    // restarted before the deferred result flushes.
    resultDelivery.defer({ ...snap, meta: { ...snap.meta } });
    if (sessionContext?.isIdle()) flushResults();
  };

  const getScheduledManager = () => {
    scheduledManagerPromise ??= (async () => {
      const base = options.scheduledAgentManager
        ? await options.scheduledAgentManager()
        : await (async () => {
            const activeRuntime = getRuntime();
            const manager = await getManager();
            return {
              spawn: (backend, task, signal) =>
                runTool(activeRuntime, manager.spawn(backend, task), {
                  signal,
                  interruptMessage: "Scheduled Agent spawn cancelled.",
                }),
              waitFor: (ids) => runTool(activeRuntime, manager.waitFor(ids)),
              get: (id) => runTool(activeRuntime, manager.get(id)),
              cancel: (ids) => runTool(activeRuntime, manager.cancel(ids)),
            } satisfies ScheduledSubagentManager;
          })();
      const untrack = (id: string) => {
        const title = scheduledChildTitles.get(id);
        if (title) scheduledTitles.delete(title);
        scheduledChildTitles.delete(id);
      };
      return {
        async spawn(backend, task, signal) {
          scheduledTitles.add(task.title);
          try {
            const started = await base.spawn(backend, task, signal);
            scheduledChildTitles.set(started.id, task.title);
            resultDelivery.consume([started.id]);
            return started;
          } catch (error) {
            scheduledTitles.delete(task.title);
            throw error;
          }
        },
        waitFor: (ids) => base.waitFor(ids),
        async get(id) {
          try {
            return await base.get(id);
          } finally {
            untrack(id);
          }
        },
        async cancel(ids) {
          try {
            return await base.cancel(ids);
          } finally {
            for (const id of ids) untrack(id);
          }
        },
      } satisfies ScheduledSubagentManager;
    })();
    return scheduledManagerPromise;
  };

  const getNamedProfileManager = () => {
    namedProfileManagerPromise ??= (async () => {
      const base = options.namedProfileManager
        ? await options.namedProfileManager()
        : await (async () => {
            const activeRuntime = getRuntime();
            const manager = await getManager();
            return {
              spawn: (backend, task, signal) =>
                runTool(activeRuntime, manager.spawn(backend, task), {
                  signal,
                  interruptMessage: "Named Profile Agent spawn cancelled.",
                }),
              waitFor: (ids) =>
                runTool(activeRuntime, manager.waitFor([...ids])),
              get: (id) => runTool(activeRuntime, manager.get(id)),
              cancel: (ids) => runTool(activeRuntime, manager.cancel([...ids])),
            } satisfies NamedProfileSubagentManager;
          })();
      const untrack = (id: string) => {
        const title = namedProfileChildTitles.get(id);
        if (title) namedProfileTitles.delete(title);
        namedProfileChildTitles.delete(id);
      };
      return {
        async spawn(backend, task, signal) {
          namedProfileTitles.add(task.title);
          try {
            const started = await base.spawn(backend, task, signal);
            namedProfileChildTitles.set(started.id, task.title);
            resultDelivery.consume([started.id]);
            return started;
          } catch (error) {
            namedProfileTitles.delete(task.title);
            throw error;
          }
        },
        waitFor: (ids) => base.waitFor(ids),
        async get(id) {
          try {
            return await base.get(id);
          } finally {
            untrack(id);
          }
        },
        async cancel(ids) {
          try {
            return await base.cancel(ids);
          } finally {
            for (const id of ids) untrack(id);
          }
        },
      } satisfies NamedProfileSubagentManager;
    })();
    return namedProfileManagerPromise;
  };

  const scheduledExecutor = createScheduledAgentExecutor({
    manager: getScheduledManager,
    parent: () => {
      const current = sessionContext;
      if (!current) {
        throw new Error(
          "Scheduled Agent executor is unavailable outside an active session.",
        );
      }
      return {
        parentCwd: current.cwd,
        projectTrusted: false,
        inheritedModel: current.model
          ? { provider: current.model.provider, id: current.model.id }
          : undefined,
        inheritedThinkingLevel: pi.getThinkingLevel(),
        modelRegistry: current.modelRegistry,
      };
    },
    workspaces: () => platformAgentServices(pi.events)?.workspaces,
    sessionId: () => {
      const current = sessionContext;
      if (!current) {
        throw new Error(
          "Scheduled Agent executor is unavailable outside an active session.",
        );
      }
      return current.sessionManager.getSessionId();
    },
    generation: () => scheduledGeneration,
    lifecycleSignal: () => scheduledLifecycle.signal,
  });
  unbindScheduledAgentExecutor = bindScheduledAgentExecutor(
    pi.events,
    scheduledExecutor,
  );

  const projectIdentity = createProjectIdentity();
  const namedProfileExecution = createNamedProfileExecutionPort({
    profiles: () =>
      options.profileCatalog ?? platformAgentServices(pi.events)?.profiles,
    manager: getNamedProfileManager,
    async context(cwd) {
      const current = sessionContext;
      if (!current) {
        throw new Error(
          "Named Profile execution is unavailable outside an active session.",
        );
      }
      const child = resolveStandaloneChildProjectContext({
        parentCwd: current.cwd,
        childCwd: cwd,
        parentTrusted: current.isProjectTrusted(),
      });
      const [catalogProject, requestedProject] = await Promise.all([
        projectIdentity.resolve(current.cwd),
        projectIdentity.resolve(child.cwd),
      ]);
      return {
        cwd: child.cwd,
        catalogProjectMatches:
          catalogProject.ok &&
          requestedProject.ok &&
          catalogProject.value.projectId === requestedProject.value.projectId,
        projectTrusted: child.projectTrusted,
        parent: {
          parentCwd: current.cwd,
          projectTrusted: child.projectTrusted,
          inheritedModel: current.model
            ? { provider: current.model.provider, id: current.model.id }
            : undefined,
          inheritedThinkingLevel: pi.getThinkingLevel(),
          modelRegistry: current.modelRegistry,
        },
      };
    },
    generation: () => namedProfileGeneration,
    lifecycleSignal: () => namedProfileLifecycle.signal,
  });
  unbindNamedProfileExecutionPort = bindNamedProfileExecutionPort(
    pi.events,
    namedProfileExecution,
  );

  pi.on("session_start", async (_event, ctx) => {
    sessionContext = ctx;
    if (ctx.hasUI) ui = ctx.ui;
    unbindLocalReviewer?.();
    unbindLocalReviewer = bindLocalReviewer(
      pi.events,
      createManagedLocalReviewer({
        parent: () => {
          const current = sessionContext;
          if (!current)
            throw new Error(
              "Local reviewer is unavailable outside an active session.",
            );
          return {
            parentCwd: current.cwd,
            projectTrusted: current.isProjectTrusted(),
            inheritedModel: current.model
              ? { provider: current.model.provider, id: current.model.id }
              : undefined,
            inheritedThinkingLevel: pi.getThinkingLevel(),
            modelRegistry: current.modelRegistry,
          };
        },
        run: async (task, signal) => {
          const manager = await getManager();
          const started = await runTool(
            getRuntime(),
            manager.spawn("pi", task),
            { signal, interruptMessage: "Local review cancelled." },
          );
          await runTool(getRuntime(), manager.waitFor([started.id]), {
            signal,
            interruptMessage: "Local review cancelled.",
          });
          const settled = await runTool(getRuntime(), manager.get(started.id));
          if (!settled)
            throw new Error("Local reviewer disappeared before settlement.");
          if (settled.status !== "done")
            throw new Error(settled.errorText ?? "Local reviewer failed.");
          return settled;
        },
      }),
    );
    const manager = platformAgentServices(pi.events)?.workspaces;
    if (!manager) return;
    const bindings = ctx.sessionManager
      .getBranch()
      .filter(
        (entry) =>
          entry.type === "custom" &&
          entry.customType === "guarded-workspace-binding",
      )
      .map(
        (entry) =>
          (entry as { data?: unknown }).data as {
            workspace?: SubagentSnapshot["workspace"];
          },
      )
      .filter((entry) => entry.workspace !== undefined);
    for (const binding of bindings.slice(-64)) {
      const workspace = binding.workspace!;
      const rebound = await manager.rebind({
        workspaceId: workspace.workspaceId,
        owner: workspace.owner,
        fence: workspace.fence,
      });
      if (rebound.ok) {
        if (ctx.hasUI) {
          ctx.ui.notify(
            `Guarded workspace ${workspace.workspaceId} remains leased; recovery waits for expiry or explicit cancellation.`,
            "info",
          );
        }
      } else if (
        (rebound.error.code === "IDENTITY_MISMATCH" ||
          rebound.error.code === "LEASE_LOST") &&
        ctx.hasUI
      ) {
        ctx.ui.notify(
          `Guarded workspace ${workspace.workspaceId} resume rejected: ${rebound.error.message}`,
          "warning",
        );
      }
    }
  });

  pi.on("agent_settled", flushResults);

  pi.on("session_shutdown", async () => {
    acceptingHookEvents = false;
    unbindNamedProfileExecutionPort?.();
    unbindNamedProfileExecutionPort = undefined;
    namedProfileGeneration++;
    namedProfileLifecycle.abort();
    unbindHookEvents?.();
    unbindHookEvents = undefined;
    unbindScheduledAgentExecutor?.();
    unbindScheduledAgentExecutor = undefined;
    scheduledGeneration++;
    scheduledLifecycle.abort();
    unbindLocalReviewer?.();
    unbindLocalReviewer = undefined;
    sessionContext = undefined;
    resultDelivery.clear();
    unsubStatus?.();
    unsubStatus = undefined;
    ui?.setStatus("subagents", undefined);
    ui = undefined;
    const closing = runtime;
    runtime = undefined;
    managerPromise = undefined;
    scheduledManagerPromise = undefined;
    namedProfileManagerPromise = undefined;
    scheduledTitles.clear();
    scheduledChildTitles.clear();
    namedProfileTitles.clear();
    namedProfileChildTitles.clear();
    // Disposing the runtime runs the manager finalizer, which tears down all
    // subagent scopes (and, later, their real child processes).
    await closing?.dispose();
  });

  // --- Tools -------------------------------------------------------------

  pi.registerTool({
    name: "subagent_spawn",
    label: "Spawn Subagent",
    description: SUBAGENT_SPAWN_TOOL_DESCRIPTION,
    promptSnippet: SUBAGENT_SPAWN_PROMPT_SNIPPET,
    promptGuidelines: SUBAGENT_SPAWN_PROMPT_GUIDELINES,
    parameters: Type.Object({
      prompt: Type.String({
        description: SUBAGENT_SPAWN_PARAMETER_DESCRIPTIONS.prompt,
      }),
      name: Type.String({
        description: SUBAGENT_SPAWN_PARAMETER_DESCRIPTIONS.name,
      }),
      harness: Type.Optional(
        StringEnum(BACKEND_NAMES, {
          description: SUBAGENT_SPAWN_PARAMETER_DESCRIPTIONS.harness,
        }),
      ),
      profile: Type.Optional(
        Type.String({
          description:
            "Persistent agent profile name. Supplies backend, restrictions, instructions, limits, role, and workspace policy.",
        }),
      ),
      working_dir: Type.Optional(
        Type.String({
          description: SUBAGENT_SPAWN_PARAMETER_DESCRIPTIONS.workingDir,
        }),
      ),
      model: Type.Optional(
        Type.String({
          description: SUBAGENT_SPAWN_PARAMETER_DESCRIPTIONS.model,
        }),
      ),
      reasoning_effort: Type.Optional(
        StringEnum(REASONING_EFFORTS, {
          description: SUBAGENT_SPAWN_PARAMETER_DESCRIPTIONS.reasoningEffort,
        }),
      ),
    }),
    async execute(toolCallId, params, signal, _onUpdate, ctx) {
      const profileCatalog =
        options.profileCatalog ?? platformAgentServices(pi.events)?.profiles;
      const profileResult = params.profile
        ? profileCatalog?.resolve(params.profile)
        : undefined;
      if (params.profile && !profileResult) {
        throw new Error(
          "Named agent profiles are unavailable in this session. Enable the profiles platform capability.",
        );
      }
      if (profileResult && !profileResult.ok) {
        throw new Error(profileResult.error.message);
      }
      const profile = profileResult?.ok ? profileResult.value : undefined;
      if (
        profile &&
        params.harness &&
        params.harness !== profile.defaults.backend
      ) {
        throw new Error(
          `Profile ${JSON.stringify(profile.identity.name)} requires ${profile.defaults.backend}; harness cannot override profile authority.`,
        );
      }
      const harness = profile?.defaults.backend ?? params.harness;
      if (!harness) {
        throw new Error("Provide either profile or harness.");
      }

      if (
        profile?.policy.workspace === "isolated" &&
        params.working_dir !== undefined
      ) {
        throw new Error(
          "working_dir cannot weaken an isolated profile workspace policy.",
        );
      }
      let cwd = path.resolve(ctx.cwd, params.working_dir ?? ".");
      let workspaceLease: WorkspaceResult<WorkspaceLease> | undefined;
      const workspaceManager = platformAgentServices(pi.events)?.workspaces;
      if (profile?.policy.workspace === "isolated") {
        if (!workspaceManager) {
          throw new Error(
            "Isolated agent profile requires the workspaces platform capability.",
          );
        }
        const created = await workspaceManager.create({
          base: { kind: "current-head" },
        });
        if (!created.ok) throw new Error(created.error.message);
        const workspaceTtlMs = Math.min(
          Math.max(
            (profile.policy.limits.timeoutMs ?? 300_000) + 120_000,
            600_000,
          ),
          86_400_000,
        );
        workspaceLease = await workspaceManager.lease({
          workspaceId: created.value.workspaceId,
          owner: {
            sessionId: ctx.sessionManager.getSessionId(),
            agentId: `tool-${toolCallId}`,
          },
          ttlMs: workspaceTtlMs,
          role: profile.policy.role,
          profile: profile.identity.name,
          profileDigest: profile.identity.contentDigest,
          profileGeneration: profile.identity.catalogGeneration,
          profileScope: profile.identity.source.scope,
          profilePath: profile.identity.source.path,
        });
        if (!workspaceLease.ok) throw new Error(workspaceLease.error.message);
        cwd = workspaceLease.value.snapshot.path;
      }
      if (!fs.existsSync(cwd) || !fs.statSync(cwd).isDirectory()) {
        throw new Error(`working_dir is not a directory: ${cwd}`);
      }

      const childContext = workspaceLease?.ok
        ? { cwd, projectTrusted: ctx.isProjectTrusted() }
        : resolveStandaloneChildProjectContext({
            parentCwd: ctx.cwd,
            childCwd: cwd,
            parentTrusted: ctx.isProjectTrusted(),
          });
      const childCwd = childContext.cwd;
      const title = params.name.trim().slice(0, 160) || "subagent";
      let activeWorkspaceLease = workspaceLease?.ok
        ? workspaceLease.value
        : undefined;
      const workspaceBinding = () =>
        activeWorkspaceLease
          ? {
              workspaceId: activeWorkspaceLease.workspaceId,
              owner: activeWorkspaceLease.owner,
              fence: activeWorkspaceLease.fence,
              expiresAt: activeWorkspaceLease.expiresAt,
              projectId: activeWorkspaceLease.snapshot.projectId,
              projectRoot: activeWorkspaceLease.snapshot.projectRoot,
              path: activeWorkspaceLease.snapshot.path,
              state: "leased" as const,
              role: profile!.policy.role,
              profile: profile!.identity,
              projectTrusted: true as const,
            }
          : undefined;
      let workspaceLifecycle: Promise<void> = Promise.resolve();
      const workspaceControl =
        activeWorkspaceLease && workspaceManager
          ? {
              async renew() {
                let binding:
                  NonNullable<SubagentSnapshot["workspace"]> | undefined;
                workspaceLifecycle = workspaceLifecycle.then(async () => {
                  if (!activeWorkspaceLease) {
                    throw new Error("Workspace was already preserved.");
                  }
                  const renewed = await workspaceManager.renew(
                    activeWorkspaceLease,
                    Math.min(
                      Math.max(
                        (profile?.policy.limits.timeoutMs ?? 300_000) + 120_000,
                        600_000,
                      ),
                      86_400_000,
                    ),
                  );
                  if (!renewed.ok) throw new Error(renewed.error.message);
                  activeWorkspaceLease = renewed.value;
                  binding = workspaceBinding()!;
                });
                await workspaceLifecycle;
                return binding!;
              },
              async preserve() {
                workspaceLifecycle = workspaceLifecycle.then(async () => {
                  if (!activeWorkspaceLease) return;
                  const preserved = await workspaceManager.disposition(
                    activeWorkspaceLease,
                    { kind: "preserve" },
                  );
                  if (!preserved.ok) throw new Error(preserved.error.message);
                  activeWorkspaceLease = undefined;
                });
                await workspaceLifecycle;
              },
            }
          : undefined;
      const task = {
        prompt: params.prompt,
        title,
        cwd: childCwd,
        model: params.model ?? profile?.defaults.model,
        reasoningEffort: params.reasoning_effort ?? profile?.defaults.effort,
        ...(profile
          ? { profile: profile.identity, execution: profile.policy }
          : {}),
        ...(workspaceBinding()
          ? {
              workspace: workspaceBinding()!,
              workspaceControl: workspaceControl!,
            }
          : {}),
        parent: {
          parentCwd: ctx.cwd,
          projectTrusted: childContext.projectTrusted,
          inheritedModel: ctx.model
            ? { provider: ctx.model.provider, id: ctx.model.id }
            : undefined,
          inheritedThinkingLevel: pi.getThinkingLevel(),
          modelRegistry: ctx.modelRegistry,
        },
      } satisfies SpawnTask;
      let snap: SubagentSnapshot;
      try {
        snap = options.spawn
          ? await options.spawn(harness, task, signal)
          : await runTool(
              getRuntime(),
              (await getManager()).spawn(harness, task),
              {
                signal,
                interruptMessage: "Subagent spawn aborted.",
              },
            );
      } catch (error) {
        if (workspaceControl) {
          try {
            await workspaceControl.preserve();
          } catch (cleanupError) {
            throw new AggregateError(
              [error, cleanupError],
              "Subagent spawn and guarded workspace preservation both failed.",
            );
          }
        }
        throw error;
      }

      if (snap.workspace) {
        pi.appendEntry("guarded-workspace-binding", {
          workspace: snap.workspace,
          profile: snap.profile,
        });
      }

      return {
        content: [
          {
            type: "text",
            text: [
              buildSubagentSpawnResult({
                id: snap.id,
                title: snap.title,
                harness,
                modelLabel: snap.meta.modelLabel ?? "?",
                cwd: snap.workspace?.projectRoot ?? childCwd,
              }),
              ...(workspaceLease?.ok
                ? (workspaceLease.value.snapshot.warnings ?? []).map(
                    (warning) => `Workspace warning: ${warning}`,
                  )
                : []),
            ].join("\n"),
          },
        ],
        details: {
          id: snap.id,
          title: snap.title,
          cwd: snap.workspace?.projectRoot ?? childCwd,
          harness,
          model: snap.meta.modelLabel,
          profile: snap.profile?.name,
          workspace: snap.workspace?.workspaceId,
          isolation: snap.workspace ? "guarded-workspace" : "unisolated",
          warnings: workspaceLease?.ok
            ? (workspaceLease.value.snapshot.warnings ?? [])
            : [],
        },
      };
    },
  });

  pi.registerTool({
    name: "subagent_wait",
    label: "Wait for Subagents",
    description: SUBAGENT_WAIT_TOOL_DESCRIPTION,
    parameters: Type.Object({
      ids: Type.Array(Type.String(), {
        maxItems: 64,
        description: SUBAGENT_WAIT_PARAMETER_DESCRIPTIONS.ids,
      }),
    }),
    async execute(_toolCallId, params, signal, onUpdate) {
      const manager = await getManager();
      const ids = [...new Set(params.ids)];
      if (ids.length === 0)
        throw new Error("Provide at least one subagent id.");
      const known = manager.view
        .list()
        .filter(isModelVisible)
        .map((snap) => snap.id);
      const unknown = ids.filter((id) => {
        const snap = manager.view.get(id);
        return !snap || !isModelVisible(snap);
      });
      if (unknown.length > 0) {
        throw new Error(
          `Unknown subagent id(s): ${unknown.join(", ")}. Known: ${known.join(", ") || "none"}.`,
        );
      }

      await runTool(
        getRuntime(),
        manager.waitFor(ids, (pending) => {
          onUpdate?.({
            content: [
              { type: "text", text: `Waiting for ${pending.join(", ")}...` },
            ],
            details: { pending },
          });
        }),
        { signal, interruptMessage: "Wait aborted. Subagents keep running." },
      );

      // Settlement may have happened before this wait began. Remove any
      // deferred automatic delivery now that the tool is returning the result.
      resultDelivery.consume(ids);

      const sections: string[] = [];
      let remainingBytes = WAIT_OUTPUT_MAX_BYTES;
      for (const id of ids) {
        const snap = manager.view.get(id);
        if (!snap) {
          sections.push(`## ${id}\n\n(no longer tracked)`);
          continue;
        }
        const verb = snap.status === "error" ? "failed" : "finished";
        let section = `## ${snap.id} "${snap.title}" ${verb}`;
        if (snap.errorText) section += `\nError: ${snap.errorText}`;
        const headerBytes = Buffer.byteLength(section, "utf8") + 2;
        const outputBudget = Math.max(
          512,
          Math.min(WAIT_PER_AGENT_MAX_BYTES, remainingBytes - headerBytes),
        );
        section += `\n\n${truncatedOutput(snap, outputBudget)}`;
        const sectionBytes = Buffer.byteLength(section, "utf8");
        if (sectionBytes > remainingBytes) {
          sections.push(
            `## ${snap.id} "${snap.title}"\n\n[omitted: total wait output limit reached]`,
          );
          break;
        }
        sections.push(section);
        remainingBytes -= sectionBytes;
      }

      const combined = sections.join("\n\n---\n\n");
      const bounded = truncateHead(combined, {
        maxBytes: WAIT_OUTPUT_MAX_BYTES - 128,
        maxLines: DEFAULT_MAX_LINES,
      });
      const text = bounded.truncated
        ? `${bounded.content}\n\n[wait output truncated at the total output limit]`
        : bounded.content;
      return {
        content: [{ type: "text", text }],
        details: {
          results: ids.map((id) => {
            const snap = manager.view.get(id);
            return { id, title: snap?.title, status: snap?.status };
          }),
        },
      };
    },
  });

  pi.registerTool({
    name: "subagent_cancel",
    label: "Cancel Subagents",
    description: SUBAGENT_CANCEL_TOOL_DESCRIPTION,
    parameters: Type.Object({
      ids: Type.Array(Type.String(), {
        description: SUBAGENT_CANCEL_PARAMETER_DESCRIPTIONS.ids,
      }),
    }),
    async execute(_toolCallId, params, signal) {
      const manager = await getManager();
      const ids = [...new Set(params.ids)];
      if (ids.length === 0)
        throw new Error("Provide at least one subagent id.");

      const known = manager.view
        .list()
        .filter(isModelVisible)
        .map((snap) => snap.id);
      const unknown = ids.filter((id) => {
        const snap = manager.view.get(id);
        return !snap || !isModelVisible(snap);
      });
      if (unknown.length > 0) {
        throw new Error(
          `Unknown subagent id(s): ${unknown.join(", ")}. Known: ${known.join(", ") || "none"}.`,
        );
      }

      const report = await runTool(getRuntime(), manager.cancel(ids), {
        signal,
        interruptMessage: "Subagent cancellation aborted.",
      });

      const lines = report.map((entry) =>
        entry.cancelled
          ? `Cancelled ${entry.id} "${entry.title}".`
          : `${entry.id} "${entry.title}" was already ${entry.status}.`,
      );

      return {
        content: [{ type: "text", text: lines.join("\n") }],
        details: {
          results: report.map((entry) => ({
            id: entry.id,
            title: entry.title,
            status: entry.status,
          })),
        },
      };
    },
  });

  pi.registerTool({
    name: "subagent_check",
    label: "Check Subagent",
    description: SUBAGENT_CHECK_TOOL_DESCRIPTION,
    parameters: Type.Object({
      id: Type.String({
        description: SUBAGENT_CHECK_PARAMETER_DESCRIPTIONS.id,
      }),
    }),
    async execute(_toolCallId, params) {
      const manager = await getManager();
      const snap = manager.view.get(params.id);
      if (!snap || !isModelVisible(snap)) {
        const known = manager.view
          .list()
          .filter(isModelVisible)
          .map((s) => s.id);
        throw new Error(
          `Unknown subagent id "${params.id}". Known: ${known.join(", ") || "none"}.`,
        );
      }

      let text = `${describeSubagent(snap)}\nTurns: ${snap.turns}`;
      if (snap.errorText) text += `\nError: ${snap.errorText}`;

      const output = mapGuardedWorkspacePaths(snap, latestText(snap));
      if (output) {
        const preview = truncateHead(output, { maxBytes: 2048, maxLines: 20 });
        text += `\n\nLatest output:\n${preview.content}`;
        if (preview.truncated) text += "\n[...]";
      } else if (snap.status === "running") {
        text += "\n\n(no text output yet)";
      }

      return {
        content: [{ type: "text", text }],
        details: { id: snap.id, status: snap.status, turns: snap.turns },
      };
    },
  });

  pi.registerTool({
    name: "subagent_list",
    label: "List Subagents",
    description: SUBAGENT_LIST_TOOL_DESCRIPTION,
    parameters: Type.Object({}),
    async execute() {
      const manager = await getManager();
      const subs = manager.view.list().filter(isModelVisible);
      const text =
        subs.length === 0
          ? "No subagents."
          : subs.map((snap) => describeSubagent(snap)).join("\n");
      return {
        content: [{ type: "text", text }],
        details: {
          subagents: subs.map((snap) => ({
            id: snap.id,
            title: snap.title,
            harness: snap.backend,
            status: snap.status,
            profile: snap.profile?.name,
            workspace: snap.workspace?.workspaceId,
            isolation: snap.workspace ? "guarded-workspace" : "unisolated",
          })),
        },
      };
    },
  });

  pi.registerTool({
    name: "workspace_list",
    label: "List Guarded Workspaces",
    description:
      "Inspect guarded agent workspaces, durable states, dirty classifications, and recovery warnings. Read-only.",
    parameters: Type.Object({}),
    async execute() {
      const manager = platformAgentServices(pi.events)?.workspaces;
      if (!manager) throw new Error("Guarded workspaces are not enabled.");
      const inspected = await manager.inspect();
      if (!inspected.ok) throw new Error(inspected.error.message);
      const text =
        inspected.value.length === 0
          ? "No guarded workspaces."
          : inspected.value
              .map(({ snapshot, inventory }) => {
                const dirty = inventory
                  ? Object.entries(inventory)
                      .filter(([key, value]) =>
                        key === "entries" ? false : value === true,
                      )
                      .map(([key]) => key)
                      .join(", ") || "clean"
                  : "not present";
                return `${snapshot.workspaceId} [${snapshot.state}] · ${dirty}`;
              })
              .join("\n");
      return {
        content: [{ type: "text", text }],
        details: {
          workspaces: inspected.value.map(({ snapshot, inventory }) => ({
            id: snapshot.workspaceId,
            state: snapshot.state,
            project: snapshot.projectId,
            dirty: inventory ? inventoryDirtySummary(inventory) : [],
          })),
        },
      };
    },
  });

  // --- Result message rendering ------------------------------------------

  pi.registerMessageRenderer(
    "subagent-result",
    (message, { expanded }, theme) => {
      const details = (message.details ?? {}) as {
        id?: string;
        title?: string;
        status?: string;
      };
      const failed = details.status === "error";
      const icon = failed ? theme.fg("error", "x") : theme.fg("success", "■");
      const header =
        `${icon} ` +
        theme.fg("accent", theme.bold(`subagent ${details.id ?? "?"}`)) +
        theme.fg(
          "muted",
          ` · ${details.title ?? ""} · ${failed ? "failed" : "finished"}`,
        );

      const content =
        typeof message.content === "string" ? message.content : "";
      // Remove only the summary line. The following Error line (when present)
      // is part of the actual result and must remain visible.
      const body = content.split("\n").slice(1).join("\n").trim();

      if (expanded) {
        const md = new Markdown(`${body}`, 0, 0, getMarkdownTheme());
        const container = new Text(header, 0, 0);
        return {
          render: (width: number) => [
            ...container.render(width),
            ...md.render(width),
          ],
          invalidate: () => {
            container.invalidate();
            md.invalidate();
          },
        };
      }

      const previewLines = body.split("\n").slice(0, 8);
      let text = header;
      for (const line of previewLines)
        text += `\n${theme.fg("toolOutput", line)}`;
      if (body.split("\n").length > 8)
        text += `\n${theme.fg("dim", "... (ctrl+o to expand)")}`;
      return new Text(text, 0, 0);
    },
  );

  pi.registerEntryRenderer<BtwResultData>(
    "btw-result",
    (entry, { expanded }, theme) => {
      const data = entry.data;
      const failed = data?.status === "error";
      const icon = failed ? theme.fg("error", "x") : theme.fg("success", "■");
      const header =
        `${icon} ` +
        theme.fg("accent", theme.bold(`by the way · ${data?.title ?? "?"}`)) +
        theme.fg(
          "muted",
          ` · ${failed ? "failed" : "answered"} · ${data?.id ?? "?"}`,
        );
      const body = [
        data?.errorText ? `Error: ${data.errorText}` : "",
        data?.answer ?? "(no answer)",
      ]
        .filter(Boolean)
        .join("\n\n");

      if (expanded) {
        const md = new Markdown(body, 0, 0, getMarkdownTheme());
        const container = new Text(header, 0, 0);
        return {
          render: (width: number) => [
            ...container.render(width),
            ...md.render(width),
          ],
          invalidate: () => {
            container.invalidate();
            md.invalidate();
          },
        };
      }

      const lines = body.split("\n");
      let text = header;
      for (const line of lines.slice(0, 8))
        text += `\n${theme.fg("toolOutput", line)}`;
      if (lines.length > 8)
        text += `\n${theme.fg("dim", "... (ctrl+o to expand)")}`;
      return new Text(text, 0, 0);
    },
  );

  // --- Commands -----------------------------------------------------------

  const runByTheWay = async (rawArgs: string, ctx: ExtensionCommandContext) => {
    if (ctx.mode !== "tui") {
      if (ctx.hasUI)
        ctx.ui.notify("by the way is only available in the TUI", "error");
      return;
    }

    let prompt = rawArgs.trim();
    if (!prompt) {
      const input = await ctx.ui.input("by the way", "Ask a one-off question…");
      prompt = input?.trim() ?? "";
      if (!prompt) return;
    }

    const manager = await getManager();
    let snap: SubagentSnapshot;
    try {
      snap = await runTool(
        getRuntime(),
        manager.spawn("pi", {
          origin: "btw",
          prompt,
          title: deriveBtwTitle(prompt),
          cwd: ctx.cwd,
          parent: {
            parentCwd: ctx.cwd,
            projectTrusted: ctx.isProjectTrusted(),
            inheritedModel: ctx.model
              ? { provider: ctx.model.provider, id: ctx.model.id }
              : undefined,
            inheritedThinkingLevel: pi.getThinkingLevel(),
            modelRegistry: ctx.modelRegistry,
          },
        }),
      );
    } catch (error) {
      ctx.ui.notify(
        error instanceof Error ? error.message : String(error),
        "error",
      );
      return;
    }

    await openSubagentTakeover(ctx, manager.view, snap.id, {
      badge: "by the way",
    });
  };

  pi.registerCommand("agents", {
    description: "Browse and validate persistent named agent profiles",
    handler: async (rawArgs, ctx) => {
      const catalog =
        options.profileCatalog ?? platformAgentServices(pi.events)?.profiles;
      if (!catalog) {
        if (ctx.hasUI) {
          ctx.ui.notify(
            "Named agent profiles are not enabled for this session.",
            "warning",
          );
        }
        return;
      }
      if (rawArgs.trim() === "reload") {
        const resolved = await createProjectIdentity().resolve(ctx.cwd);
        if (!resolved.ok) {
          if (ctx.hasUI) ctx.ui.notify(resolved.error.message, "error");
          return;
        }
        const project = resolved.value;
        const projectRoot =
          project.kind === "git" && !project.bare
            ? project.repositoryRoot
            : project.canonicalCwd;
        await catalog.reload({
          projectRoot,
          projectTrusted: ctx.isProjectTrusted(),
        });
      }
      const snapshot = catalog.inspect();
      const diagnostics = snapshot.diagnostics.filter(
        (diagnostic) => diagnostic.severity === "error",
      );
      const lines = [
        ...snapshot.profiles.map((profile) => {
          const policy = profile.policy;
          return `${profile.identity.name} [${profile.identity.source.scope}] · ${profile.defaults.backend}${profile.defaults.model ? `/${profile.defaults.model}` : ""} · ${policy.workspace} · ${policy.role} · ${profile.identity.contentDigest.slice(0, 8)}`;
        }),
        ...snapshot.diagnostics.map(
          (diagnostic) =>
            `${diagnostic.severity.toUpperCase()} ${diagnostic.code} · ${diagnostic.path} · ${diagnostic.message}`,
        ),
      ];
      if (ctx.mode === "tui" && lines.length > 0) {
        await ctx.ui.select(
          `Agent profiles · generation ${snapshot.generation}${diagnostics.length > 0 ? ` · ${diagnostics.length} invalid` : ""}`,
          lines,
        );
      } else if (ctx.hasUI) {
        ctx.ui.notify(
          lines.length > 0
            ? lines.join("\n")
            : diagnostics.length > 0
              ? diagnostics.map((diagnostic) => diagnostic.message).join("\n")
              : "No agent profiles found.",
          diagnostics.length > 0 ? "warning" : "info",
        );
      }
    },
  });

  pi.registerCommand("workspaces", {
    description: "Inspect and disposition guarded agent workspaces",
    handler: async (_args, ctx) => {
      const manager = platformAgentServices(pi.events)?.workspaces;
      if (!manager) {
        if (ctx.hasUI)
          ctx.ui.notify("Guarded workspaces are not enabled.", "warning");
        return;
      }
      const inspected = await manager.inspect();
      if (!inspected.ok) {
        if (ctx.hasUI) ctx.ui.notify(inspected.error.message, "error");
        return;
      }
      if (ctx.mode !== "tui") {
        if (ctx.hasUI) {
          ctx.ui.notify(
            inspected.value
              .map(
                ({ snapshot }) =>
                  `${snapshot.workspaceId} [${snapshot.state}] ${snapshot.path}`,
              )
              .join("\n") || "No guarded workspaces.",
            "info",
          );
        }
        return;
      }
      if (inspected.value.length === 0) {
        ctx.ui.notify("No guarded workspaces.", "info");
        return;
      }
      const labels = inspected.value.map(
        ({ snapshot, inventory }) =>
          `${snapshot.workspaceId} [${snapshot.state}] · ${inventory ? inventoryDirtySummary(inventory).join(", ") || "clean" : "not present"}`,
      );
      const selected = await ctx.ui.select("Guarded workspaces", labels);
      const index = selected ? labels.indexOf(selected) : -1;
      if (index < 0) return;
      const choice = inspected.value[index]!;
      if (choice.snapshot.state === "leased") {
        ctx.ui.notify(
          "Workspace is leased by an active or recoverable agent. Wait, cancel it, or run recovery after lease expiry.",
          "warning",
        );
        return;
      }
      if (
        choice.snapshot.state === "integrated" ||
        choice.snapshot.state === "abandoned"
      ) {
        ctx.ui.notify("Workspace disposition is already terminal.", "info");
        return;
      }
      const action = await ctx.ui.select("Workspace action", [
        ...(choice.snapshot.state === "dirty" ? ["mark reviewed"] : []),
        ...(choice.snapshot.state === "reviewed" ? ["integrate"] : []),
        "abandon",
      ]);
      if (!action) return;
      const lease = await manager.lease({
        workspaceId: choice.snapshot.workspaceId,
        owner: {
          sessionId: ctx.sessionManager.getSessionId(),
          agentId: "workspace-ui",
        },
        ttlMs: 300_000,
        role: "review",
      });
      if (!lease.ok) {
        ctx.ui.notify(lease.error.message, "error");
        return;
      }
      if (action === "mark reviewed") {
        const evidence = await ctx.ui.input(
          "Review evidence",
          "Tests, review, and commit reference",
        );
        if (!evidence?.trim()) {
          await manager.disposition(lease.value, { kind: "preserve" });
          return;
        }
        const reviewed = await manager.disposition(lease.value, {
          kind: "mark-reviewed",
          evidence: evidence.trim(),
        });
        if (!reviewed.ok) {
          ctx.ui.notify(reviewed.error.message, "error");
          return;
        }
        await manager.disposition(lease.value, { kind: "preserve" });
        ctx.ui.notify("Workspace marked reviewed.", "info");
        return;
      }
      if (action === "integrate") {
        const targetBranch = await ctx.ui.input("Target branch", "main");
        const expectedTargetCommit = await ctx.ui.input(
          "Expected target commit",
          "full Git object id",
        );
        if (!targetBranch || !expectedTargetCommit) {
          await manager.disposition(lease.value, { kind: "preserve" });
          return;
        }
        const integrated = await manager.integrate(lease.value, {
          targetBranch,
          expectedTargetCommit,
        });
        ctx.ui.notify(
          integrated.ok ? "Workspace integrated." : integrated.error.message,
          integrated.ok ? "info" : "error",
        );
        return;
      }
      const confirmed = await ctx.ui.confirm(
        "Abandon guarded workspace?",
        "This permanently removes workspace data after safety revalidation.",
      );
      if (!confirmed) {
        await manager.disposition(lease.value, { kind: "preserve" });
        return;
      }
      const abandoned = await manager.disposition(lease.value, {
        kind: "abandon",
        acknowledgeDataLoss: true,
      });
      ctx.ui.notify(
        abandoned.ok ? "Workspace abandoned." : abandoned.error.message,
        abandoned.ok ? "info" : "error",
      );
    },
  });

  pi.registerCommand("btw", {
    description:
      "Ask a one-off side question while the main agent keeps working",
    handler: runByTheWay,
  });

  pi.registerCommand("subagents", {
    description: "List, inspect, and take over subagents",
    handler: async (_args, ctx) => {
      if (ctx.mode !== "tui") {
        if (ctx.hasUI)
          ctx.ui.notify(
            "Subagent takeover is only available in the TUI",
            "error",
          );
        return;
      }
      const manager = await getManager();
      if (manager.view.size() === 0) {
        ctx.ui.notify(
          "No subagents yet. The agent spawns them with subagent_spawn.",
          "info",
        );
        return;
      }
      await openSubagentPicker(ctx, manager.view);
    },
  });
}
