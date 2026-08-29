import type { TerminalObservation } from "./domain.ts";

export interface TerminalObservationRequest {
  readonly terminalId: string;
  readonly afterSequence?: number;
}

export interface TerminalObservationLease {
  close(): void | Promise<void>;
}

export type TerminalObservationSourceOutcome =
  | { readonly ok: true; readonly value: TerminalObservationLease }
  | {
      readonly ok: false;
      readonly error: {
        readonly code:
          | "terminal_not_found"
          | "cursor_invalid"
          | "source_unavailable"
          | "shutting_down";
        readonly message: string;
        readonly retryable: boolean;
      };
    };

export interface TerminalObservationSource {
  observe(
    request: TerminalObservationRequest,
    listener: (event: TerminalObservation) => unknown,
  ): Promise<TerminalObservationSourceOutcome>;
}

interface EventBusLike {
  emit(channel: string, data: unknown): void;
  on(channel: string, handler: (data: unknown) => void): () => void;
}

interface AvailabilityQuery {
  readonly kind: "query";
  readonly version: 1;
  claimed: boolean;
}

interface ObservationInvocation {
  readonly kind: "observe";
  readonly version: 1;
  readonly request: TerminalObservationRequest;
  readonly listener: (event: TerminalObservation) => unknown;
  claimed: boolean;
  resolve(value: TerminalObservationSourceOutcome): void;
  reject(error: unknown): void;
}

// Coordination among trusted extension code. Observation core validates requests.
const CHANNEL = "platform:terminal-observation-source:private";
const bindings = new WeakMap<
  object,
  { readonly source: TerminalObservationSource; readonly unlisten: () => void }
>();

function isEventBusLike(value: object): value is object & EventBusLike {
  return (
    "emit" in value &&
    typeof value.emit === "function" &&
    "on" in value &&
    typeof value.on === "function"
  );
}

function hasSource(eventBus: EventBusLike) {
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
    value.kind === "observe" &&
    "request" in value &&
    "listener" in value &&
    typeof value.listener === "function" &&
    "resolve" in value &&
    typeof value.resolve === "function" &&
    "reject" in value &&
    typeof value.reject === "function"
  ) {
    return value as unknown as ObservationInvocation;
  }
  return undefined;
}

function remoteSource(eventBus: EventBusLike): TerminalObservationSource {
  return {
    observe(request, listener) {
      return new Promise((resolve, reject) => {
        const invocation: ObservationInvocation = {
          kind: "observe",
          version: 1,
          request: Object.freeze({ ...request }),
          listener,
          claimed: false,
          resolve,
          reject,
        };
        eventBus.emit(CHANNEL, invocation);
        if (!invocation.claimed) {
          reject(new Error("Terminal observation source is unavailable."));
        }
      });
    },
  };
}

export function bindTerminalObservationSource(
  eventBus: object,
  source: TerminalObservationSource,
) {
  if (
    bindings.has(eventBus) ||
    (isEventBusLike(eventBus) && hasSource(eventBus))
  ) {
    throw new Error(
      "A terminal observation source is already bound to this loader.",
    );
  }
  const unlisten = isEventBusLike(eventBus)
    ? eventBus.on(CHANNEL, (value) => {
        const message = protocolMessage(value);
        if (!message || message.claimed) return;
        message.claimed = true;
        if (message.kind === "query") return;
        void Promise.resolve()
          .then(() => source.observe(message.request, message.listener))
          .then(message.resolve, message.reject);
      })
    : () => {};
  bindings.set(eventBus, { source, unlisten });
  let bound = true;
  return () => {
    if (!bound) return;
    bound = false;
    const binding = bindings.get(eventBus);
    if (binding?.source !== source) return;
    bindings.delete(eventBus);
    binding.unlisten();
  };
}

export function terminalObservationSourceFor(eventBus: object) {
  const local = bindings.get(eventBus)?.source;
  if (local || !isEventBusLike(eventBus)) return local;
  return hasSource(eventBus) ? remoteSource(eventBus) : undefined;
}
