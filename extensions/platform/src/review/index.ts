import type {
  ArtifactMetadata,
  ArtifactStore,
} from "../core/artifacts/index.ts";
import {
  failure,
  success,
  type JsonValue,
  type ModuleError,
  type Outcome,
} from "../core/result.ts";
import { validateAndDeduplicateFindings } from "./findings.ts";

export type ReviewTarget =
  | { readonly kind: "uncommitted" }
  | {
      readonly kind: "base";
      readonly branch?: string;
      readonly remote?: string;
    }
  | { readonly kind: "commit"; readonly revision: string }
  | {
      readonly kind: "range";
      readonly from: string;
      readonly to: string;
      readonly comparison?: "direct" | "merge-base";
    };

export interface ResolvedReviewTarget {
  readonly kind: ReviewTarget["kind"];
  readonly targetId: string;
  readonly head?: string;
  readonly base?: string;
  readonly from?: string;
  readonly to?: string;
}

export interface ReviewChangedRange {
  readonly side: "base" | "index" | "worktree" | "target";
  readonly startLine: number;
  readonly endLine: number;
}

export interface ReviewCapturedFile {
  readonly path: string;
  readonly baseLineCount: number;
  /** Maximum target-side line space across captured index/worktree states. */
  readonly targetLineCount: number;
  readonly indexLineCount?: number;
  readonly worktreeLineCount?: number;
  readonly indexExists?: boolean;
  readonly worktreeExists?: boolean;
  readonly content?: {
    readonly base?: string;
    readonly index?: string;
    readonly worktree?: string;
    readonly target?: string;
    readonly baseBase64?: string;
    readonly indexBase64?: string;
    readonly worktreeBase64?: string;
    readonly targetBase64?: string;
  };
  readonly changed: readonly ReviewChangedRange[];
}

export interface ReviewCapture {
  readonly requested: ReviewTarget;
  readonly resolved: ResolvedReviewTarget;
  readonly projectId: string;
  readonly root: string;
  readonly diff: string;
  readonly files: readonly ReviewCapturedFile[];
  readonly sourceFingerprint: string;
  readonly freshness:
    | {
        readonly kind: "fresh";
        readonly ahead: number;
        readonly behind: number;
      }
    | { readonly kind: "stale" | "unknown"; readonly reason: string }
    | { readonly kind: "not-applicable" };
  readonly capturedAt: number;
}

export type ReviewSeverity = "blocker" | "high" | "medium" | "low";
export type ReviewConfidence = "high" | "medium" | "low";
export type ReviewCategory =
  | "correctness"
  | "security"
  | "reliability"
  | "performance"
  | "tests"
  | "maintainability";

export interface ReviewFinding {
  readonly id: string;
  readonly severity: ReviewSeverity;
  readonly confidence: ReviewConfidence;
  readonly category: ReviewCategory;
  readonly file: string;
  readonly range: ReviewChangedRange;
  readonly summary: string;
  readonly failureScenario: string;
  readonly evidence: readonly string[];
}

export interface ReviewCandidateOutput {
  readonly candidates: readonly unknown[];
  readonly rawOutput: string;
}

export interface ReviewEvidence {
  readonly id: string;
  readonly source: "git" | "lsp" | "tests";
  readonly status: "available" | "unavailable";
  readonly summary: string;
  readonly data?: JsonValue;
}

export interface ReviewEvidenceAdapter {
  readonly source: "lsp" | "tests";
  collect(
    capture: ReviewCapture,
    signal?: AbortSignal,
  ): Promise<ReviewEvidence>;
}

export interface ReviewRequest {
  readonly runId: string;
  readonly capture: ReviewCapture;
  readonly evidence: readonly ReviewEvidence[];
  readonly pass: "primary" | "independent";
  readonly signal?: AbortSignal;
}

export interface ReviewGitAdapter {
  capture(
    target: ReviewTarget,
    options: {
      readonly signal?: AbortSignal;
      readonly allowStaleBase: boolean;
    },
  ): Promise<ReviewCapture>;
  fingerprint(signal?: AbortSignal): Promise<string>;
}

