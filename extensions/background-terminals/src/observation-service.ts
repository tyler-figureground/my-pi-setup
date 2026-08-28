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

const sources = new WeakMap<object, TerminalObservationSource>();

export function bindTerminalObservationSource(
  eventBus: object,
  source: TerminalObservationSource,
) {
  if (sources.has(eventBus)) {
    throw new Error(
      "A terminal observation source is already bound to this loader.",
    );
  }
  sources.set(eventBus, source);
  return () => {
    if (sources.get(eventBus) === source) sources.delete(eventBus);
  };
}

export function terminalObservationSourceFor(eventBus: object) {
  return sources.get(eventBus);
}
