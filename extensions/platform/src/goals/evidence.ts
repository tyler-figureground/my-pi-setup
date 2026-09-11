/**
 * Pure Goal Evidence helpers: `evaluateCriteria` (the completion gate),
 * deterministic evidence IDs, and bounded retention.
 *
 * Trust is stamped by callers, not decided here: `engine.ts` records worker
 * output as `worker-reported` and `GoalReviewPort` verdicts as `host-verified`;
 * `edits.ts` records waivers and manual evidence as `user-accepted`. Only
 * evidence bound to the current definition revision counts.
 * See: docs/architecture/phase-8-goal-mode.md (Evidence gate)
 */

import { digestOfText } from "./digest.ts";
import {
  GOAL_LIMITS,
  type GoalArtifactReference,
  type GoalCriterion,
  type GoalEvidence,
  type GoalEvidenceKind,
  type GoalEvidenceTrust,
} from "./model.ts";

/**
 * The evidence gate.
 *
 * Worker output is an Artifact, never a completion claim. A criterion is met
 * only by evidence of an accepted kind, at or above the required trust, bound
 * to the current definition revision, in at least the required count. Editing
 * the Goal therefore invalidates conclusions drawn from the old revision.
 */

const TRUST_RANK: Readonly<Record<GoalEvidenceTrust, number>> = Object.freeze({
  "worker-reported": 0,
  "host-verified": 1,
  "user-accepted": 2,
});

export function evidenceTrustRank(trust: GoalEvidenceTrust) {
  return TRUST_RANK[trust];
}

export type GoalCriterionGap =
  | "missing_evidence"
  | "stale_revision"
  | "insufficient_trust"
  | "insufficient_count";

export interface GoalCriteriaEvaluation {
  readonly satisfied: boolean;
  readonly unmet: readonly {
    readonly criterionId: string;
    readonly reason: GoalCriterionGap;
  }[];
}

/**
 * Per criterion, reports the first gap in this order: no evidence of an
 * accepted kind, none at `definitionRevision`, none at `minimumTrust`, then
 * fewer distinct entries than `minimumEvidenceCount`.
 */
export function evaluateCriteria(
  criteria: readonly GoalCriterion[],
  evidence: readonly GoalEvidence[],
  definitionRevision: number,
): GoalCriteriaEvaluation {
  const unmet: { criterionId: string; reason: GoalCriterionGap }[] = [];
  for (const criterion of criteria) {
    const candidates = evidence.filter(
      (entry) =>
        entry.criterionId === criterion.id &&
        criterion.acceptedEvidenceKinds.includes(entry.kind),
    );
    if (candidates.length === 0) {
      unmet.push({ criterionId: criterion.id, reason: "missing_evidence" });
      continue;
    }
    const current = candidates.filter(
      (entry) => entry.definitionRevision === definitionRevision,
    );
    if (current.length === 0) {
      unmet.push({ criterionId: criterion.id, reason: "stale_revision" });
      continue;
    }
    const trusted = new Map<string, GoalEvidence>();
    for (const entry of current) {
      if (
        evidenceTrustRank(entry.trust) >=
        evidenceTrustRank(criterion.minimumTrust)
      )
        trusted.set(entry.id, entry);
    }
    if (trusted.size === 0) {
      unmet.push({ criterionId: criterion.id, reason: "insufficient_trust" });
      continue;
    }
    if (trusted.size < criterion.minimumEvidenceCount)
      unmet.push({ criterionId: criterion.id, reason: "insufficient_count" });
  }
  return { satisfied: unmet.length === 0, unmet };
}

/** Bounded, identifier-keyed retention. Newest entries win and oldest fall off. */
export function appendEvidence(
  existing: readonly GoalEvidence[],
  entry: GoalEvidence,
  limit = GOAL_LIMITS.maxEvidencePerNode,
): readonly GoalEvidence[] {
  const kept = existing.filter((candidate) => candidate.id !== entry.id);
  return [...kept, entry].slice(-limit);
}

/**
 * Deterministic: identical inputs give the same ID, so `appendEvidence`
 * replaces a re-recorded entry instead of duplicating it.
 */
export function evidenceId(
  scope: "goal" | "node",
  nodeId: string | null,
  criterionId: string,
  kind: GoalEvidenceKind,
  discriminator: string,
) {
  return digestOfText(
    "goal-evidence-v1",
    scope,
    nodeId ?? "-",
    criterionId,
    kind,
    discriminator,
  );
}

export interface GoalEvidenceDraft {
  readonly scope: "goal" | "node";
  readonly nodeId: string | null;
  readonly criterionId: string;
  readonly kind: GoalEvidenceKind;
  readonly trust: GoalEvidenceTrust;
  readonly summary: string;
  readonly attemptNumber: number | null;
  readonly definitionRevision: number;
  readonly artifact?: GoalArtifactReference | null;
  readonly discriminator: string;
  readonly recordedAt: number;
}

export function createEvidence(draft: GoalEvidenceDraft): GoalEvidence {
  return {
    id: evidenceId(
      draft.scope,
      draft.nodeId,
      draft.criterionId,
      draft.kind,
      draft.discriminator,
    ),
    kind: draft.kind,
    trust: draft.trust,
    criterionId: draft.criterionId,
    scope: draft.scope,
    nodeId: draft.nodeId,
    attemptNumber: draft.attemptNumber,
    definitionRevision: draft.definitionRevision,
    summary: draft.summary.slice(0, GOAL_LIMITS.maxDescriptionLength),
    artifact: draft.artifact ?? null,
    recordedAt: draft.recordedAt,
  };
}
