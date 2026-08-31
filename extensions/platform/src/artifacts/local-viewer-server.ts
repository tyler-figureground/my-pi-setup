import { createHash, randomBytes } from "node:crypto";
import { createServer, type ServerResponse } from "node:http";
import { artifactCsp, shellCsp, viewerShell } from "./viewer-shell.ts";

export interface LocalPublication {
  readonly handle: string;
  body: Buffer;
  mediaType: string;
  interactive: boolean;
  readonly live: boolean;
  revision: number;
  readonly expiresAt: number;
  readonly capabilityHash: string;
  state: "active" | "revoked";
}

export function viewerHash(value: string) {
  return createHash("sha256").update(value).digest("hex");
}

function headers(response: ServerResponse) {
  response.setHeader("Referrer-Policy", "no-referrer");
  response.setHeader("X-Content-Type-Options", "nosniff");
  response.setHeader("Cache-Control", "no-store");
  response.setHeader("Cross-Origin-Resource-Policy", "same-origin");
}

function sessionCookie(header: string | undefined) {
  if (!header || Buffer.byteLength(header) > 4_096) return undefined;
  return header
    .split(";")
    .map((item) => item.trim().split("="))
    .find(([name]) => name === "pi_artifact_session")
    ?.slice(1)
    .join("=");
}

export function createLocalViewerServer(
  publications: Map<string, LocalPublication>,
  capabilities: Map<string, string>,
  sessions: Map<string, string>,
  clock: () => number,
  port = 0,
) {
  let expectedHost = "";
  let origin = "";
  const server = createServer((request, response) => {
    headers(response);
    if (request.headers.host !== expectedHost) {
      response.statusCode = 421;
      response.end("Misdirected request");
      return;
    }
    const url = new URL(request.url ?? "/", origin);
    if (request.method === "GET" && url.pathname === "/open") {
      const nonce = randomBytes(18).toString("base64url");
      response.setHeader("Content-Security-Policy", shellCsp(nonce));
      response.setHeader("Content-Type", "text/html; charset=utf-8");
      response.end(viewerShell(nonce));
      return;
    }
    if (request.method === "POST" && url.pathname === "/session") {
      const site = request.headers["sec-fetch-site"];
      const token = request.headers["x-artifact-capability"];
      if (
        request.headers.origin !== origin ||
        (site !== "same-origin" && site !== "none") ||
        typeof token !== "string" ||
        Buffer.byteLength(token) > 256
      ) {
        response.statusCode = 403;
        response.end("Forbidden");
        return;
      }
      const handle = capabilities.get(viewerHash(token));
      const publication = handle ? publications.get(handle) : undefined;
      if (
        !publication ||
        publication.state !== "active" ||
        publication.expiresAt <= clock()
      ) {
        response.statusCode = 403;
        response.end("Forbidden");
        return;
      }
      const session = randomBytes(32).toString("base64url");
      if (sessions.size >= 1_024) {
        const oldest = sessions.keys().next().value;
        if (oldest) sessions.delete(oldest);
      }
      sessions.set(viewerHash(session), publication.handle);
      response.setHeader(
        "Set-Cookie",
        `pi_artifact_session=${session}; HttpOnly; SameSite=Strict; Path=/p/${publication.handle}/; Max-Age=${Math.max(1, Math.floor((publication.expiresAt - clock()) / 1_000))}`,
      );
      response.setHeader("Content-Type", "application/json; charset=utf-8");
      response.end(
        JSON.stringify({
          contentPath: `/p/${publication.handle}/content`,
          live: publication.live,
          revision: publication.revision,
        }),
      );
      return;
    }
    const match = /^\/p\/([A-Za-z0-9][A-Za-z0-9._:-]{0,127})\/content$/u.exec(
      url.pathname,
    );
    const revisionMatch =
      /^\/p\/([A-Za-z0-9][A-Za-z0-9._:-]{0,127})\/revision$/u.exec(
        url.pathname,
      );
    if (request.method === "GET" && revisionMatch) {
      const handle = revisionMatch[1]!;
      const cookie = sessionCookie(request.headers.cookie);
      const publication = publications.get(handle);
      if (
        !cookie ||
        sessions.get(viewerHash(cookie)) !== handle ||
        !publication ||
        !publication.live ||
        publication.state !== "active" ||
        publication.expiresAt <= clock()
      ) {
        response.statusCode = 404;
        response.end("Not found");
        return;
      }
      response.setHeader("Content-Type", "application/json; charset=utf-8");
      response.end(JSON.stringify({ revision: publication.revision }));
      return;
    }
    if (request.method === "GET" && match) {
      const handle = match[1]!;
      const cookie = sessionCookie(request.headers.cookie);
      const publication = publications.get(handle);
      if (
        !cookie ||
        sessions.get(viewerHash(cookie)) !== handle ||
        !publication ||
        publication.state !== "active" ||
        publication.expiresAt <= clock()
      ) {
        response.statusCode = 404;
        response.end("Not found");
        return;
      }
      response.setHeader(
        "Content-Security-Policy",
        artifactCsp(publication.interactive),
      );
      response.setHeader("Content-Type", publication.mediaType);
      response.end(publication.body);
      return;
    }
    response.statusCode = 404;
    response.end("Not found");
  });

  let started: Promise<string> | undefined;
  return {
    start() {
      if (!started) {
        started = new Promise<string>((resolve, reject) => {
          server.once("error", reject);
          server.listen(port, "127.0.0.1", () => {
            server.off("error", reject);
            const address = server.address();
            if (!address || typeof address === "string") {
              reject(
                new Error("Loopback viewer did not receive a TCP address."),
              );
              return;
            }
            expectedHost = `127.0.0.1:${address.port}`;
            origin = `http://${expectedHost}`;
            resolve(origin);
          });
        }).catch((error) => {
          started = undefined;
          throw error;
        });
      }
      return started;
    },
    async close() {
      if (!started) return;
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    },
  };
}
