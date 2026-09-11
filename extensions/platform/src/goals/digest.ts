/**
 * Domain-separated SHA-256 digests over canonical JSON (object keys sorted,
 * keys with `undefined` values dropped, array order kept).
 *
 * Source of command digests (`authority.ts`), node and revision digests
 * (`validation.ts`), evidence IDs (`evidence.ts`), and Attempt, event, and
 * delivery keys (`engine.ts`); `persistence.ts` canonicalizes transaction
 * payloads with it. Changing the encoding or a domain string silently changes
 * identities already stored, so a retried request would no longer match its
 * recorded command digest.
 * See: docs/security/phase-8-threat-model.md (Graph or transition corruption)
 */

import { createHash } from "node:crypto";

/** Key-order independent encoding so digests depend on meaning, not typing order. */
export function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (!value || typeof value !== "object") return value;
  const record = value as Record<string, unknown>;
  return Object.fromEntries(
    Object.keys(record)
      .sort()
      .filter((key) => record[key] !== undefined)
      .map((key) => [key, canonicalize(record[key])]),
  );
}

export function digestOf(domain: string, value: unknown) {
  return createHash("sha256")
    .update(domain)
    .update("\0")
    .update(JSON.stringify(canonicalize(value)) ?? "null")
    .digest("hex");
}

export function digestOfText(domain: string, ...parts: readonly string[]) {
  const hash = createHash("sha256").update(domain);
  for (const part of parts) hash.update("\0").update(part);
  return hash.digest("hex");
}
