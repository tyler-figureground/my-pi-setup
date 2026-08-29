import { isIP } from "node:net";
import { isProxy } from "node:util/types";
import type {
  JsonObject,
  JsonValue,
  ModuleError,
  Outcome,
} from "../../core/result.ts";
import type { MonitorSourceFactory } from "./model.ts";

export interface NamedPollRequest {
  readonly input: JsonObject;
  readonly credentialReference?: string;
  readonly signal: AbortSignal;
}

export interface NamedPollAdapter {
  poll(
    request: NamedPollRequest,
  ): Promise<
    Outcome<JsonObject, ModuleError<"offline" | "policy_denied" | "failed">>
  >;
}

export interface PollMonitorSourceOptions {
  readonly adapters: Readonly<Record<string, NamedPollAdapter>>;
  readonly minimumIntervalMs?: number;
  readonly maximumBackoffMs?: number;
  readonly requestTimeoutMs?: number;
}

export interface PinnedPollDestination {
  readonly canonicalUrl: string;
  readonly addresses: readonly {
    readonly address: string;
    readonly family: 4 | 6;
  }[];
}

export interface PinnedJsonPollFetchRequest extends PinnedPollDestination {
  readonly method: "GET";
  readonly redirect: "error";
  readonly proxy: "none";
  readonly signal: AbortSignal;
  readonly headers?: Readonly<Record<string, string>>;
}

export interface JsonPollAdapterOptions {
  readonly endpoint: string;
  authorize(request: {
    readonly url: string;
    readonly credentialReference?: string;
  }): Promise<
    Outcome<PinnedPollDestination, ModuleError<"policy_denied" | "offline">>
  >;
  readonly resolveCredential?: (
    reference: string,
    destination: string,
  ) => Promise<string | undefined>;
  readonly pinnedFetch: (
    request: PinnedJsonPollFetchRequest,
  ) => Promise<Response>;
  readonly maxResponseBytes?: number;
}

function pollFailure<Code extends "offline" | "policy_denied" | "failed">(
  code: Code,
  message: string,
  retryable: boolean,
) {
  return { ok: false as const, error: { code, message, retryable } };
}