export interface ReviewerAdapter {
  review(request: ReviewRequest): Promise<ReviewCandidateOutput>;
}

export type ReviewProgress =
  "capturing" | "reviewing" | "second-pass" | "validating" | "persisting";

export interface LocalReviewOptions {
  readonly signal?: AbortSignal;
  readonly allowStaleBase?: boolean;
  readonly secondPass?: "independent";
  readonly includeTests?: boolean;
  readonly onProgress?: (progress: ReviewProgress) => void;
}

export interface ReviewReport {
  readonly status: "completed";
  readonly conclusion: "findings" | "no-findings";
  readonly target: ResolvedReviewTarget;
  readonly freshness: ReviewCapture["freshness"];
  readonly findings: readonly ReviewFinding[];
  readonly rejectedFindingCount: number;
  readonly artifact: ArtifactMetadata;
}

export type LocalReviewErrorCode =
  | "cancelled"
  | "target_failed"
  | "reviewer_failed"
  | "invalid_findings"
  | "source_changed_during_review"
  | "artifact_failed";
export type LocalReviewError = ModuleError<LocalReviewErrorCode>;

export interface LocalReview {
  run(
    target: ReviewTarget,
    options: LocalReviewOptions,
  ): Promise<Outcome<ReviewReport, LocalReviewError>>;
}

export interface CreateLocalReviewOptions {
  readonly projectId: string;
  readonly artifacts: ArtifactStore;
  readonly git: ReviewGitAdapter;
  readonly reviewer: ReviewerAdapter;
  readonly secondReviewer?: ReviewerAdapter;
  readonly evidence?: readonly ReviewEvidenceAdapter[];
  readonly clock?: () => number;
  readonly id?: () => string;
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

function cancelled(signal: AbortSignal | undefined) {
  return signal?.aborted === true;
}

function normalizeEvidence(
  source: ReviewEvidenceAdapter["source"],
  value: ReviewEvidence,
): ReviewEvidence {
  if (value.source !== source)
    throw new Error("Review evidence source does not match its adapter.");
  if (!/^[a-z0-9][a-z0-9:._-]{0,99}$/i.test(value.id))
    throw new Error("Review evidence id is invalid.");
  if (
    (value.status !== "available" && value.status !== "unavailable") ||
    !value.summary.trim() ||
    Buffer.byteLength(value.summary) > 2_000 ||
    /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value.summary)
  )
    throw new Error("Review evidence summary is invalid or oversized.");
  const encoded =
    value.data === undefined ? undefined : JSON.stringify(value.data);
  if (encoded !== undefined && Buffer.byteLength(encoded) > 128 * 1024)
    throw new Error("Review evidence data exceeds 131072 bytes.");
  return {
    id: value.id,
    source,
    status: value.status,
    summary: value.summary.trim(),
    ...(encoded === undefined
      ? {}
      : { data: JSON.parse(encoded) as JsonValue }),
  };
}

