import { isIP } from "node:net";
import type { LookupFunction } from "node:net";
import { isProxy } from "node:util/types";
import type { ModuleError, Outcome } from "../../core/result.ts";
import type { MonitorSourceFactory } from "./model.ts";

export interface WebSocketIntegrationControl {
  authorize(request: {
    readonly url: string;
    readonly credentialReference?: string;
  }): Promise<
    Outcome<
      {
        readonly canonicalUrl: string;
        readonly addresses: readonly {
          readonly address: string;
          readonly family: 4 | 6;
        }[];
      },
      ModuleError<"policy_denied" | "offline">
    >
  >;
}

export interface WebSocketSourceLimits {
  readonly maxMessageBytes: number;
  readonly maxFragments: number;
  readonly maxBufferedChunks: number;
  readonly maxBufferedMessages: number;
  readonly maxBufferedBytes: number;
  readonly reconnectBaseMs: number;
  readonly reconnectMaxMs: number;
  readonly maxReconnectAttempts: number;
  readonly reconnectWindowMs: number;
  readonly handshakeTimeoutMs: number;
  readonly idleTimeoutMs: number;
  readonly lifetimeMs: number;
}

export interface WebSocketMonitorSourceOptions {
  readonly allowedOrigins: readonly string[];
  readonly control: WebSocketIntegrationControl;
  readonly resolveCredential?: (
    reference: string,
    destination: string,
  ) => Promise<string | undefined>;
  readonly limits?: Partial<WebSocketSourceLimits>;
  readonly random?: () => number;
  readonly loadClient?: () => Promise<typeof import("ws")>;
}

const DEFAULT_LIMITS: WebSocketSourceLimits = Object.freeze({
  maxMessageBytes: 64 * 1024,
  maxFragments: 16,
  maxBufferedChunks: 64,
  maxBufferedMessages: 64,
  maxBufferedBytes: 256 * 1024,
  reconnectBaseMs: 500,
  reconnectMaxMs: 30_000,
  maxReconnectAttempts: 8,
  reconnectWindowMs: 5 * 60_000,
  handshakeTimeoutMs: 10_000,
  idleTimeoutMs: 60_000,
  lifetimeMs: 24 * 60 * 60_000,
});

function exactRecord(value: unknown, keys: readonly string[]) {
  try {
    if (
      !value ||
      typeof value !== "object" ||
      Array.isArray(value) ||
      isProxy(value) ||
      Object.getPrototypeOf(value) !== Object.prototype
    )
      return undefined;
    const ownKeys = Reflect.ownKeys(value);
    if (
      ownKeys.length !== keys.length ||
      ownKeys.some((key) => typeof key !== "string" || !keys.includes(key))
    )
      return undefined;
    const descriptors = Object.getOwnPropertyDescriptors(value);
    const output: Record<string, unknown> = Object.create(null);
    for (const key of keys) {
      const descriptor = descriptors[key];
      if (!descriptor || !("value" in descriptor) || !descriptor.enumerable)
        return undefined;
      output[key] = descriptor.value;
    }
    return output;
  } catch {
    return undefined;
  }
}

function decodeAuthorization(value: unknown, expectedUrl: string) {
  const outcome = exactRecord(value, ["ok", "value"]);
  const authorized = exactRecord(outcome?.value, ["canonicalUrl", "addresses"]);
  if (
    outcome?.ok !== true ||
    !authorized ||
    authorized.canonicalUrl !== expectedUrl ||
    !Array.isArray(authorized.addresses)
  )
    return undefined;
  const descriptors = Object.getOwnPropertyDescriptors(
    authorized.addresses,
  ) as unknown as PropertyDescriptorMap;
  const length = descriptors.length?.value;
  if (
    !Number.isSafeInteger(length) ||
    length < 1 ||
    length > 8 ||
    Reflect.ownKeys(authorized.addresses).length !== length + 1
  )
    return undefined;
  const addresses: { address: string; family: 4 | 6 }[] = [];
  for (let index = 0; index < length; index += 1) {
    const descriptor = descriptors[String(index)];
    const address = exactRecord(
      descriptor && "value" in descriptor ? descriptor.value : undefined,
      ["address", "family"],
    );
    if (
      !address ||
      typeof address.address !== "string" ||
      (address.family !== 4 && address.family !== 6) ||
      isIP(address.address) !== address.family
    )
      return undefined;
    addresses.push({ address: address.address, family: address.family });
  }
  return addresses;
}

function canonicalWebSocket(value: string) {
  const url = new URL(value);
  if (
    !["ws:", "wss:"].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.hash ||
    url.search
  )
    throw new TypeError("WebSocket URL is invalid.");
  return url;
}

