import {
  getAgentDir,
  type ExtensionAPI,
} from "@earendil-works/pi-coding-agent";
import {
  createLifecycleSupervisor,
  type LifecycleResource,
  type LifecycleSupervisor,
} from "./core/lifecycle/supervisor.ts";
import {
  executionRoleFor,
  type ExecutionRole,
} from "../../shared/execution-role.ts";
import {
  defaultPlatformPlanConfiguration,
  loadPlatformFlags,
  type PlatformPlanConfiguration,
} from "./config.ts";
import { createCapabilityPolicy } from "./core/policy/index.ts";
import {
  createProjectIdentity,
  type ProjectIdentity,
} from "./core/projects/index.ts";
import { decodePlatformFlags } from "./flags.ts";
import { createHooksCapability } from "./wiring/hooks.ts";
import { createPlanCapability } from "./wiring/plan.ts";
import { createRulesCapability } from "./wiring/rules.ts";

export function canOwnPlatformDaemons(role: ExecutionRole) {
  return role === "parent";
}

function createDaemonAcquirer(
  role: ExecutionRole,
  lifecycle: LifecycleSupervisor,
) {
  return <T>(resource: LifecycleResource<T>) => {
    if (!canOwnPlatformDaemons(role)) {
      return Promise.reject(
        new Error(
          `Execution role ${JSON.stringify(role)} cannot own platform daemons.`,
        ),
      );
    }
    return lifecycle.acquire(resource);
  };
}

export interface PlatformExtensionOptions {
  flags?: unknown;
  plan?: Partial<PlatformPlanConfiguration>;
  agentDir?: string;
  createLifecycleSupervisor?: () => LifecycleSupervisor;
  createProjectIdentity?: () => ProjectIdentity;
}

export function createPlatformExtension(
  options: PlatformExtensionOptions = {},
) {
  const suppliedConfiguration =
    options.flags === undefined
      ? undefined
      : {
          ...decodePlatformFlags(options.flags),
          plan: {
            ...defaultPlatformPlanConfiguration,
            ...options.plan,
          },
        };
  const makeLifecycleSupervisor =
    options.createLifecycleSupervisor ?? createLifecycleSupervisor;
  const makeProjectIdentity =
    options.createProjectIdentity ?? createProjectIdentity;
  const agentDir = options.agentDir ?? getAgentDir();

  return (pi: ExtensionAPI) => {
    const role = executionRoleFor(pi.events);
    const policy = createCapabilityPolicy();
    type PlatformRuntime = {
      role: ExecutionRole;
      lifecycle: LifecycleSupervisor;
      acquireDaemon: ReturnType<typeof createDaemonAcquirer>;
      plan?: ReturnType<typeof createPlanCapability>;
      rules?: ReturnType<typeof createRulesCapability>;
      hooks?: ReturnType<typeof createHooksCapability>;
    };
    let runtime: PlatformRuntime | undefined;
    let planCapability: ReturnType<typeof createPlanCapability> | undefined;
    let rulesCapability: ReturnType<typeof createRulesCapability> | undefined;
    let hooksCapability: ReturnType<typeof createHooksCapability> | undefined;

    const teardown = async (
      current: PlatformRuntime,
      reason: "quit" | "reload" | "new" | "resume" | "fork",
      event: unknown,
    ) => {
      const failures: unknown[] = [];
      try {
        await current.hooks?.stop(reason, event);
      } catch (error) {
        failures.push(error);
      }
      try {
        current.rules?.stop();
      } catch (error) {
        failures.push(error);
      }
      try {
        await current.plan?.stop();
      } catch (error) {
        failures.push(error);
      }
      try {
        await current.lifecycle.shutdown(reason);
      } catch (error) {
        failures.push(error);
      }
      if (failures.length > 0) {
        throw new AggregateError(failures, "Platform session teardown failed.");
      }
    };

    pi.on("session_start", async (event, ctx) => {
      if (runtime) {
        const previous = runtime;
        runtime = undefined;
        await teardown(previous, "reload", {
          type: "session_shutdown",
          reason: "reload",
        });
      }
      const lifecycle = makeLifecycleSupervisor();
      const current = {
        role,
        lifecycle,
        acquireDaemon: createDaemonAcquirer(role, lifecycle),
      } as PlatformRuntime;
      runtime = current;
      const projectTrusted = ctx.isProjectTrusted();
      const configuration =
        suppliedConfiguration ??
        loadPlatformFlags({
          cwd: ctx.cwd,
          agentDir,
          projectTrusted,
        });
      if (ctx.hasUI) {
        for (const diagnostic of configuration.diagnostics) {
          ctx.ui.notify(
            `Platform config ${diagnostic.path}: ${diagnostic.message}`,
            "warning",
          );
        }
      }

      const phase2Enabled =
        configuration.flags.planMode ||
        configuration.flags.rules ||
        configuration.flags.hooks;
      if (!phase2Enabled || role !== "parent") return;

      const resolved = await makeProjectIdentity().resolve(ctx.cwd);
      if (!resolved.ok) {
        if (ctx.hasUI) {
          ctx.ui.notify(resolved.error.message, "error");
        }
        return;
      }
      const project = resolved.value;

      if (configuration.flags.planMode) {
        planCapability ??= createPlanCapability({
          pi,
          agentDir,
          actor: role,
          policy,
          configuration: configuration.plan,
        });
        current.plan = planCapability;
        await current.plan.start({ project, projectTrusted, ctx });
      }
      if (configuration.flags.rules) {
        rulesCapability ??= createRulesCapability({
          pi,
          agentDir,
          actor: role,
          policy,
        });
        current.rules = rulesCapability;
        await current.rules.start({ project, projectTrusted, ctx });
      }
      if (configuration.flags.hooks) {
        hooksCapability ??= createHooksCapability({
          pi,
          agentDir,
          actor: role,
          policy,
          mode: () => {
            const state = runtime?.plan?.mode()?.status().state;
            return state === "planning" || state === "approval-pending"
              ? "plan"
              : "normal";
          },
        });
        current.hooks = hooksCapability;
        await current.hooks.start({ project, projectTrusted, ctx }, event);
      }
    });
    pi.on("session_shutdown", async (event) => {
      const current = runtime;
      runtime = undefined;
      if (!current) return;
      await teardown(current, event.reason, event);
    });
  };
}
