import type { NamedProfileExecutionPort } from "../automation/hooks/adapters.ts";

interface EventBusLike {
  emit(channel: string, data: unknown): void;
  on(channel: string, handler: (data: unknown) => void): () => void;
}

interface AvailabilityQuery {
  readonly kind: "query";
  readonly version: 1;
  claimed: boolean;
}

interface RevalidationInvocation {
  readonly kind: "revalidate";
  readonly version: 1;
  readonly request: Parameters<
    NamedProfileExecutionPort["revalidateProfile"]
  >[0];
  claimed: boolean;
  resolve(
    value: Awaited<ReturnType<NamedProfileExecutionPort["revalidateProfile"]>>,
  ): void;
  reject(error: unknown): void;
}

interface RunInvocation {
  readonly kind: "run";
  readonly version: 1;
  readonly request: Parameters<NamedProfileExecutionPort["run"]>[0];
  claimed: boolean;
  resolve(value: Awaited<ReturnType<NamedProfileExecutionPort["run"]>>): void;
  reject(error: unknown): void;
}

type InvocationState = RevalidationInvocation | RunInvocation;

// Coordination among trusted extension code. Execution core remains authority.
const CHANNEL = "platform:named-profile-execution:private";
const bindings = new WeakMap<
  object,
  { readonly port: NamedProfileExecutionPort; readonly unlisten: () => void }
>();

function isEventBusLike(value: object): value is object & EventBusLike {
  return (
    "emit" in value &&
    typeof value.emit === "function" &&
    "on" in value &&
    typeof value.on === "function"
  );
}

function hasPort(eventBus: EventBusLike) {
  const query: AvailabilityQuery = {
    kind: "query",
    version: 1,
    claimed: false,
  };
  eventBus.emit(CHANNEL, query);
  return query.claimed;
}

function protocolMessage(value: unknown) {
  if (
    !value ||
    typeof value !== "object" ||
    !("version" in value) ||
    value.version !== 1 ||
    !("kind" in value) ||
    !("claimed" in value) ||
    typeof value.claimed !== "boolean"
  ) {
    return undefined;
  }
  if (value.kind === "query") return value as AvailabilityQuery;
  if (
    (value.kind === "revalidate" || value.kind === "run") &&
    "request" in value &&
    "resolve" in value &&
    typeof value.resolve === "function" &&
    "reject" in value &&
    typeof value.reject === "function"
  ) {
    return value as unknown as InvocationState;
  }
  return undefined;
}

function remotePort(eventBus: EventBusLike): NamedProfileExecutionPort {
  return {
    revalidateProfile(request) {
      return new Promise((resolve, reject) => {
        const invocation: RevalidationInvocation = {
          kind: "revalidate",
          version: 1,
          request: Object.freeze({ ...request }),
          claimed: false,
          resolve,
          reject,
        };
        eventBus.emit(CHANNEL, invocation);
        if (!invocation.claimed) {
          reject(new Error("Named Profile execution port is unavailable."));
        }
      });
    },
    run(request) {
      return new Promise((resolve, reject) => {
        const invocation: RunInvocation = {
          kind: "run",
          version: 1,
          request: Object.freeze({ ...request }),
          claimed: false,
          resolve,
          reject,
        };
        eventBus.emit(CHANNEL, invocation);
        if (!invocation.claimed) {
          reject(new Error("Named Profile execution port is unavailable."));
        }
      });
    },
  };
}

export function bindNamedProfileExecutionPort(
  loader: object,
  port: NamedProfileExecutionPort,
) {
  if (bindings.has(loader) || (isEventBusLike(loader) && hasPort(loader))) {
    throw new Error(
      "A Named Profile execution port is already bound to this loader.",
    );
  }
  const unlisten = isEventBusLike(loader)
    ? loader.on(CHANNEL, (value) => {
        const message = protocolMessage(value);
        if (!message || message.claimed) return;
        message.claimed = true;
        if (message.kind === "query") return;
        if (message.kind === "revalidate") {
          void Promise.resolve()
            .then(() => port.revalidateProfile(message.request))
            .then(message.resolve, message.reject);
          return;
        }
        void Promise.resolve()
          .then(() => port.run(message.request))
          .then(message.resolve, message.reject);
      })
    : () => {};
  bindings.set(loader, { port, unlisten });
  let bound = true;
  return () => {
    if (!bound) return;
    bound = false;
    const binding = bindings.get(loader);
    if (binding?.port !== port) return;
    bindings.delete(loader);
    binding.unlisten();
  };
}

export function namedProfileExecutionPortFor(loader: object) {
  const local = bindings.get(loader)?.port;
  if (local || !isEventBusLike(loader)) return local;
  return hasPort(loader) ? remotePort(loader) : undefined;
}
