import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  createLifecycleSupervisor,
  type LifecycleResource,
  type LifecycleSupervisor,
} from "./core/lifecycle/supervisor.ts";
import {
  executionRoleFor,
  type ExecutionRole,
} from "../../shared/execution-role.ts";
import { loadPlatformFlags } from "./config.ts";
import { decodePlatformFlags } from "./flags.ts";

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
  createLifecycleSupervisor?: () => LifecycleSupervisor;
}

export function createPlatformExtension(
  options: PlatformExtensionOptions = {},
) {
  const suppliedConfiguration =
    options.flags === undefined
      ? undefined
      : decodePlatformFlags(options.flags);
  const makeLifecycleSupervisor =
    options.createLifecycleSupervisor ?? createLifecycleSupervisor;

  return (pi: ExtensionAPI) => {
    const role = executionRoleFor(pi.events);
    let runtime:
      | {
          role: ExecutionRole;
          lifecycle: LifecycleSupervisor;
          acquireDaemon: ReturnType<typeof createDaemonAcquirer>;
        }
      | undefined;

    pi.on("session_start", (_event, ctx) => {
      const lifecycle = makeLifecycleSupervisor();
      runtime = {
        role,
        lifecycle,
        acquireDaemon: createDaemonAcquirer(role, lifecycle),
      };
      const configuration =
        suppliedConfiguration ??
        loadPlatformFlags({
          cwd: ctx.cwd,
          projectTrusted: ctx.isProjectTrusted(),
        });
      if (ctx.hasUI) {
        for (const diagnostic of configuration.diagnostics) {
          ctx.ui.notify(
            `Platform config ${diagnostic.path}: ${diagnostic.message}`,
            "warning",
          );
        }
      }
    });
    pi.on("session_shutdown", async (event) => {
      const current = runtime;
      runtime = undefined;
      if (current) await current.lifecycle.shutdown(event.reason);
    });
  };
}
