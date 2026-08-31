import { createHash } from "node:crypto";
import type { SensitivityFinding, SensitivityReport } from "./model.ts";

const SCANNER_VERSION = "phase-9-v1";
const rules = [
  {
    id: "private-key",
    severity: "block" as const,
    pattern: /-----BEGIN (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----/g,
  },
  {
    id: "credential-assignment",
    severity: "block" as const,
    pattern:
      /\b(?:api[_-]?key|access[_-]?token|refresh[_-]?token|client[_-]?secret|password)\s*[:=]\s*["']?[A-Za-z0-9_\-/.+=]{12,}/gi,
  },
  {
    id: "authorization-header",
    severity: "block" as const,
    pattern: /\bAuthorization\s*:\s*(?:Bearer|Basic)\s+[^\s]+/gi,
  },
  {
    id: "cloud-or-source-token",
    severity: "block" as const,
    pattern:
      /\b(?:AKIA[0-9A-Z]{16}|github_pat_[A-Za-z0-9_]{20,}|gh[pousr]_[A-Za-z0-9]{20,}|glpat-[A-Za-z0-9_-]{20,}|eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,})\b/g,
  },
  {
    id: "credential-uri",
    severity: "block" as const,
    pattern: /\b[a-z][a-z0-9+.-]*:\/\/[^\s/:@]+:[^\s/@]+@/gi,
  },
  {
    id: "local-path",
    severity: "review" as const,
    pattern:
      /(?:\b[A-Za-z]:[\\/][^\s"'<>]+|(?<!https:)(?<!http:)(?<!file:)(?<!\/)\/(?!\/)[^\s"'<>/]+(?:\/[^\s"'<>/]+)+|\\\\[^\\\s]+\\[^\s"'<>]+)/gu,
  },
] as const;

export function scanArtifactSensitivity(
  body: Uint8Array,
  exactCanaries: readonly string[] = [],
): SensitivityReport {
  const text = Buffer.from(body).toString("utf8");
  const findings: SensitivityFinding[] = [];
  const canaryCount = [...new Set(exactCanaries)]
    .filter(
      (canary) =>
        typeof canary === "string" &&
        canary.length >= 8 &&
        Buffer.byteLength(canary) <= 64 * 1024,
    )
    .slice(0, 32)
    .reduce(
      (count, canary) => count + Math.max(0, text.split(canary).length - 1),
      0,
    );
  if (canaryCount > 0)
    findings.push({
      ruleId: "known-credential",
      severity: "block",
      count: canaryCount,
    });
  for (const rule of rules) {
    const count = [
      ...text.matchAll(new RegExp(rule.pattern.source, rule.pattern.flags)),
    ].length;
    if (count > 0)
      findings.push({ ruleId: rule.id, severity: rule.severity, count });
  }
  const verdict = findings.some(({ severity }) => severity === "block")
    ? "blocked"
    : findings.length > 0
      ? "review"
      : "clear";
  const digest = createHash("sha256")
    .update(SCANNER_VERSION)
    .update("\0")
    .update(JSON.stringify(findings))
    .digest("hex");
  return { verdict, scannerVersion: SCANNER_VERSION, digest, findings };
}