export function createWebSocketMonitorSourceFactory(
  options: WebSocketMonitorSourceOptions,
): MonitorSourceFactory {
  const allowedOrigins = new Set(
    options.allowedOrigins.map((value) => {
      const url = canonicalWebSocket(value);
      if (url.pathname !== "/" || url.search) {
        throw new TypeError(
          "Allowed WebSocket origins must not contain paths or queries.",
        );
      }
      return url.origin;
    }),
  );
  const limits = { ...DEFAULT_LIMITS, ...options.limits };
  for (const [name, value] of Object.entries(limits)) {
    if (!Number.isSafeInteger(value) || value < 1) {
      throw new TypeError(`WebSocket ${name} limit is invalid.`);
    }
  }
  if (
    limits.reconnectBaseMs > limits.reconnectMaxMs ||
    limits.maxMessageBytes > limits.maxBufferedBytes ||
    limits.maxBufferedMessages > limits.maxBufferedChunks
  )
    throw new TypeError("WebSocket limits are inconsistent.");
  const random = options.random ?? Math.random;

  return {
    async open(definition, emit, signal) {
      if (definition.source.kind !== "websocket") {
        throw new Error(
          "WebSocket source factory received another source kind.",
        );
      }
      const source = definition.source;
      const url = canonicalWebSocket(source.url);
      if (!allowedOrigins.has(url.origin)) {
        throw new Error("WebSocket origin is not allowlisted.");
      }
      let closed = false;
      let socket: import("ws").default | undefined;
      let reconnectTimer: ReturnType<typeof setTimeout> | undefined;
      let idleTimer: ReturnType<typeof setInterval> | undefined;
      let lifetimeTimer: ReturnType<typeof setTimeout> | undefined;
      let terminateTimer: ReturnType<typeof setTimeout> | undefined;
      let closePromise: Promise<void> | undefined;
      let settleClose: (() => void) | undefined;
      let lastActivity = Date.now();
      let awaitingPong = false;
      let connectionSequence = 0;
      const reconnects: number[] = [];
      const queue: {
        payload: {
          text?: string;
          base64?: string;
          bytes: number;
          binary: boolean;
        };
        bytes: number;
      }[] = [];
      let queuedBytes = 0;
      let draining = false;

      const drain = () => {
        if (draining) return;
        draining = true;
        queueMicrotask(() => {
          draining = false;
          while (!closed && !signal.aborted && queue.length > 0) {
            const next = queue.shift()!;
            queuedBytes -= next.bytes;
            emit({
              type: "websocket.message",
              payload: {
                connectionSequence,
                binary: next.payload.binary,
                bytes: next.payload.bytes,
                ...(next.payload.text === undefined
                  ? {}
                  : { text: next.payload.text }),
                ...(next.payload.base64 === undefined
                  ? {}
                  : { base64: next.payload.base64 }),
              },
            });
          }
        });
      };

      const scheduleReconnect = () => {
        if (closed || signal.aborted || reconnectTimer) return;
        const now = Date.now();
        while (
          reconnects[0] !== undefined &&
          reconnects[0] < now - limits.reconnectWindowMs
        )
          reconnects.shift();
        if (reconnects.length >= limits.maxReconnectAttempts) {
          emit({
            type: "websocket.status",
            payload: { state: "blocked", code: "reconnect_exhausted" },
          });
          return;
        }
        reconnects.push(now);
        const exponential = Math.min(
          limits.reconnectMaxMs,
          limits.reconnectBaseMs * 2 ** Math.min(reconnects.length - 1, 8),
        );
        const delay = Math.max(
          1,
          Math.floor(exponential * (0.75 + random() * 0.25)),
        );
        reconnectTimer = setTimeout(() => {
          reconnectTimer = undefined;
          void connect().catch(() => scheduleReconnect());
        }, delay);
        reconnectTimer.unref?.();
      };

      const connect = async () => {
        if (closed || signal.aborted) return;
        const authorized = await options.control.authorize({
          url: url.href,
          ...(source.credentialReference
            ? { credentialReference: source.credentialReference }
            : {}),
        });
        if (closed || signal.aborted) return;
        const addresses = decodeAuthorization(authorized, url.href);
        if (!addresses) {
          emit({
            type: "websocket.status",
            payload: { state: "blocked", code: "policy_denied" },
          });
          const denied = exactRecord(authorized, ["ok", "error"]);
          const error = exactRecord(denied?.error, [
            "code",
            "message",
            "retryable",
          ]);
          if (denied?.ok === false && error?.retryable === true)
            scheduleReconnect();
          return;
        }
        const authorization =
          source.credentialReference && options.resolveCredential
            ? await options.resolveCredential(
                source.credentialReference,
                url.origin,
              )
            : undefined;
        if (closed || signal.aborted) return;
        let addressIndex = 0;
        const lookup: LookupFunction = (hostname, lookupOptions, callback) => {
          if (
            hostname.toLocaleLowerCase("en-US") !==
            url.hostname.toLocaleLowerCase("en-US")
          ) {
            callback(
              Object.assign(new Error("Pinned WebSocket hostname changed."), {
                code: "EPERM",
              }),
              "",
              0,
            );
            return;
          }
          const selected = addresses[addressIndex++ % addresses.length]!;
          if (lookupOptions.all) {
            callback(
              null,
              addresses.map(({ address, family }) => ({ address, family })),
            );
          } else {
            callback(null, selected.address, selected.family);
          }
        };
        const loaded = await (options.loadClient?.() ?? import("ws"));
        const clientOptions = {
          followRedirects: false,
          perMessageDeflate: false,
          maxPayload: limits.maxMessageBytes,
          maxFragments: limits.maxFragments,
          maxBufferedChunks: limits.maxBufferedChunks,
          handshakeTimeout: limits.handshakeTimeoutMs,
          skipUTF8Validation: false,
          lookup,
          ...(url.protocol === "wss:" ? { servername: url.hostname } : {}),
          ...(authorization ? { headers: { authorization } } : {}),
        } satisfies import("ws").ClientOptions & {
          readonly maxFragments: number;
          readonly maxBufferedChunks: number;
          readonly lookup: LookupFunction;
        };
        if (closed || signal.aborted) return;
        const candidate = new loaded.default(url.href, clientOptions);
        socket = candidate;
        let retired = false;
        const retire = () => {
          if (retired) return;
          retired = true;
          if (socket === candidate) socket = undefined;
          if (closed) settleClose?.();
          else scheduleReconnect();
        };
        candidate.on("open", () => {
          connectionSequence += 1;
          lastActivity = Date.now();
          awaitingPong = false;
          emit({
            type: "websocket.status",
            payload: { state: "online", connectionSequence },
          });
        });
        candidate.on("upgrade", (response) => {
          if (response.headers["sec-websocket-extensions"])
            candidate.terminate();
        });
        candidate.on("unexpected-response", () => candidate.terminate());
        candidate.on("pong", () => {
          lastActivity = Date.now();
          awaitingPong = false;
        });
        candidate.on("message", (data, isBinary) => {
          lastActivity = Date.now();
          const bytes = Buffer.isBuffer(data)
            ? data
            : Array.isArray(data)
              ? Buffer.concat(data)
              : Buffer.from(data);
          if (
            bytes.byteLength > limits.maxMessageBytes ||
            queue.length >= limits.maxBufferedMessages ||
            queuedBytes + bytes.byteLength > limits.maxBufferedBytes
          ) {
            candidate.terminate();
            return;
          }
          queue.push({
            bytes: bytes.byteLength,
            payload: isBinary
              ? {
                  base64: bytes.toString("base64"),
                  bytes: bytes.byteLength,
                  binary: true,
                }
              : {
                  text: bytes.toString("utf8"),
                  bytes: bytes.byteLength,
                  binary: false,
                },
          });
          queuedBytes += bytes.byteLength;
          drain();
        });
        candidate.on("error", () => undefined);
        candidate.on("close", retire);
      };

      const beginClose = () => {
        if (closePromise) return closePromise;
        closed = true;
        if (reconnectTimer) clearTimeout(reconnectTimer);
        if (idleTimer) clearInterval(idleTimer);
        if (lifetimeTimer) clearTimeout(lifetimeTimer);
        reconnectTimer = undefined;
        idleTimer = undefined;
        lifetimeTimer = undefined;
        queue.length = 0;
        queuedBytes = 0;
        closePromise = new Promise<void>((resolve) => {
          settleClose = resolve;
          if (!socket || socket.readyState === loadedClosedState) {
            resolve();
            return;
          }
          socket.close(1000);
          terminateTimer = setTimeout(() => socket?.terminate(), 250);
          terminateTimer.unref?.();
        }).finally(() => {
          if (terminateTimer) clearTimeout(terminateTimer);
          terminateTimer = undefined;
        });
        return closePromise;
      };

      const loadedClosedState = 3;
      idleTimer = setInterval(
        () => {
          if (!socket || socket.readyState !== 1) return;
          if (Date.now() - lastActivity < limits.idleTimeoutMs) return;
          if (awaitingPong) socket.terminate();
          else {
            awaitingPong = true;
            socket.ping();
          }
        },
        Math.max(25, Math.floor(limits.idleTimeoutMs / 2)),
      );
      idleTimer.unref?.();
      lifetimeTimer = setTimeout(() => {
        emit({
          type: "websocket.status",
          payload: { state: "blocked", code: "lifetime_exhausted" },
        });
        void beginClose();
      }, limits.lifetimeMs);
      lifetimeTimer.unref?.();
      const abort = () => {
        void beginClose();
      };
      signal.addEventListener("abort", abort, { once: true });
      await connect();
      return {
        async close() {
          signal.removeEventListener("abort", abort);
          await beginClose();
        },
      };
    },
  };
}