function exactRecord(value: unknown, keys: readonly string[]) {
  try {
    if (
      value === null ||
      typeof value !== "object" ||
      Array.isArray(value) ||
      isProxy(value) ||
      (Object.getPrototypeOf(value) !== Object.prototype &&
        Object.getPrototypeOf(value) !== null)
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

function decodeDestination(value: unknown, expectedUrl: string) {
  const outcome = exactRecord(value, ["ok", "value"]);
  const destination = exactRecord(outcome?.value, [
    "canonicalUrl",
    "addresses",
  ]);
  if (
    outcome?.ok !== true ||
    !destination ||
    destination.canonicalUrl !== expectedUrl ||
    !Array.isArray(destination.addresses)
  )
    return undefined;
  const descriptors = Object.getOwnPropertyDescriptors(
    destination.addresses,
  ) as unknown as PropertyDescriptorMap;
  const length = descriptors.length?.value;
  if (
    !Number.isSafeInteger(length) ||
    length < 1 ||
    length > 8 ||
    Reflect.ownKeys(destination.addresses).length !== length + 1
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
  return { canonicalUrl: expectedUrl, addresses };
}

function plainJsonObject(value: unknown): JsonObject | undefined {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    isProxy(value)
  )
    return undefined;
  const active = new WeakSet<object>();
  let nodes = 0;
  const visit = (candidate: unknown, depth: number): JsonValue | undefined => {
    if (
      candidate === null ||
      typeof candidate === "string" ||
      typeof candidate === "boolean"
    )
      return candidate;
    if (typeof candidate === "number")
      return Number.isFinite(candidate) ? candidate : undefined;
    if (
      !candidate ||
      typeof candidate !== "object" ||
      isProxy(candidate) ||
      depth > 16 ||
      ++nodes > 2_048 ||
      active.has(candidate)
    )
      return undefined;
    const prototype = Object.getPrototypeOf(candidate);
    if (
      (Array.isArray(candidate) && prototype !== Array.prototype) ||
      (!Array.isArray(candidate) &&
        prototype !== Object.prototype &&
        prototype !== null)
    )
      return undefined;
    active.add(candidate);
    try {
      const descriptors = Object.getOwnPropertyDescriptors(candidate);
      const keys = Reflect.ownKeys(candidate);
      if (keys.length > 256 || keys.some((key) => typeof key !== "string"))
        return undefined;
      if (Array.isArray(candidate)) {
        const length = descriptors.length?.value;
        if (!Number.isSafeInteger(length) || keys.length !== length + 1)
          return undefined;
        const output: JsonValue[] = [];
        for (let index = 0; index < length; index += 1) {
          const descriptor = descriptors[String(index)];
          if (!descriptor || !("value" in descriptor) || !descriptor.enumerable)
            return undefined;
          const item = visit(descriptor.value, depth + 1);
          if (item === undefined) return undefined;
          output.push(item);
        }
        return output;
      }
      const output: Record<string, JsonValue> = Object.create(null);
      for (const key of keys as string[]) {
        const descriptor = descriptors[key];
        if (!descriptor || !("value" in descriptor) || !descriptor.enumerable)
          return undefined;
        const item = visit(descriptor.value, depth + 1);
        if (item === undefined) return undefined;
        output[key] = item;
      }
      return output;
    } finally {
      active.delete(candidate);
    }
  };
  const decoded = visit(value, 0);
  return decoded && typeof decoded === "object" && !Array.isArray(decoded)
    ? (decoded as JsonObject)
    : undefined;
}

export function createJsonPollAdapter(
  options: JsonPollAdapterOptions,
): NamedPollAdapter {
  if (typeof options.pinnedFetch !== "function")
    throw new TypeError("Named poll requires a pinned fetch injection.");
  const endpoint = new URL(options.endpoint);
  if (
    !["http:", "https:"].includes(endpoint.protocol) ||
    endpoint.username ||
    endpoint.password ||
    endpoint.hash ||
    [...endpoint.searchParams.keys()].some((key) =>
      /^(?:authorization|password|secret|token|api[-_]?key|credential)$/i.test(
        key,
      ),
    )
  )
    throw new TypeError("Named poll endpoint is invalid.");
  const maxResponseBytes = options.maxResponseBytes ?? 64 * 1024;
  if (
    !Number.isSafeInteger(maxResponseBytes) ||
    maxResponseBytes < 1 ||
    maxResponseBytes > 1024 * 1024
  )
    throw new TypeError("Named poll response limit is invalid.");
  return {
    async poll(request) {
      const authorized = await options.authorize({
        url: endpoint.href,
        ...(request.credentialReference
          ? { credentialReference: request.credentialReference }
          : {}),
      });
      if (request.signal.aborted)
        return pollFailure("offline", "Named poll was aborted.", true);
      const destination = decodeDestination(authorized, endpoint.href);
      if (!destination) {
        return pollFailure(
          "policy_denied",
          "Named poll policy denied or failed to pin the destination.",
          false,
        );
      }
      const authorization =
        request.credentialReference && options.resolveCredential
          ? await options.resolveCredential(
              request.credentialReference,
              endpoint.origin,
            )
          : undefined;
      if (request.signal.aborted)
        return pollFailure("offline", "Named poll was aborted.", true);
      let response: Response;
      try {
        response = await options.pinnedFetch({
          ...destination,
          method: "GET",
          redirect: "error",
          proxy: "none",
          signal: request.signal,
          ...(authorization ? { headers: { authorization } } : {}),
        });
      } catch {
        return pollFailure("offline", "Named poll target is offline.", true);
      }
      if (!response.ok) {
        return pollFailure(
          response.status >= 500 ? "offline" : "failed",
          "Named poll request did not succeed.",
          response.status >= 500,
        );
      }
      const declared = Number(response.headers.get("content-length"));
      if (Number.isFinite(declared) && declared > maxResponseBytes) {
        return pollFailure(
          "failed",
          "Named poll response exceeded its byte limit.",
          false,
        );
      }
      const reader = response.body?.getReader();
      const chunks: Uint8Array[] = [];
      let bytes = 0;
      if (reader) {
        while (true) {
          const next = await reader.read();
          if (next.done) break;
          bytes += next.value.byteLength;
          if (bytes > maxResponseBytes) {
            await reader.cancel();
            return pollFailure(
              "failed",
              "Named poll response exceeded its byte limit.",
              false,
            );
          }
          chunks.push(next.value);
        }
      }
      const body = Buffer.concat(
        chunks.map((chunk) => Buffer.from(chunk)),
        bytes,
      ).toString("utf8");
      try {
        const value: unknown = body.length === 0 ? {} : JSON.parse(body);
        const decoded = plainJsonObject(value);
        if (!decoded) {
          return pollFailure(
            "failed",
            "Named poll response must be a plain JSON object.",
            false,
          );
        }
        return { ok: true, value: decoded };
      } catch {
        return pollFailure(
          "failed",
          "Named poll response was invalid JSON.",
          false,
        );
      }
    },
  };
}

export function createPollMonitorSourceFactory(
  options: PollMonitorSourceOptions,
): MonitorSourceFactory {
  const minimumIntervalMs = options.minimumIntervalMs ?? 5_000;
  const maximumBackoffMs = options.maximumBackoffMs ?? 5 * 60_000;
  const requestTimeoutMs = options.requestTimeoutMs ?? 30_000;
  for (const value of [minimumIntervalMs, maximumBackoffMs, requestTimeoutMs]) {
    if (!Number.isSafeInteger(value) || value < 1) {
      throw new TypeError("Poll monitor timing limit is invalid.");
    }
  }
  return {
    async open(definition, emit, signal) {
      if (definition.source.kind !== "poll") {
        throw new Error("Poll source factory received another source kind.");
      }
      const source = definition.source;
      if (source.intervalMs < minimumIntervalMs) {
        throw new Error("Poll interval is below host minimum.");
      }
      const adapter = Object.hasOwn(options.adapters, source.adapter)
        ? options.adapters[source.adapter]
        : undefined;
      if (!adapter) throw new Error("Named poll adapter is unavailable.");
      let closed = false;
      let failures = 0;
      let timer: ReturnType<typeof setTimeout> | undefined;
      let active: Promise<void> | undefined;
      let controller: AbortController | undefined;

      const schedule = (delayMs: number) => {
        if (closed || signal.aborted) return;
        timer = setTimeout(() => {
          timer = undefined;
          active = run().finally(() => {
            active = undefined;
          });
        }, delayMs);
        timer.unref?.();
      };

      const run = async () => {
        if (closed || signal.aborted) return;
        controller = new AbortController();
        const combined = AbortSignal.any([
          signal,
          controller.signal,
          AbortSignal.timeout(requestTimeoutMs),
        ]);
        let result: unknown;
        try {
          result = await adapter.poll({
            input: structuredClone(source.input ?? {}),
            ...(source.credentialReference
              ? { credentialReference: source.credentialReference }
              : {}),
            signal: combined,
          });
        } catch {
          result = undefined;
        }
        controller = undefined;
        if (closed || signal.aborted) return;
        const successful = exactRecord(result, ["ok", "value"]);
        if (successful?.ok === true) {
          const value = plainJsonObject(successful.value);
          if (!value) {
            emit({
              type: "poll.status",
              payload: {
                adapter: source.adapter,
                state: "blocked",
                code: "invalid_output",
                retryable: false,
              },
            });
            return;
          }
          failures = 0;
          const payload: Record<string, JsonValue> = Object.create(null);
          const descriptors = Object.getOwnPropertyDescriptors(value);
          for (const key of Object.keys(descriptors)) {
            const descriptor = descriptors[key]!;
            if ("value" in descriptor) payload[key] = descriptor.value;
          }
          payload.adapter = source.adapter;
          emit({ type: "poll.result", payload });
          schedule(source.intervalMs);
          return;
        }
        const failed = exactRecord(result, ["ok", "error"]);
        const error = exactRecord(failed?.error, [
          "code",
          "message",
          "retryable",
        ]);
        const code =
          failed?.ok === false &&
          error &&
          ["offline", "policy_denied", "failed"].includes(String(error.code))
            ? String(error.code)
            : "failed";
        const retryable = error?.retryable === true;
        failures += 1;
        emit({
          type: "poll.status",
          payload: {
            adapter: source.adapter,
            state: code === "offline" ? "offline" : "blocked",
            code,
            retryable,
          },
        });
        if (!retryable) return;
        schedule(
          Math.min(
            maximumBackoffMs,
            source.intervalMs * 2 ** Math.min(failures, 8),
          ),
        );
      };

      const beginClose = async () => {
        if (closed) {
          await active;
          return;
        }
        closed = true;
        if (timer) clearTimeout(timer);
        timer = undefined;
        controller?.abort(new Error("Poll monitor closed."));
        await active;
      };
      const abort = () => {
        void beginClose();
      };
      signal.addEventListener("abort", abort, { once: true });
      active = run().finally(() => {
        active = undefined;
      });
      return {
        async close() {
          signal.removeEventListener("abort", abort);
          await beginClose();
        },
      };
    },
  };
}
