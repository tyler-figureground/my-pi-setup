import { isIP } from "node:net";
import { lookup } from "node:dns/promises";
import {
  createCapabilityPolicy,
  type ActorRole,
  type CapabilityPolicy,
  type OperationKind,
} from "../core/policy/index.ts";

export type ExternalIntegration = "mcp" | "browser";
export type ExternalEffect = OperationKind;

export interface ExternalDestination {
  readonly url: string;
  readonly allowedOrigins: readonly string[];
  readonly allowLoopback: boolean;
}

export interface ExternalOperationRequest {
  readonly integration: ExternalIntegration;
  readonly operation: string;
  readonly effect: ExternalEffect;
  readonly actor: ActorRole;
  readonly mode: "normal" | "plan";
  readonly destination?: ExternalDestination;
}

export type ExternalControlReasonCode =
  | "allowed"
  | "invalid-destination"
  | "origin-not-allowed"
  | "private-network-target"
  | "offline"
  | "policy-denied"
  | "approval-required";

export interface ExternalControlDecision {
  readonly kind: "allow" | "deny" | "require-user-confirmation";
  readonly reasonCode: ExternalControlReasonCode;
  readonly reason: string;
  readonly canonicalUrl?: string;
}

export interface SanitizedExternalData {
  readonly value: unknown;
  readonly redactions: number;
  readonly truncations: number;
}

export interface ExternalUserAuthorityToken {
  readonly kind: "external-user-authority";
  readonly value: string;
}

export interface ExternalIntegrationControls {
  assess(
    request: ExternalOperationRequest,
    authority?: ExternalUserAuthorityToken,
  ): Promise<ExternalControlDecision>;
  sanitize(value: unknown): SanitizedExternalData;
}

export interface ExternalIntegrationControlOptions {
  readonly resolveHost?: (hostname: string) => Promise<readonly string[]>;
  readonly offline?: () => boolean;
  readonly policy?: CapabilityPolicy;
  readonly authority?: {
    verify(token: ExternalUserAuthorityToken): boolean;
  };
}

function ipv4Octets(address: string) {
  const values = address.split(".").map(Number);
  return values.length === 4 && values.every((value) => Number.isInteger(value))
    ? values
    : undefined;
}

function isLoopback(address: string) {
  if (address === "::1") return true;
  const octets = ipv4Octets(address);
  return octets?.[0] === 127;
}

function mappedIpv4(address: string) {
  const match = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(address);
  return match?.[1];
}

function isPrivateNetwork(address: string) {
  const normalized = address.toLowerCase().split("%")[0]!;
  const mapped = mappedIpv4(normalized);
  if (mapped) return isPrivateNetwork(mapped);
  if (isIP(normalized) === 6) {
    return (
      normalized === "::" ||
      normalized === "::1" ||
      normalized.startsWith("fc") ||
      normalized.startsWith("fd") ||
      /^fe[89ab]/.test(normalized) ||
      normalized.startsWith("ff")
    );
  }
  const octets = ipv4Octets(normalized);
  if (!octets) return true;
  const [a, b] = octets;
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 100 && b! >= 64 && b! <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b! >= 16 && b! <= 31) ||
    (a === 192 && b === 168) ||
    (a === 198 && (b === 18 || b === 19)) ||
    a! >= 224
  );
}

function canonicalHttpUrl(raw: string) {
  if (!raw || Buffer.byteLength(raw) > 8_192 || raw.includes("\0"))
    throw new Error("Destination URL is invalid.");
  const url = new URL(raw);
  if (url.protocol !== "http:" && url.protocol !== "https:")
    throw new Error("Destination must use HTTP or HTTPS.");
  if (url.username || url.password)
    throw new Error("Destination URL cannot contain credentials.");
  url.hash = "";
  return url;
}

function canonicalAllowedOrigins(origins: readonly string[]) {
  if (origins.length > 256) throw new Error("Origin allowlist is too large.");
  return new Set(
    origins.map((origin) => {
      if (Buffer.byteLength(origin) > 2_048)
        throw new Error("Allowed origin is too large.");
      const url = canonicalHttpUrl(origin);
      if (url.pathname !== "/" || url.search)
        throw new Error("Allowed destinations must be origins, not URLs.");
      return url.origin;
    }),
  );
}

async function defaultResolveHost(hostname: string) {
  const records = await lookup(hostname, { all: true, verbatim: true });
  return records.map(({ address }) => address);
}

function deny(reasonCode: ExternalControlReasonCode, reason: string) {
  return { kind: "deny", reasonCode, reason } as const;
}

const secretField =
  /^(?:authorization|proxy-authorization|cookie|set-cookie|password|passwd|secret|client_secret|access_token|refresh_token|id_token|bearerToken|oauth_code|authorization_code|code_verifier)$/i;
const secretQueryField =
  /^(?:code|token|access_token|refresh_token|id_token|client_secret|code_verifier)$/i;

