import type { PublicationAdapterError } from "./model.ts";
import type { VercelArtifactTransport, VercelFile } from "./vercel.ts";

interface VercelRestTransportOptions {
  readonly project: string;
  readonly teamId?: string;
  readonly token: () => Promise<string | undefined>;
  readonly fetch?: typeof fetch;
  readonly wait?: (milliseconds: number) => Promise<void>;
  readonly timeoutMs?: number;
}

function transportError(
  code: PublicationAdapterError["code"],
  message: string,
  retryable = false,
) {
  return { ok: false as const, error: { code, message, retryable } };
}

async function readBoundedResponse(response: Response, maximum: number) {
  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > maximum)
    throw new Error("response-too-large");
  if (!response.body) return new Uint8Array();
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const next = await reader.read();
      if (next.done) break;
      total += next.value.byteLength;
      if (total > maximum) throw new Error("response-too-large");
      chunks.push(next.value);
    }
  } finally {
    await reader.cancel().catch(() => undefined);
  }
  const output = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    output.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return output;
}

function validDeploymentId(value: string) {
  return /^dpl_[A-Za-z0-9]+$/u.test(value);
}

export function createVercelRestTransport(
  options: VercelRestTransportOptions,
): VercelArtifactTransport {
  const performFetch = options.fetch ?? fetch;
  const wait =
    options.wait ??
    ((milliseconds) =>
      new Promise((resolve) => setTimeout(resolve, milliseconds)));
  const timeoutMs = options.timeoutMs ?? 30_000;
  const deploymentUrls = new Map<string, string>();
  let verifiedProjectId: string | undefined;
  const endpoint = (pathname: string) => {
    const url = new URL(pathname, "https://api.vercel.com");
    if (options.teamId) url.searchParams.set("teamId", options.teamId);
    return url.href;
  };
  const request = async (
    pathname: string,
    method = "GET",
    body?: unknown,
    ambiguousOnFailure = false,
    signal?: AbortSignal,
  ) => {
    const token = await options.token();
    if (!token)
      return transportError(
        "provider_unavailable",
        "Vercel Artifact credential is unavailable.",
      );
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await performFetch(endpoint(pathname), {
        method,
        redirect: "error",
        signal: signal
          ? AbortSignal.any([controller.signal, signal])
          : controller.signal,
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
          Accept: "application/json",
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      if (!response.ok) {
        const uncertain =
          ambiguousOnFailure &&
          (response.status >= 500 || response.status === 429);
        return transportError(
          uncertain
            ? "ambiguous_outcome"
            : response.status >= 500 || response.status === 429
              ? "provider_unavailable"
              : "provider_rejected",
          `Vercel Artifact request failed with HTTP ${response.status}.`,
          !uncertain && (response.status >= 500 || response.status === 429),
        );
      }
      let bytes: Uint8Array;
      try {
        bytes = await readBoundedResponse(response, 1024 * 1024);
      } catch {
        return transportError(
          ambiguousOnFailure ? "ambiguous_outcome" : "provider_rejected",
          "Vercel Artifact response exceeded its byte limit.",
        );
      }
      try {
        return {
          ok: true as const,
          value: JSON.parse(
            new TextDecoder("utf-8", { fatal: true }).decode(bytes),
          ) as unknown,
        };
      } catch {
        return transportError(
          ambiguousOnFailure ? "ambiguous_outcome" : "provider_rejected",
          "Vercel Artifact response was not bounded UTF-8 JSON.",
        );
      }
    } catch {
      return transportError(
        ambiguousOnFailure
          ? "ambiguous_outcome"
          : signal?.aborted
            ? "cancelled"
            : "provider_unavailable",
        ambiguousOnFailure
          ? "Vercel Artifact request failed after dispatch with an unknown outcome."
          : signal?.aborted
            ? "Vercel Artifact request was cancelled before a remote mutation."
            : "Vercel Artifact request failed before a remote mutation.",
        !ambiguousOnFailure && !signal?.aborted,
      );
    } finally {
      clearTimeout(timeout);
    }
  };

  const verifyProject = async (signal?: AbortSignal) => {
    const result = await request(
      `/v9/projects/${encodeURIComponent(options.project)}`,
      "GET",
      undefined,
      false,
      signal,
    );
    if (!result.ok) return result;
    const value = result.value as {
      id?: unknown;
      ssoProtection?: { deploymentType?: unknown };
    };
    if (typeof value.id !== "string" || !/^prj_[A-Za-z0-9]+$/u.test(value.id))
      return transportError(
        "provider_rejected",
        "Vercel Artifact project identity is invalid.",
      );
    verifiedProjectId = value.id;
    return {
      ok: true as const,
      value: {
        preview:
          value.ssoProtection?.deploymentType === "all"
            ? ("all" as const)
            : ("none" as const),
      },
    };
  };

  return {
    projectProtection: verifyProject,
    async deploy(input, signal) {
      const result = await request(
        "/v13/deployments",
        "POST",
        {
          name: input.name,
          project: input.project,
          files: input.files,
          meta: { piArtifactIntent: input.intentId },
          projectSettings: {
            framework: null,
            buildCommand: null,
            installCommand: null,
            outputDirectory: null,
            skipGitConnectDuringLink: true,
          },
        },
        true,
        signal,
      );
      if (!result.ok) return result;
      if (!result.value || typeof result.value !== "object")
        return transportError(
          "ambiguous_outcome",
          "Vercel deployment response omitted its recovery identity.",
        );
      let value = result.value as {
        id?: unknown;
        url?: unknown;
        target?: unknown;
        readyState?: unknown;
        projectId?: unknown;
        meta?: { piArtifactIntent?: unknown };
      };
      if (typeof value.id !== "string" || !validDeploymentId(value.id))
        return transportError(
          "ambiguous_outcome",
          "Vercel deployment response omitted its recovery identity.",
        );
      const id = value.id;
      if (
        typeof value.url !== "string" ||
        !value.url.endsWith(".vercel.app") ||
        value.projectId !== verifiedProjectId ||
        value.meta?.piArtifactIntent !== input.intentId ||
        value.target !== null
      ) {
        const cleaned = await request(
          `/v13/deployments/${encodeURIComponent(id)}`,
          "DELETE",
          undefined,
          true,
          signal,
        );
        return cleaned.ok
          ? transportError(
              "provider_rejected",
              "Invalid Vercel deployment identity was deleted.",
            )
          : {
              ok: false,
              error: {
                code: "ambiguous_outcome",
                message:
                  "Invalid Vercel deployment identity could not be deleted.",
                retryable: false,
                details: { providerReference: id },
              },
            };
      }
      const deploymentUrl = value.url;
      const target = value.target;
      let readyState = value.readyState;
      for (let attempt = 0; readyState !== "READY" && attempt < 30; attempt++) {
        if (["ERROR", "CANCELED"].includes(String(readyState))) break;
        if (signal?.aborted)
          return transportError(
            "ambiguous_outcome",
            "Vercel deployment polling was cancelled after dispatch.",
          );
        await wait(1_000);
        const polled = await request(
          `/v13/deployments/${encodeURIComponent(id)}`,
          "GET",
          undefined,
          false,
          signal,
        );
        if (!polled.ok)
          return {
            ok: false,
            error: {
              ...polled.error,
              code: "ambiguous_outcome",
              retryable: false,
              details: { providerReference: id },
            },
          };
        const next = polled.value as {
          target?: unknown;
          readyState?: unknown;
        };
        if (next.target !== undefined && next.target !== null)
          return {
            ok: false,
            error: {
              code: "ambiguous_outcome",
              message: "Vercel deployment changed away from preview target.",
              retryable: false,
              details: { providerReference: id },
            },
          };
        readyState = next.readyState ?? readyState;
      }
      deploymentUrls.set(id, deploymentUrl);
      return {
        ok: true,
        value: {
          id,
          url: deploymentUrl,
          target,
          readyState: String(readyState ?? "UNKNOWN"),
        },
      };
    },
    async findDeployment(intentId, signal) {
      if (!verifiedProjectId) {
        const verified = await verifyProject(signal);
        if (!verified.ok) return verified;
      }
      if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u.test(intentId))
        return transportError(
          "provider_rejected",
          "Vercel Artifact intent id is invalid.",
        );
      const projectId = verifiedProjectId;
      if (!projectId)
        return transportError(
          "provider_rejected",
          "Vercel Artifact project identity was not verified.",
        );
      const ids: string[] = [];
      let until: string | undefined;
      for (let page = 0; page < 10; page += 1) {
        const query = new URLSearchParams({
          projectId,
          limit: "100",
          ...(until ? { until } : {}),
        });
        const result = await request(
          `/v7/deployments?${query}`,
          "GET",
          undefined,
          false,
          signal,
        );
        if (!result.ok) return result;
        const value = result.value as {
          deployments?: unknown;
          pagination?: { next?: unknown };
        };
        if (!Array.isArray(value.deployments))
          return transportError(
            "provider_rejected",
            "Vercel deployment lookup response is invalid.",
          );
        for (const entry of value.deployments) {
          if (!entry || typeof entry !== "object") continue;
          const record = entry as {
            uid?: unknown;
            id?: unknown;
            projectId?: unknown;
            target?: unknown;
            meta?: { piArtifactIntent?: unknown };
          };
          const id = record.uid ?? record.id;
          if (
            typeof id === "string" &&
            validDeploymentId(id) &&
            record.projectId === projectId &&
            record.target === null &&
            record.meta?.piArtifactIntent === intentId
          )
            ids.push(id);
        }
        if (ids.length > 1)
          return transportError(
            "provider_rejected",
            "Vercel Artifact intent matched multiple deployments.",
          );
        const next = value.pagination?.next;
        if (typeof next !== "number" && typeof next !== "string") break;
        until = String(next);
      }
      return ids.length === 1
        ? { ok: true, value: { deploymentId: ids[0] } }
        : { ok: true, value: {} };
    },
    async createShareLink(deploymentId, ttlSeconds, signal) {
      if (!validDeploymentId(deploymentId))
        return transportError(
          "provider_rejected",
          "Vercel deployment id is invalid.",
        );
      const result = await request(
        `/aliases/${encodeURIComponent(deploymentId)}/protection-bypass`,
        "PATCH",
        { ttl: ttlSeconds },
        true,
        signal,
      );
      if (!result.ok) return result;
      const secret = result.value;
      const deploymentUrl = deploymentUrls.get(deploymentId);
      if (
        typeof secret !== "string" ||
        secret.length < 12 ||
        secret.length > 512 ||
        !deploymentUrl
      )
        return transportError(
          "provider_rejected",
          "Vercel share capability response is invalid.",
        );
      const url = new URL(`https://${deploymentUrl}/`);
      url.searchParams.set("_vercel_share", secret);
      return { ok: true, value: { url: url.href, secret } };
    },
    async status(deploymentId, signal) {
      if (!validDeploymentId(deploymentId))
        return transportError(
          "provider_rejected",
          "Vercel deployment id is invalid.",
        );
      const result = await request(
        `/v13/deployments/${encodeURIComponent(deploymentId)}`,
        "GET",
        undefined,
        false,
        signal,
      );
      if (!result.ok) return result;
      const readyState = String(
        (result.value as { readyState?: unknown }).readyState ?? "UNKNOWN",
      );
      return {
        ok: true,
        value: {
          state:
            readyState === "READY"
              ? "active"
              : readyState === "CANCELED"
                ? "revoked"
                : readyState === "ERROR"
                  ? "unknown"
                  : "unknown",
        },
      };
    },
    async revokeShareLink(deploymentId, secret, signal) {
      const result = await request(
        `/aliases/${encodeURIComponent(deploymentId)}/protection-bypass`,
        "PATCH",
        { revoke: { secret } },
        true,
        signal,
      );
      return result.ok || result.error.message.includes("HTTP 404")
        ? { ok: true, value: undefined }
        : result;
    },
    async deleteDeployment(deploymentId, signal) {
      const result = await request(
        `/v13/deployments/${encodeURIComponent(deploymentId)}`,
        "DELETE",
        undefined,
        true,
        signal,
      );
      return result.ok || result.error.message.includes("HTTP 404")
        ? { ok: true, value: undefined }
        : result;
    },
  };
}

export type { VercelFile };
