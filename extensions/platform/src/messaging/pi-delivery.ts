import { createHash } from "node:crypto";
import {
  closeSync,
  existsSync,
  fstatSync,
  fsyncSync,
  openSync,
  readSync,
} from "node:fs";
import type {
  CustomMessageEntry,
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { failure, success } from "../core/result.ts";
import type { RuntimeDelivery, SessionDeliveryAdapter } from "./index.ts";

const CUSTOM_TYPE = "platform-session-inbox";
const MAX_SESSION_BYTES = 64 * 1024 * 1024;
const MAX_SESSION_LINES = 100_000;
const MAX_SESSION_LINE_BYTES = 1024 * 1024;

class SessionFileStructureError extends Error {}

interface PiDeliveryContext {
  readonly sessionManager: Pick<
    ExtensionContext["sessionManager"],
    "getEntries" | "getSessionFile" | "getSessionId" | "getSessionName"
  >;
  isIdle(): boolean;
}

interface DeliveryDetails {
  readonly version: 1;
  readonly mailboxMessageId: string;
  readonly mailboxPosition: number;
  readonly payloadSha256: string;
}

/** @internal Pi lifecycle signals consumed by the delivery adapter. */
export type PiSessionDeliveryEvent = {
  readonly type:
    | "agent_settled"
    | "session_before_compact"
    | "session_compact"
    | "session_compact_failed"
    | "session_before_tree"
    | "session_tree"
    | "session_shutdown";
};

/** @internal Pi-backed implementation of the messaging delivery boundary. */
export interface PiSessionDeliveryAdapter extends SessionDeliveryAdapter {
  handleEvent(event: PiSessionDeliveryEvent): void;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function canonicalJson(value: unknown): string {
  if (value === null) return "null";
  if (typeof value === "string" || typeof value === "boolean") {
    return JSON.stringify(value);
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new TypeError("Delivery identity contains a non-finite number.");
    }
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value
      .map((item) => (item === undefined ? "null" : canonicalJson(item)))
      .join(",")}]`;
  }
  if (!isRecord(value)) {
    throw new TypeError("Delivery identity contains a non-JSON value.");
  }
  return `{${Object.entries(value)
    .filter(([, item]) => item !== undefined)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`)
    .join(",")}}`;
}

function payloadHash(delivery: RuntimeDelivery) {
  return createHash("sha256")
    .update(
      canonicalJson({
        version: 1,
        envelope: delivery.envelope,
        renderedContent: delivery.renderedContent,
      }),
    )
    .digest("hex");
}

function matchingEntries(
  entries: readonly unknown[],
  mailboxMessageId: string,
) {
  if (entries.length > MAX_SESSION_LINES) {
    throw new SessionFileStructureError(
      "Pi live session exceeds delivery scan entry limit.",
    );
  }
  return entries.filter(
    (entry): entry is CustomMessageEntry<DeliveryDetails> =>
      isRecord(entry) &&
      entry.type === "custom_message" &&
      entry.customType === CUSTOM_TYPE &&
      isRecord(entry.details) &&
      entry.details.mailboxMessageId === mailboxMessageId,
  );
}

function isExactDeliveryEntry(
  entry: CustomMessageEntry<DeliveryDetails>,
  delivery: RuntimeDelivery,
  payloadSha256: string,
) {
  return (
    entry.display === true &&
    entry.content === delivery.renderedContent &&
    entry.details?.version === 1 &&
    entry.details.mailboxMessageId === delivery.envelope.id &&
    entry.details.mailboxPosition === delivery.envelope.mailboxPosition &&
    entry.details.payloadSha256 === payloadSha256
  );
}

function readSessionFile(path: string, sessionId: string) {
  const handle = openSync(path, "r");
  let text: string;
  try {
    const initialSize = fstatSync(handle).size;
    if (initialSize > MAX_SESSION_BYTES) {
      throw new SessionFileStructureError(
        "Pi session JSONL exceeds delivery scan byte limit.",
      );
    }
    const buffer = Buffer.alloc(initialSize + 1);
    let offset = 0;
    while (offset < buffer.length) {
      const bytesRead = readSync(
        handle,
        buffer,
        offset,
        buffer.length - offset,
        offset,
      );
      if (bytesRead === 0) break;
      offset += bytesRead;
    }
    if (offset > MAX_SESSION_BYTES) {
      throw new SessionFileStructureError(
        "Pi session JSONL exceeds delivery scan byte limit.",
      );
    }
    if (fstatSync(handle).size !== offset) {
      throw new Error("Pi session JSONL changed during bounded readback.");
    }
    text = buffer.subarray(0, offset).toString("utf8");
  } finally {
    closeSync(handle);
  }
  if (!text.endsWith("\n")) {
    throw new SessionFileStructureError(
      "Pi session JSONL has an incomplete final line.",
    );
  }
  const lines = text.slice(0, -1).split("\n");
  if (lines.length > MAX_SESSION_LINES) {
    throw new SessionFileStructureError(
      "Pi session JSONL exceeds delivery scan line limit.",
    );
  }
  const parsed = lines.map((line, index) => {
    if (line.length === 0 || Buffer.byteLength(line) > MAX_SESSION_LINE_BYTES) {
      throw new SessionFileStructureError(
        `Pi session JSONL line ${index + 1} is outside structural limits.`,
      );
    }
    try {
      const entry = JSON.parse(line) as unknown;
      if (!isRecord(entry)) throw new Error("Entry is not an object.");
      return entry;
    } catch (error) {
      if (error instanceof SessionFileStructureError) throw error;
      throw new SessionFileStructureError(
        `Pi session JSONL line ${index + 1} is malformed.`,
      );
    }
  });
  const header = parsed[0];
  if (
    !isRecord(header) ||
    header.type !== "session" ||
    header.id !== sessionId
  ) {
    throw new SessionFileStructureError(
      "Pi session JSONL header does not match current session.",
    );
  }
  return parsed.slice(1);
}

function flush(path: string) {
  const handle = openSync(path, "r+");
  try {
    fsyncSync(handle);
  } finally {
    closeSync(handle);
  }
}

function unavailable(message: string) {
  return failure({
    code: "temporarily_unavailable" as const,
    message,
    retryable: true,
  });
}

function permanentlyUnavailable(message: string) {
  return failure({
    code: "permanently_unavailable" as const,
    message,
    retryable: false,
  });
}

function readFailure(error: unknown) {
  if (error instanceof SessionFileStructureError) {
    return permanentlyUnavailable(`${error.message} Manual recovery required.`);
  }
  return unavailable(error instanceof Error ? error.message : String(error));
}

export function createPiSessionDeliveryAdapter(
  pi: Pick<ExtensionAPI, "sendMessage">,
  context: PiDeliveryContext,
): PiSessionDeliveryAdapter {
  let compacting = false;
  let navigatingTree = false;
  let stopping = false;
  let deliveryTail = Promise.resolve();
  const listeners = new Set<
    Parameters<SessionDeliveryAdapter["subscribe"]>[0]
  >();
  const currentSnapshot = () => {
    if (stopping) return { status: "stopping" as const, capabilities: [] };
    if (compacting || navigatingTree) {
      return { status: "waiting" as const, capabilities: [] };
    }
    try {
      const sessionFile = context.sessionManager.getSessionFile();
      const sessionId = context.sessionManager.getSessionId();
      const name = context.sessionManager.getSessionName();
      const status = context.isIdle()
        ? ("idle" as const)
        : ("running" as const);
      let available = false;
      if (sessionFile !== undefined && existsSync(sessionFile)) {
        try {
          readSessionFile(sessionFile, sessionId);
          available = true;
        } catch {
          available = false;
        }
      }
      return {
        ...(name === undefined ? {} : { name }),
        status,
        capabilities: available
          ? [{ id: "pi.delivery/inbox", version: 1 }]
          : [],
      };
    } catch {
      return { status: "stopping" as const, capabilities: [] };
    }
  };
  return {
    handleEvent(event) {
      if (stopping) return;
      if (event.type === "session_shutdown") {
        stopping = true;
        compacting = false;
        navigatingTree = false;
      } else if (event.type === "session_before_compact") {
        compacting = true;
      } else if (
        event.type === "session_compact" ||
        event.type === "session_compact_failed"
      ) {
        compacting = false;
      } else if (event.type === "session_before_tree") {
        navigatingTree = true;
      } else if (event.type === "session_tree") {
        navigatingTree = false;
      }
      const current = currentSnapshot();
      for (const listener of listeners) listener(current);
    },
    snapshot: currentSnapshot,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    deliverOnce(delivery, signal) {
      const pending = deliveryTail.then(() => {
        try {
          if (
            delivery.envelope.delivery.mode !== "pi/inbox" ||
            delivery.envelope.delivery.version !== 1
          ) {
            return failure({
              code: "unsupported_mode",
              message: "Pi delivery mode is unsupported.",
              retryable: false,
            });
          }
          if (stopping) {
            return unavailable("Pi delivery generation is stopping.");
          }
          if (compacting || navigatingTree) {
            return unavailable(
              "Pi delivery is suspended during a structural session operation.",
            );
          }
          if (signal?.aborted) {
            return failure({
              code: "cancelled",
              message: "Pi delivery was cancelled.",
              retryable: false,
            });
          }
          const sessionFile = context.sessionManager.getSessionFile();
          if (sessionFile === undefined) {
            return failure({
              code: "unsupported_mode",
              message: "Pi session has no persistent session file.",
              retryable: false,
            });
          }
          if (!existsSync(sessionFile)) {
            return unavailable("Pi session file is not materialized yet.");
          }
          const sessionId = context.sessionManager.getSessionId();
          let diskEntries: Record<string, unknown>[];
          try {
            diskEntries = readSessionFile(sessionFile, sessionId);
          } catch (error) {
            return readFailure(error);
          }
          const payloadSha256 = payloadHash(delivery);
          const priorLive = matchingEntries(
            context.sessionManager.getEntries(),
            delivery.envelope.id,
          );
          const priorDisk = matchingEntries(diskEntries, delivery.envelope.id);
          if (
            priorLive.length === 1 &&
            priorDisk.length === 1 &&
            priorLive[0]?.id === priorDisk[0]?.id &&
            isExactDeliveryEntry(priorLive[0], delivery, payloadSha256) &&
            isExactDeliveryEntry(priorDisk[0], delivery, payloadSha256)
          ) {
            try {
              flush(sessionFile);
              const verified = matchingEntries(
                readSessionFile(sessionFile, sessionId),
                delivery.envelope.id,
              );
              if (
                verified.length !== 1 ||
                verified[0]?.id !== priorLive[0].id ||
                !isExactDeliveryEntry(verified[0], delivery, payloadSha256)
              ) {
                return unavailable(
                  "Pi delivery entry failed durable readback.",
                );
              }
            } catch (error) {
              return readFailure(error);
            }
            if (
              context.sessionManager.getSessionFile() !== sessionFile ||
              context.sessionManager.getSessionId() !== sessionId
            ) {
              return unavailable(
                "Pi session changed during delivery verification.",
              );
            }
            return success({
              state: "already-present" as const,
              durableReceipt: `pi:${sessionId}:entry:${priorLive[0].id}:mail:${delivery.envelope.id}`,
            });
          }
          if (priorLive.length > 1 || priorDisk.length > 1) {
            return permanentlyUnavailable(
              "Mailbox message ID has duplicate Pi delivery entries.",
            );
          }
          if (
            [...priorLive, ...priorDisk].some(
              (entry) => !isExactDeliveryEntry(entry, delivery, payloadSha256),
            )
          ) {
            return permanentlyUnavailable(
              "Mailbox message ID was already used for different content.",
            );
          }
          if (priorLive.length === 1 && priorDisk.length === 1) {
            return permanentlyUnavailable(
              "Mailbox message ID was already used for different content.",
            );
          }
          if (priorLive.length === 1 || priorDisk.length === 1) {
            return unavailable(
              "Mailbox delivery marker is not present in both live and durable session state.",
            );
          }
          pi.sendMessage(
            {
              customType: CUSTOM_TYPE,
              content: delivery.renderedContent,
              display: true,
              details: {
                version: 1,
                mailboxMessageId: delivery.envelope.id,
                mailboxPosition: delivery.envelope.mailboxPosition,
                payloadSha256,
              },
            },
            { triggerTurn: false },
          );
          if (
            context.sessionManager.getSessionFile() !== sessionFile ||
            context.sessionManager.getSessionId() !== sessionId
          ) {
            return unavailable(
              "Pi session changed during delivery verification.",
            );
          }
          const liveMatches = matchingEntries(
            context.sessionManager.getEntries(),
            delivery.envelope.id,
          );
          if (liveMatches.length > 1) {
            return permanentlyUnavailable(
              "Mailbox message ID has duplicate Pi delivery entries.",
            );
          }
          if (liveMatches.length === 0) {
            return unavailable(
              "Pi did not expose exactly one live delivery entry.",
            );
          }
          const live = liveMatches[0]!;
          if (!isExactDeliveryEntry(live, delivery, payloadSha256)) {
            return unavailable(
              "Pi live delivery entry failed exact verification.",
            );
          }
          try {
            flush(sessionFile);
            const diskMatches = matchingEntries(
              readSessionFile(sessionFile, sessionId),
              delivery.envelope.id,
            );
            if (diskMatches.length > 1) {
              return permanentlyUnavailable(
                "Mailbox message ID has duplicate Pi delivery entries.",
              );
            }
            if (
              diskMatches.length === 0 ||
              diskMatches[0]?.id !== live.id ||
              !isExactDeliveryEntry(diskMatches[0], delivery, payloadSha256)
            ) {
              return unavailable("Pi delivery entry failed durable readback.");
            }
          } catch (error) {
            return readFailure(error);
          }
          if (
            context.sessionManager.getSessionFile() !== sessionFile ||
            context.sessionManager.getSessionId() !== sessionId
          ) {
            return unavailable(
              "Pi session changed during delivery verification.",
            );
          }
          return success({
            state: "accepted" as const,
            durableReceipt: `pi:${sessionId}:entry:${live.id}:mail:${delivery.envelope.id}`,
          });
        } catch (error) {
          if (error instanceof SessionFileStructureError) {
            return readFailure(error);
          }
          stopping = true;
          return unavailable(
            error instanceof Error ? error.message : String(error),
          );
        }
      });
      deliveryTail = pending.then(
        () => undefined,
        () => undefined,
      );
      return pending;
    },
  };
}
