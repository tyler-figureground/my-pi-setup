import { createHash } from "node:crypto";
import path from "node:path";
import type {
  ReviewCandidateOutput,
  ReviewCapture,
  ReviewCategory,
  ReviewConfidence,
  ReviewEvidence,
  ReviewFinding,
  ReviewSeverity,
} from "./index.ts";

const severities = new Set<ReviewSeverity>([
  "blocker",
  "high",
  "medium",
  "low",
]);
const confidences = new Set<ReviewConfidence>(["high", "medium", "low"]);
const categories = new Set<ReviewCategory>([
  "correctness",
  "security",
  "reliability",
  "performance",
  "tests",
  "maintainability",
]);
const candidateKeys = new Set([
  "severity",
  "confidence",
  "category",
  "file",
  "range",
  "summary",
  "failureScenario",
  "evidence",
]);
const rangeKeys = new Set(["side", "startLine", "endLine"]);
const severityRank: Record<ReviewSeverity, number> = {
  blocker: 4,
  high: 3,
  medium: 2,
  low: 1,
};
const confidenceRank: Record<ReviewConfidence, number> = {
  high: 3,
  medium: 2,
  low: 1,
};

interface ValidationResult {
  readonly findings: readonly ReviewFinding[];
  readonly rejected: readonly {
    readonly index: number;
    readonly reason: string;
  }[];
}

