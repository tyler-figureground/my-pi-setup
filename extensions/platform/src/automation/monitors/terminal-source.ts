import type {
  MonitorSourceEvent,
  MonitorSourceFactory,
  TerminalMonitorSource,
} from "./model.ts";

export interface TerminalOutputObservation {
  readonly kind: "output";
  readonly terminalId: string;
  readonly sequence: number;
  readonly stream: "stdout" | "stderr";
  readonly text: string;
  readonly byteLength: number;
  readonly startByte: number;
  readonly endByte: number;
}

export interface TerminalSettledObservation {
  readonly kind: "settled";
  readonly terminalId: string;
  readonly sequence: number;
  readonly snapshot: {
    readonly status: "running" | "done" | "failed" | "killed";
    readonly exitCode?: number;
    readonly signal?: string;
  };
  readonly consumed: boolean;
}

export interface TerminalObservationGap {
  readonly kind: "gap";
  readonly terminalId: string;
  readonly sequence: number;
  readonly fromSequence: number;
  readonly toSequence: number;
}

export type TerminalObservation =
  | TerminalOutputObservation
  | TerminalSettledObservation
  | TerminalObservationGap;

export interface TerminalObservationSource {
  observe(
    request: { readonly terminalId: string; readonly afterSequence?: number },
    listener: (event: TerminalObservation) => unknown,
  ): Promise<
    | { readonly ok: true; readonly value: { close(): void | Promise<void> } }
    | {
        readonly ok: false;
        readonly error: {
          readonly code: string;
          readonly message: string;
          readonly retryable: boolean;
        };
      }
  >;
}

const MAX_PARTIAL_LINE_BYTES = 16 * 1024;

function boundedTail(value: string) {
  const bytes = Buffer.from(value);
  if (bytes.byteLength <= MAX_PARTIAL_LINE_BYTES) return value;
  return bytes
    .subarray(bytes.byteLength - MAX_PARTIAL_LINE_BYTES)
    .toString("utf8");
}

export function createTerminalMonitorSourceFactory(
  terminal: TerminalObservationSource,
): MonitorSourceFactory {
  return {
    async open(definition, emit, signal) {
      if (definition.source.kind !== "terminal") {
        throw new Error(
          "Terminal source factory received another source kind.",
        );
      }
      const source: TerminalMonitorSource = definition.source;
      let closed = false;
      let lastSequence = 0;
      const partial = new Map<
        "stdout" | "stderr",
        { text: string; fromSequence: number }
      >();

      const publish = (event: MonitorSourceEvent) => {
        if (!closed && !signal.aborted) emit(event);
      };
      const publishLine = (
        stream: "stdout" | "stderr",
        line: string,
        fromSequence: number,
        toSequence: number,
        incomplete = false,
      ) =>
        publish({
          type: "terminal.line",
          payload: {
            terminalId: source.terminalId,
            stream,
            line,
            fromSequence,
            toSequence,
            incomplete,
          },
        });
      const frame = (
        stream: "stdout" | "stderr",
        text: string,
        sequence: number,
      ) => {
        const prior = partial.get(stream);
        let buffer = `${prior?.text ?? ""}${text}`;
        const fromSequence = prior?.fromSequence ?? sequence;
        let start = 0;
        for (let index = 0; index < buffer.length; index += 1) {
          const character = buffer[index];
          if (character !== "\n" && character !== "\r") continue;
          if (character === "\r" && index === buffer.length - 1) break;
          publishLine(
            stream,
            buffer.slice(start, index),
            fromSequence,
            sequence,
          );
          if (character === "\r" && buffer[index + 1] === "\n") index += 1;
          start = index + 1;
        }
        buffer = boundedTail(buffer.slice(start));
        if (buffer.length === 0) partial.delete(stream);
        else partial.set(stream, { text: buffer, fromSequence });
      };
      const onObservation = (event: TerminalObservation) => {
        if (closed || signal.aborted || event.terminalId !== source.terminalId)
          return;
        if (
          !Number.isSafeInteger(event.sequence) ||
          event.sequence <= lastSequence
        )
          return;
        if (event.sequence > lastSequence + 1 && event.kind !== "gap") {
          publish({
            type: "terminal.gap",
            payload: {
              terminalId: source.terminalId,
              fromSequence: lastSequence + 1,
              toSequence: event.sequence - 1,
            },
          });
          partial.clear();
        }
        lastSequence = event.sequence;
        if (event.kind === "gap") {
          partial.clear();
          publish({
            type: "terminal.gap",
            payload: {
              terminalId: source.terminalId,
              fromSequence: event.fromSequence,
              toSequence: event.toSequence,
            },
          });
          return;
        }
        if (event.kind === "output") {
          if (source.framing === "chunk") {
            publish({
              type: "terminal.chunk",
              payload: {
                terminalId: source.terminalId,
                sequence: event.sequence,
                stream: event.stream,
                text: boundedTail(event.text),
                byteLength: event.byteLength,
                startByte: event.startByte,
                endByte: event.endByte,
              },
            });
          } else {
            frame(event.stream, event.text, event.sequence);
          }
          return;
        }
        for (const stream of ["stdout", "stderr"] as const) {
          const pending = partial.get(stream);
          if (pending) {
            publishLine(
              stream,
              pending.text,
              pending.fromSequence,
              event.sequence,
              true,
            );
            partial.delete(stream);
          }
        }
        publish({
          type: "terminal.settled",
          payload: {
            terminalId: source.terminalId,
            sequence: event.sequence,
            status: event.snapshot.status,
            ...(event.snapshot.exitCode === undefined
              ? {}
              : { exitCode: event.snapshot.exitCode }),
            ...(event.snapshot.signal === undefined
              ? {}
              : { signal: event.snapshot.signal }),
            consumed: event.consumed,
          },
        });
      };

      const observed = await terminal.observe(
        { terminalId: source.terminalId, afterSequence: 0 },
        onObservation,
      );
      if (!observed.ok)
        throw new Error("Terminal observation source is unavailable.");
      let closePromise: Promise<void> | undefined;
      const beginClose = () => {
        if (closePromise) return closePromise;
        closed = true;
        closePromise = Promise.resolve(observed.value.close()).then(() => {
          partial.clear();
        });
        return closePromise;
      };
      const abort = () => {
        void beginClose();
      };
      signal.addEventListener("abort", abort, { once: true });
      return {
        async close() {
          signal.removeEventListener("abort", abort);
          await beginClose();
        },
      };
    },
  };
}
