import http from "node:http";
import https from "node:https";
import { Readable } from "node:stream";
import type { FetchLike } from "@modelcontextprotocol/client";

export interface PinnedFetchAuthorization {
  readonly allowed: boolean;
  readonly canonicalUrl?: string;
  readonly resolvedAddresses?: readonly string[];
}

export interface PinnedFetchOptions {
  readonly authorize: (
    url: string,
    signal?: AbortSignal,
  ) => Promise<PinnedFetchAuthorization>;
  readonly maxRequestBytes?: number;
}

async function requestBody(
  body: BodyInit | null | undefined,
  maximum: number,
): Promise<Buffer | undefined> {
  if (body === undefined || body === null) return undefined;
  let result: Buffer;
  if (typeof body === "string") result = Buffer.from(body);
  else if (body instanceof URLSearchParams)
    result = Buffer.from(body.toString());
  else if (body instanceof ArrayBuffer) result = Buffer.from(body);
  else if (ArrayBuffer.isView(body))
    result = Buffer.from(body.buffer, body.byteOffset, body.byteLength);
  else if (body instanceof Blob) result = Buffer.from(await body.arrayBuffer());
  else
    throw new TypeError(
      "Pinned fetch does not accept streaming request bodies.",
    );
  if (result.length > maximum)
    throw new Error(`Pinned request body exceeds ${maximum} bytes.`);
  return result;
}

function responseHeaders(
  headers: http.IncomingHttpHeaders,
  rawHeaders: string[],
) {
  const result = new Headers();
  for (let index = 0; index < rawHeaders.length; index += 2) {
    const name = rawHeaders[index];
    const value = rawHeaders[index + 1];
    if (name && value !== undefined) result.append(name, value);
  }
  if (rawHeaders.length === 0)
    for (const [name, value] of Object.entries(headers)) {
      if (Array.isArray(value))
        for (const item of value) result.append(name, item);
      else if (value !== undefined) result.append(name, value);
    }
  return result;
}

export function createPinnedFetch(options: PinnedFetchOptions): FetchLike {
  const maxRequestBytes = options.maxRequestBytes ?? 4 * 1024 * 1024;
  return async (input, init = {}) => {
    const requested = new URL(input);
    const authorization = await options.authorize(
      requested.href,
      init.signal ?? undefined,
    );
    if (
      !authorization.allowed ||
      !authorization.canonicalUrl ||
      !authorization.resolvedAddresses?.length
    )
      throw new Error(
        `External destination is not authorized: ${requested.origin}`,
      );
    const target = new URL(authorization.canonicalUrl);
    if (
      target.origin !== requested.origin ||
      target.protocol !== requested.protocol
    )
      throw new Error(
        "Pinned destination changed origin during authorization.",
      );
    const addresses = [...new Set(authorization.resolvedAddresses)];
    const body = await requestBody(init.body, maxRequestBytes);
    const headers = new Headers(init.headers);
    if (body && !headers.has("content-length"))
      headers.set("content-length", String(body.length));
    let settled = false;
    return new Promise<Response>((resolve, reject) => {
      const finishError = (error: unknown) => {
        if (settled) return;
        settled = true;
        reject(error);
      };
      const transport = target.protocol === "https:" ? https : http;
      const request = transport.request(
        {
          protocol: target.protocol,
          hostname: target.hostname,
          port: target.port || undefined,
          path: `${target.pathname}${target.search}`,
          method: init.method ?? "GET",
          headers: Object.fromEntries(headers.entries()),
          ...(target.protocol === "https:"
            ? { servername: target.hostname }
            : {}),
          lookup: (
            _hostname: string,
            lookupOptions: { all?: boolean },
            callback: (
              error: NodeJS.ErrnoException | null,
              address: string | Array<{ address: string; family: number }>,
              family?: number,
            ) => void,
          ) => {
            const records = addresses.map((address) => ({
              address,
              family: address.includes(":") ? 6 : 4,
            }));
            if (lookupOptions?.all) callback(null, records);
            else callback(null, records[0]!.address, records[0]!.family);
          },
        },
        (incoming) => {
          if (settled) {
            incoming.destroy();
            return;
          }
          if (
            incoming.statusCode !== undefined &&
            incoming.statusCode >= 300 &&
            incoming.statusCode < 400 &&
            incoming.headers.location
          ) {
            incoming.destroy();
            finishError(new Error("External HTTP redirects are disabled."));
            return;
          }
          settled = true;
          const webBody = Readable.toWeb(
            incoming,
          ) as ReadableStream<Uint8Array>;
          resolve(
            new Response(webBody, {
              status: incoming.statusCode ?? 500,
              statusText: incoming.statusMessage,
              headers: responseHeaders(incoming.headers, incoming.rawHeaders),
            }),
          );
        },
      );
      request.once("error", finishError);
      const abort = () =>
        request.destroy(
          init.signal?.reason ?? new DOMException("Aborted", "AbortError"),
        );
      init.signal?.addEventListener("abort", abort, { once: true });
      request.once("close", () =>
        init.signal?.removeEventListener("abort", abort),
      );
      if (body) request.write(body);
      request.end();
    });
  };
}