function plainObject(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function exactKeys(value: Record<string, unknown>, keys: ReadonlySet<string>) {
  return (
    Object.keys(value).every((key) => keys.has(key)) &&
    [...keys].every((key) => Object.hasOwn(value, key))
  );
}

function boundedText(value: unknown, max: number) {
  if (typeof value !== "string") return undefined;
  const text = value.trim().replace(/\s+/g, " ");
  if (
    !text ||
    Buffer.byteLength(text) > max ||
    /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(text)
  )
    return undefined;
  return text;
}

function canonicalReviewPath(value: unknown) {
  if (typeof value !== "string" || !value || value.includes("\0"))
    return undefined;
  const slash = value.replaceAll("\\", "/");
  if (path.posix.isAbsolute(slash) || /^[A-Za-z]:\//.test(slash))
    return undefined;
  const normalized = path.posix.normalize(slash);
  if (normalized === ".." || normalized.startsWith("../") || normalized === ".")
    return undefined;
  return normalized;
}

function overlap(
  left: { startLine: number; endLine: number },
  right: { startLine: number; endLine: number },
) {
  return left.startLine <= right.endLine && right.startLine <= left.endLine;
}

function parseCandidate(
  value: unknown,
  capture: ReviewCapture,
  evidenceIds: ReadonlySet<string>,
): Omit<ReviewFinding, "id"> | string {
  if (!plainObject(value) || !exactKeys(value, candidateKeys))
    return "Candidate must contain the exact finding schema.";
  if (!severities.has(value.severity as ReviewSeverity))
    return "Invalid severity.";
  if (!confidences.has(value.confidence as ReviewConfidence))
    return "Invalid confidence.";
  if (!categories.has(value.category as ReviewCategory))
    return "Invalid category.";
  const file = canonicalReviewPath(value.file);
  if (!file) return "Invalid finding path.";
  const captured = capture.files.find(
    (entry) => entry.path.replaceAll("\\", "/") === file,
  );
  if (!captured)
    return "Finding path was not part of the captured review target.";
  if (!plainObject(value.range) || !exactKeys(value.range, rangeKeys))
    return "Invalid finding range.";
  const side = value.range.side;
  const startLine = value.range.startLine;
  const endLine = value.range.endLine;
  if (
    (side !== "base" &&
      side !== "index" &&
      side !== "worktree" &&
      side !== "target") ||
    !Number.isSafeInteger(startLine) ||
    !Number.isSafeInteger(endLine) ||
    (startLine as number) < 1 ||
    (endLine as number) < (startLine as number)
  )
    return "Invalid finding range.";
  const lineCount =
    side === "base"
      ? captured.baseLineCount
      : side === "index"
        ? (captured.indexLineCount ?? captured.targetLineCount)
        : side === "worktree"
          ? (captured.worktreeLineCount ?? captured.targetLineCount)
          : captured.targetLineCount;
  if ((endLine as number) > lineCount)
    return "Finding range is outside the captured file.";
  if (
    !captured.changed.some(
      (changed) =>
        changed.side === side &&
        overlap(changed, {
          startLine: startLine as number,
          endLine: endLine as number,
        }),
    )
  )
    return "Finding range does not intersect the reviewed diff.";
  const summary = boundedText(value.summary, 500);
  const failureScenario = boundedText(value.failureScenario, 1_000);
  if (!summary || !failureScenario)
    return "Finding text is missing or oversized.";
  if (
    !Array.isArray(value.evidence) ||
    value.evidence.length < 1 ||
    value.evidence.length > 16
  )
    return "Finding evidence must be a non-empty bounded array.";
  const evidence = value.evidence.map((item) => boundedText(item, 300));
  if (evidence.some((item) => item === undefined || !evidenceIds.has(item)))
    return "Finding evidence does not resolve to captured evidence.";
  return {
    severity: value.severity as ReviewSeverity,
    confidence: value.confidence as ReviewConfidence,
    category: value.category as ReviewCategory,
    file,
    range: { side, startLine: startLine as number, endLine: endLine as number },
    summary,
    failureScenario,
    evidence: [...new Set(evidence as string[])].sort(),
  };
}

function fingerprintText(value: string) {
  return value
    .toLocaleLowerCase("en-US")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function mergeable(
  left: Omit<ReviewFinding, "id">,
  right: Omit<ReviewFinding, "id">,
) {
  return (
    left.file === right.file &&
    left.category === right.category &&
    left.range.side === right.range.side &&
    overlap(left.range, right.range) &&
    fingerprintText(left.failureScenario) ===
      fingerprintText(right.failureScenario)
  );
}

function pickHighest<T extends string>(
  values: readonly T[],
  rank: Readonly<Record<T, number>>,
) {
  return [...values].sort(
    (left, right) => rank[right]! - rank[left]! || left.localeCompare(right),
  )[0]!;
}

function withId(finding: Omit<ReviewFinding, "id">): ReviewFinding {
  const id = createHash("sha256").update(JSON.stringify(finding)).digest("hex");
  return { id, ...finding };
}

function mergeGroup(group: readonly Omit<ReviewFinding, "id">[]) {
  const summaries = group.map((finding) => finding.summary).sort();
  const scenarios = group.map((finding) => finding.failureScenario).sort();
  return withId({
    severity: pickHighest(
      group.map((finding) => finding.severity),
      severityRank,
    ),
    confidence: pickHighest(
      group.map((finding) => finding.confidence),
      confidenceRank,
    ),
    category: group[0]!.category,
    file: group[0]!.file,
    range: {
      side: group[0]!.range.side,
      startLine: Math.min(...group.map((finding) => finding.range.startLine)),
      endLine: Math.max(...group.map((finding) => finding.range.endLine)),
    },
    summary: summaries[0]!,
    failureScenario: scenarios[0]!,
    evidence: [...new Set(group.flatMap((finding) => finding.evidence))].sort(),
  });
}

export function validateAndDeduplicateFindings(
  output: ReviewCandidateOutput,
  capture: ReviewCapture,
  evidence: readonly ReviewEvidence[],
): ValidationResult {
  if (output.candidates.length > 100) {
    return {
      findings: [],
      rejected: [{ index: 100, reason: "Candidate count exceeds 100." }],
    };
  }
  const accepted: Array<Omit<ReviewFinding, "id">> = [];
  const rejected: Array<{ index: number; reason: string }> = [];
  const evidenceIds = new Set(evidence.map(({ id }) => id));
  output.candidates.forEach((candidate, index) => {
    const parsed = parseCandidate(candidate, capture, evidenceIds);
    if (typeof parsed === "string") rejected.push({ index, reason: parsed });
    else accepted.push(parsed);
  });

  accepted.sort((left, right) =>
    [
      left.file,
      left.category,
      left.range.side,
      left.range.startLine,
      left.range.endLine,
      left.summary,
    ]
      .join("\0")
      .localeCompare(
        [
          right.file,
          right.category,
          right.range.side,
          right.range.startLine,
          right.range.endLine,
          right.summary,
        ].join("\0"),
      ),
  );
  const groups: Array<Array<Omit<ReviewFinding, "id">>> = [];
  for (const finding of accepted) {
    const matching = groups.filter((group) =>
      group.some((prior) => mergeable(prior, finding)),
    );
    if (matching.length === 0) {
      groups.push([finding]);
      continue;
    }
    const first = matching[0]!;
    first.push(finding);
    for (const extra of matching.slice(1)) {
      first.push(...extra);
      groups.splice(groups.indexOf(extra), 1);
    }
  }
  const findings = groups.map(mergeGroup).sort((left, right) => {
    const severity = severityRank[right.severity] - severityRank[left.severity];
    if (severity) return severity;
    return (
      left.file.localeCompare(right.file) ||
      left.range.startLine - right.range.startLine ||
      left.id.localeCompare(right.id)
    );
  });
  return { findings, rejected };
}