export function createLocalReview(
  options: CreateLocalReviewOptions,
): LocalReview {
  const clock = options.clock ?? Date.now;
  const id = options.id ?? (() => crypto.randomUUID());

  const persist = async (body: object) =>
    options.artifacts.put({
      body: JSON.stringify(body),
      filename: "local-review.json",
      mediaType: "application/json",
      metadata: { kind: "local-review", version: 1 },
    });

  return {
    async run(target, runOptions) {
      const runId = id();
      const startedAt = clock();
      if (cancelled(runOptions.signal)) {
        return failure({
          code: "cancelled",
          message: "Local review was cancelled before target capture.",
          retryable: true,
        });
      }

      let capture: ReviewCapture;
      runOptions.onProgress?.("capturing");
      try {
        capture = await options.git.capture(target, {
          signal: runOptions.signal,
          allowStaleBase: runOptions.allowStaleBase ?? false,
        });
      } catch (error) {
        return failure({
          code: cancelled(runOptions.signal) ? "cancelled" : "target_failed",
          message: `Could not capture review target: ${errorMessage(error)}`,
          retryable: true,
        });
      }
      if (capture.projectId !== options.projectId) {
        const stored = await persist({
          version: 1,
          runId,
          status: "failed",
          error: "project_identity_mismatch",
          capture,
          startedAt,
          finishedAt: clock(),
        });
        if (!stored.ok)
          return failure({
            code: "artifact_failed",
            message: `Could not persist local review failure: ${stored.error.message}`,
            retryable: stored.error.retryable,
          });
        return failure({
          code: "target_failed",
          message: "Review target belongs to a different project identity.",
          retryable: false,
          details: { artifactId: stored.value.id },
        });
      }

      const evidence: ReviewEvidence[] = [
        {
          id: "git:diff",
          source: "git",
          status: "available",
          summary: `Captured ${capture.files.length} changed file(s) and ${Buffer.byteLength(capture.diff)} diff bytes.`,
        },
      ];
      for (const adapter of options.evidence ?? []) {
        if (adapter.source === "tests" && !runOptions.includeTests) continue;
        try {
          evidence.push(
            normalizeEvidence(
              adapter.source,
              await adapter.collect(capture, runOptions.signal),
            ),
          );
        } catch (error) {
          evidence.push({
            id: `${adapter.source}:unavailable`,
            source: adapter.source,
            status: "unavailable",
            summary: errorMessage(error),
          });
        }
      }

      let reviewerOutput: ReviewCandidateOutput;
      try {
        runOptions.onProgress?.("reviewing");
        const primary = await options.reviewer.review({
          runId,
          capture,
          evidence,
          pass: "primary",
          signal: runOptions.signal,
        });
        if (runOptions.secondPass === "independent") {
          if (!options.secondReviewer)
            throw new Error("Independent second reviewer is not configured.");
          runOptions.onProgress?.("second-pass");
          const second = await options.secondReviewer.review({
            runId,
            capture,
            evidence,
            pass: "independent",
            signal: runOptions.signal,
          });
          reviewerOutput = {
            candidates: [...primary.candidates, ...second.candidates],
            rawOutput: JSON.stringify({
              primary: primary.rawOutput,
              independent: second.rawOutput,
            }),
          };
        } else {
          reviewerOutput = primary;
        }
      } catch (error) {
        let code: LocalReviewErrorCode = cancelled(runOptions.signal)
          ? "cancelled"
          : "reviewer_failed";
        if (code === "reviewer_failed") {
          try {
            if ((await options.git.fingerprint()) !== capture.sourceFingerprint)
              code = "source_changed_during_review";
          } catch {
            code = "target_failed";
          }
        }
        const stored = await persist({
          version: 1,
          runId,
          status: code === "cancelled" ? "cancelled" : "failed",
          error: errorMessage(error),
          capture,
          evidence,
          startedAt,
          finishedAt: clock(),
        });
        if (!stored.ok)
          return failure({
            code: "artifact_failed",
            message: `Could not persist local review failure: ${stored.error.message}`,
            retryable: stored.error.retryable,
          });
        return failure({
          code,
          message:
            code === "cancelled"
              ? "Local review was cancelled."
              : code === "source_changed_during_review"
                ? "Source tree or index changed while the reviewer failed."
                : code === "target_failed"
                  ? "Could not verify source immutability after reviewer failure."
                  : `Reviewer failed: ${errorMessage(error)}`,
          retryable: true,
          details: { artifactId: stored.value.id },
        });
      }

      let currentFingerprint: string;
      try {
        currentFingerprint = await options.git.fingerprint(runOptions.signal);
      } catch (error) {
        const code = cancelled(runOptions.signal)
          ? "cancelled"
          : "target_failed";
        const stored = await persist({
          version: 1,
          runId,
          status: code === "cancelled" ? "cancelled" : "failed",
          error: errorMessage(error),
          capture,
          reviewer: reviewerOutput,
          evidence,
          startedAt,
          finishedAt: clock(),
        });
        if (!stored.ok)
          return failure({
            code: "artifact_failed",
            message: `Could not persist local review failure: ${stored.error.message}`,
            retryable: stored.error.retryable,
          });
        return failure({
          code,
          message:
            code === "cancelled"
              ? "Local review was cancelled."
              : `Could not verify source immutability: ${errorMessage(error)}`,
          retryable: true,
          details: { artifactId: stored.value.id },
        });
      }
      if (currentFingerprint !== capture.sourceFingerprint) {
        const stored = await persist({
          version: 1,
          runId,
          status: "failed",
          error: "source_changed_during_review",
          capture,
          reviewer: reviewerOutput,
          evidence,
          startedAt,
          finishedAt: clock(),
        });
        if (!stored.ok)
          return failure({
            code: "artifact_failed",
            message: `Could not persist local review failure: ${stored.error.message}`,
            retryable: stored.error.retryable,
          });
        return failure({
          code: "source_changed_during_review",
          message: "Source tree or index changed during local review.",
          retryable: true,
          details: { artifactId: stored.value.id },
        });
      }

      runOptions.onProgress?.("validating");
      const validated = validateAndDeduplicateFindings(
        reviewerOutput,
        capture,
        evidence,
      );
      if (
        reviewerOutput.candidates.length > 0 &&
        validated.findings.length === 0
      ) {
        const stored = await persist({
          version: 1,
          runId,
          status: "failed",
          error: "invalid_findings",
          capture,
          reviewer: reviewerOutput,
          evidence,
          rejectedFindings: validated.rejected,
          startedAt,
          finishedAt: clock(),
        });
        if (!stored.ok)
          return failure({
            code: "artifact_failed",
            message: `Could not persist local review failure: ${stored.error.message}`,
            retryable: stored.error.retryable,
          });
        return failure({
          code: "invalid_findings",
          message:
            "Reviewer returned findings, but none matched the captured review target.",
          retryable: false,
          details: {
            rejectedFindingCount: validated.rejected.length,
            artifactId: stored.value.id,
          },
        });
      }
      const findings = validated.findings;
      const conclusion = findings.length > 0 ? "findings" : "no-findings";
      runOptions.onProgress?.("persisting");
      const stored = await persist({
        version: 1,
        runId,
        status: "result",
        conclusion,
        capture,
        reviewer: reviewerOutput,
        evidence,
        findings,
        rejectedFindings: validated.rejected,
        startedAt,
        finishedAt: clock(),
      });
      if (!stored.ok) {
        return failure({
          code: "artifact_failed",
          message: `Could not persist local review artifact: ${stored.error.message}`,
          retryable: stored.error.retryable,
        });
      }
      let finalFingerprint: string;
      try {
        finalFingerprint = await options.git.fingerprint(runOptions.signal);
      } catch (error) {
        return failure({
          code: cancelled(runOptions.signal) ? "cancelled" : "target_failed",
          message: cancelled(runOptions.signal)
            ? "Local review was cancelled."
            : `Could not verify source after artifact persistence: ${errorMessage(error)}`,
          retryable: true,
          details: { artifactId: stored.value.id },
        });
      }
      if (finalFingerprint !== capture.sourceFingerprint) {
        const failureArtifact = await persist({
          version: 1,
          runId,
          status: "failed",
          error: "source_changed_during_persistence",
          completedArtifactId: stored.value.id,
          capture,
          reviewer: reviewerOutput,
          evidence,
          startedAt,
          finishedAt: clock(),
        });
        if (!failureArtifact.ok)
          return failure({
            code: "artifact_failed",
            message: `Source changed and failure artifact persistence failed: ${failureArtifact.error.message}`,
            retryable: failureArtifact.error.retryable,
            details: { completedArtifactId: stored.value.id },
          });
        return failure({
          code: "source_changed_during_review",
          message: "Source tree or index changed during artifact persistence.",
          retryable: true,
          details: { artifactId: failureArtifact.value.id },
        });
      }
      return success({
        status: "completed",
        conclusion,
        target: capture.resolved,
        freshness: capture.freshness,
        findings,
        rejectedFindingCount: validated.rejected.length,
        artifact: stored.value,
      });
    },
  };
}
