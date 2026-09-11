/**
 * Heuristic secret detector for Plan Mode's read-only Git tool output.
 *
 * Pure regex checks, no I/O. Its only caller, `wiring/plan.ts`, keeps a
 * truncated git spill directory on disk only when this finds nothing.
 *
 * See: docs/architecture/phase-2-policy-rules-hooks.md
 */

const assignment =
  /\b(?:authorization|cookie|password|passwd|secret|token|api[-_]?key|client[-_]?secret)\b\s*[:=]\s*[^\s,;]+/i;
const bearer = /\bbearer\s+[a-z0-9._~+\-/]+=*/i;
const knownToken =
  /\b(?:sk-[a-z0-9_-]{16,}|gh[pousr]_[a-z0-9]{20,}|AKIA[0-9A-Z]{16})\b/i;
const privateKey = /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/;

/**
 * True when `value` looks like it carries a credential: a secret-named
 * `key=value`/`key: value`, a bearer token, a well-known token prefix, or a
 * PEM private key header. Heuristic only - `false` does not prove it safe.
 */
export function containsLikelySecret(value: string) {
  return (
    assignment.test(value) ||
    bearer.test(value) ||
    knownToken.test(value) ||
    privateKey.test(value)
  );
}
