import type { ProfileCatalog } from "../profiles/index.ts";
import type { WorkspaceManager } from "../workspaces/index.ts";

export interface PlatformAgentServices {
  readonly profiles?: ProfileCatalog;
  readonly workspaces?: WorkspaceManager;
}

interface EventBusLike {
  emit(channel: string, data: unknown): void;
  on(channel: string, handler: (data: unknown) => void): () => void;
}

interface ServiceQuery {
  readonly kind: "query";
  readonly version: 1;
  claimed: boolean;
  services?: PlatformAgentServices;
}

// Coordination among trusted extension code, not an authority boundary.
const CHANNEL = "platform:agent-services:private";
const bindings = new WeakMap<
  object,
  { readonly services: PlatformAgentServices; readonly unlisten: () => void }
>();

function isEventBusLike(value: object): value is object & EventBusLike {
  return (
    "emit" in value &&
    typeof value.emit === "function" &&
    "on" in value &&
    typeof value.on === "function"
  );
}

function queryServices(eventBus: EventBusLike) {
  const query: ServiceQuery = {
    kind: "query",
    version: 1,
    claimed: false,
  };
  eventBus.emit(CHANNEL, query);
  return query.services;
}

function serviceQuery(value: unknown) {
  if (
    !value ||
    typeof value !== "object" ||
    !("kind" in value) ||
    value.kind !== "query" ||
    !("version" in value) ||
    value.version !== 1 ||
    !("claimed" in value) ||
    typeof value.claimed !== "boolean"
  ) {
    return undefined;
  }
  return value as ServiceQuery;
}

export function bindPlatformAgentServices(
  eventBus: object,
  services: PlatformAgentServices,
) {
  if (
    bindings.has(eventBus) ||
    (isEventBusLike(eventBus) && queryServices(eventBus))
  ) {
    throw new Error(
      "Platform agent services are already bound to this loader.",
    );
  }
  const unlisten = isEventBusLike(eventBus)
    ? eventBus.on(CHANNEL, (value) => {
        const query = serviceQuery(value);
        if (!query || query.claimed) return;
        query.claimed = true;
        query.services = services;
      })
    : () => {};
  bindings.set(eventBus, { services, unlisten });
  let bound = true;
  return () => {
    if (!bound) return;
    bound = false;
    const binding = bindings.get(eventBus);
    if (binding?.services !== services) return;
    bindings.delete(eventBus);
    binding.unlisten();
  };
}

export function platformAgentServices(eventBus: object) {
  const local = bindings.get(eventBus)?.services;
  if (local || !isEventBusLike(eventBus)) return local;
  return queryServices(eventBus);
}
