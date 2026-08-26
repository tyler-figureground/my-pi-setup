import type { ProfileCatalog } from "../profiles/index.ts";
import type { WorkspaceManager } from "../workspaces/index.ts";

export interface PlatformAgentServices {
  readonly profiles?: ProfileCatalog;
  readonly workspaces?: WorkspaceManager;
}

const servicesByEventBus = new WeakMap<object, PlatformAgentServices>();

export function bindPlatformAgentServices(
  eventBus: object,
  services: PlatformAgentServices,
) {
  if (servicesByEventBus.has(eventBus)) {
    throw new Error(
      "Platform agent services are already bound to this loader.",
    );
  }
  servicesByEventBus.set(eventBus, services);
  return () => {
    if (servicesByEventBus.get(eventBus) === services) {
      servicesByEventBus.delete(eventBus);
    }
  };
}

export function platformAgentServices(eventBus: object) {
  return servicesByEventBus.get(eventBus);
}