function sanitizeUrl(value: string) {
  try {
    const url = new URL(value);
    if (url.protocol !== "http:" && url.protocol !== "https:") return undefined;
    let redactions = 0;
    if (url.username) {
      url.username = "[REDACTED]";
      redactions += 1;
    }
    if (url.password) {
      url.password = "[REDACTED]";
      redactions += 1;
    }
    for (const key of [...url.searchParams.keys()]) {
      if (!secretQueryField.test(key)) continue;
      url.searchParams.set(key, "[REDACTED]");
      redactions += 1;
    }
    return redactions > 0 ? { value: url.href, redactions } : undefined;
  } catch {
    return undefined;
  }
}

function sanitizeExternalData(input: unknown): SanitizedExternalData {
  let redactions = 0;
  let truncations = 0;
  let nodes = 0;
  const ancestors = new Set<object>();
  const visit = (value: unknown, depth: number, field?: string): unknown => {
    nodes += 1;
    if (nodes > 10_000 || depth > 16) {
      truncations += 1;
      return "[TRUNCATED]";
    }
    if (field && secretField.test(field)) {
      redactions += 1;
      return "[REDACTED]";
    }
    if (typeof value === "string") {
      const url = sanitizeUrl(value);
      if (url) {
        redactions += url.redactions;
        return url.value;
      }
      if (Buffer.byteLength(value) <= 64 * 1024)
        return value.replace(
          /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g,
          "",
        );
      truncations += 1;
      return `${Buffer.from(value)
        .subarray(0, 64 * 1024)
        .toString("utf8")}[TRUNCATED]`;
    }
    if (
      value === null ||
      typeof value === "boolean" ||
      typeof value === "number"
    )
      return Number.isFinite(value) || typeof value !== "number" ? value : null;
    if (typeof value === "bigint") return value.toString();
    if (typeof value !== "object") return String(value);
    if (ancestors.has(value)) {
      truncations += 1;
      return "[CYCLE]";
    }
    ancestors.add(value);
    let result: unknown;
    if (Array.isArray(value)) {
      const bounded = value
        .slice(0, 1_000)
        .map((item) => visit(item, depth + 1));
      if (value.length > bounded.length) {
        truncations += 1;
        bounded.push("[TRUNCATED]");
      }
      result = bounded;
    } else {
      const entries = Object.entries(value as Record<string, unknown>).slice(
        0,
        1_000,
      );
      if (Object.keys(value).length > entries.length) truncations += 1;
      result = Object.fromEntries(
        entries.map(([key, item]) => [key, visit(item, depth + 1, key)]),
      );
    }
    ancestors.delete(value);
    return result;
  };
  return { value: visit(input, 0), redactions, truncations };
}

export function createExternalIntegrationControls(
  options: ExternalIntegrationControlOptions = {},
): ExternalIntegrationControls {
  const resolveHost = options.resolveHost ?? defaultResolveHost;
  const offline =
    options.offline ??
    (() => {
      const value = process.env.PI_OFFLINE?.trim().toLowerCase();
      return value === "1" || value === "true" || value === "yes";
    });
  const policy = options.policy ?? createCapabilityPolicy();
  return {
    sanitize: sanitizeExternalData,
    async assess(request, authority) {
      const policyDecision = policy.decide(
        { kind: "operation", name: request.effect },
        request.actor,
        { kind: request.mode },
      );
      if (policyDecision.kind === "deny")
        return deny("policy-denied", policyDecision.reason);
      const requiresAuthority =
        policyDecision.kind === "require-user-confirmation";
      let authorized = false;
      if (requiresAuthority && authority && options.authority) {
        try {
          authorized = options.authority.verify(authority);
        } catch {
          authorized = false;
        }
      }
      if (requiresAuthority && !authorized)
        return {
          kind: "require-user-confirmation",
          reasonCode: "approval-required",
          reason: "External side effect requires direct user authority.",
        };
      if (request.destination && offline())
        return deny(
          "offline",
          "External network operations are disabled while Pi is offline.",
        );
      if (!request.destination)
        return {
          kind: "allow",
          reasonCode: "allowed",
          reason: "Operation has no network destination.",
        };
      let url: URL;
      let allowedOrigins: Set<string>;
      try {
        url = canonicalHttpUrl(request.destination.url);
        allowedOrigins = canonicalAllowedOrigins(
          request.destination.allowedOrigins,
        );
      } catch (error) {
        return deny(
          "invalid-destination",
          error instanceof Error ? error.message : String(error),
        );
      }
      if (!allowedOrigins.has(url.origin))
        return deny(
          "origin-not-allowed",
          `Origin ${url.origin} is not configured for this integration.`,
        );

      let addresses: readonly string[];
      try {
        addresses = isIP(url.hostname)
          ? [url.hostname]
          : await resolveHost(url.hostname);
      } catch {
        return deny(
          "invalid-destination",
          "Destination host could not be resolved safely.",
        );
      }
      if (addresses.length === 0)
        return deny(
          "invalid-destination",
          "Destination host resolved to no addresses.",
        );
      const blocked = addresses.find(
        (address) =>
          isPrivateNetwork(address) &&
          !(request.destination!.allowLoopback && isLoopback(address)),
      );
      if (blocked)
        return deny(
          "private-network-target",
          "Destination resolves to a private, link-local, or metadata network target.",
        );
      return {
        kind: "allow",
        reasonCode: "allowed",
        reason: "Destination origin and resolved addresses are allowed.",
        canonicalUrl: url.href,
      };
    },
  };
}
