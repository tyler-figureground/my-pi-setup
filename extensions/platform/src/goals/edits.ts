import type { JsonObject } from "../core/result.ts";
import {
  appendEvidence,
  createEvidence,
  evaluateCriteria,
} from "./evidence.ts";
import {
  GOAL_DISPOSITIONS,
  GOAL_EVIDENCE_KINDS,
  GOAL_LIMITS,
  type GoalActor,
  type GoalArtifactReference,
  type GoalEdit,
  type GoalEvidence,
  type GoalHistoryEntry,
  type GoalOutcome,
} from "./model.ts";
import type {
  StoredGoalAttempt,
  StoredGoalHead,
  StoredGoalNode,
} from "./persistence.ts";
import {
  attemptResolutionAllowed,
  dispositionNodeState,
  nodeTransitionAllowed,
  resetNodeState,
} from "./transitions.ts";
import {
  goalInvalid,
  goalNodeDigest,
  validateBudget,
  validateCriteria,
  validateGoalGraph,
} from "./validation.ts";

/**
 * Audited edits and manual dispositions.
 *
 * Every accepted edit is a pure transformation of stored records plus an audit
 * entry naming the actor, the reason, and the digests it moved between. An edit
 * that touches the definition bumps the revision, which is what makes evidence
 * gathered under the old definition stale rather than silently reusable.
 */

export interface GoalEditInputs {
  readonly head: StoredGoalHead;
  readonly nodes: readonly StoredGoalNode[];
  readonly attempts: readonly StoredGoalAttempt[];
  readonly actor: GoalActor;
  readonly actorId: string;
  readonly reason: string | null;
  readonly now: number;
  readonly artifactReferences?: ReadonlyMap<string, GoalArtifactReference>;
}

export interface GoalEditEvent {
  readonly label: string;
  readonly type: string;
  readonly metadata: JsonObject;
}

export interface GoalEditResult {
  readonly head: StoredGoalHead;
  readonly nodes: ReadonlyMap<string, StoredGoalNode>;
  readonly attempts: readonly StoredGoalAttempt[];
  readonly events: readonly GoalEditEvent[];
  readonly definitionChanged: boolean;
  readonly invalidated: readonly string[];
}

const DEFINITION_EDITS = new Set([
  "objective",
  "criteria",
  "node-criteria",
  "node-task",
  "node-dependencies",
  "budget",
]);

/**
 * Edits that change what one node is asked to do, or how it is judged.
 *
 * Any result produced under the previous wording answered a different
 * question, so these edits reset the node and everything downstream of it
 * rather than leaving a `done` node standing on evidence for work nobody asked
 * for any more.
 */
const INVALIDATING_EDITS = new Set([
  "node-task",
  "node-criteria",
  "node-dependencies",
]);

function boundedReason(value: unknown): string | null {
  return typeof value === "string" && value.length > 0
    ? value.slice(0, GOAL_LIMITS.maxReasonLength)
    : null;
}

function isText(value: unknown, maximum: number) {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    Buffer.byteLength(value) <= maximum
  );
}

/** Selected nodes plus every node that transitively depends on any of them. */
export function transitiveDependents(
  dependencies: ReadonlyMap<string, readonly string[]>,
  seeds: readonly string[],
  order: readonly string[],
): readonly string[] {
  const affected = new Set(seeds);
  let changed = true;
  while (changed) {
    changed = false;
    for (const [nodeId, dependsOn] of dependencies) {
      if (affected.has(nodeId)) continue;
      if (dependsOn.some((id) => affected.has(id))) {
        affected.add(nodeId);
        changed = true;
      }
    }
  }
  return order.filter((id) => affected.has(id));
}

export function applyGoalEdits(
  inputs: GoalEditInputs,
  edits: readonly GoalEdit[],
  invalidateNode?: string,
): GoalOutcome<GoalEditResult> {
  const nodes = new Map(inputs.nodes.map((node) => [node.nodeId, node]));
  const attempts = new Map(
    inputs.attempts.map((attempt) => [
      `${attempt.nodeId}:${attempt.number}`,
      attempt,
    ]),
  );
  const changedNodes = new Map<string, StoredGoalNode>();
  const changedAttempts = new Map<string, StoredGoalAttempt>();
  const events: GoalEditEvent[] = [];
  const history: GoalHistoryEntry[] = [];
  /** Nodes a person marked `done` by hand, gated once every edit has landed. */
  const attested = new Set<string>();
  /** Nodes whose meaning changed, so their prior results no longer apply. */
  const invalidating = new Set<string>();
  let head = inputs.head;
  let position = head.history.at(-1)?.position ?? 0;

  const definitionChanged = edits.some((edit) =>
    DEFINITION_EDITS.has(edit.kind),
  );
  const revision = definitionChanged
    ? head.definitionRevision + 1
    : head.definitionRevision;

  const audit = (
    type: string,
    reason: string | null,
    details: GoalHistoryEntry["details"],
  ) => {
    position += 1;
    const entry: GoalHistoryEntry = {
      position,
      type,
      actor: inputs.actor,
      actorId: inputs.actorId.slice(0, 512),
      at: inputs.now,
      reason,
      details,
    };
    history.push(entry);
    return entry;
  };

  const readNode = (nodeId: string) =>
    changedNodes.get(nodeId) ?? nodes.get(nodeId);

  let objective = head.objective;
  let criteria = head.criteria;
  let budget = head.budget;
  const definitions = new Map(
    inputs.nodes.map((node) => [node.nodeId, node.definition]),
  );

  for (const edit of edits) {
    if (!edit || typeof edit !== "object") return goalInvalid("invalid_edit");
    if (edit.kind === "objective") {
      if (
        typeof edit.objective !== "string" ||
        edit.objective.length === 0 ||
        edit.objective.length > GOAL_LIMITS.maxObjectiveLength
      )
        return goalInvalid("invalid_objective");
      objective = edit.objective;
      continue;
    }
    if (edit.kind === "criteria") {
      const validated = validateCriteria(edit.criteria, "criteria");
      if (!validated.ok) return validated;
      criteria = validated.value;
      continue;
    }
    if (edit.kind === "budget") {
      const limits = validateBudget(edit.limits);
      if (!limits.ok) return limits;
      const used = {
        calls: budget.consumed.calls + budget.reserved.calls,
        runtimeMs: budget.consumed.runtimeMs + budget.reserved.runtimeMs,
        tokens: budget.consumed.tokens + budget.reserved.tokens,
        costMicros: budget.consumed.costMicros + budget.reserved.costMicros,
      };
      if (
        limits.value.maxAgentCalls < used.calls ||
        limits.value.maxRuntimeMs < used.runtimeMs ||
        (limits.value.maxTokens !== null &&
          limits.value.maxTokens < used.tokens) ||
        (limits.value.maxCostMicros !== null &&
          limits.value.maxCostMicros < used.costMicros)
      )
        return goalInvalid("budget_below_consumed");
      budget = { ...budget, limits: limits.value };
      continue;
    }
    if (edit.kind === "node-criteria") {
      const definition = definitions.get(edit.nodeId);
      if (!definition) return goalInvalid("unknown_node", edit.nodeId);
      const validated = validateCriteria(
        edit.criteria,
        `node-criteria.${edit.nodeId}`,
      );
      if (!validated.ok) return validated;
      const next = { ...definition, criteria: validated.value };
      definitions.set(edit.nodeId, { ...next, digest: goalNodeDigest(next) });
      invalidating.add(edit.nodeId);
      continue;
    }
    if (edit.kind === "node-task") {
      const definition = definitions.get(edit.nodeId);
      if (!definition) return goalInvalid("unknown_node", edit.nodeId);
      if (edit.title === undefined && edit.prompt === undefined)
        return goalInvalid("empty_node_task", edit.nodeId);
      if (
        edit.title !== undefined &&
        !isText(edit.title, GOAL_LIMITS.maxTitleLength)
      )
        return goalInvalid("invalid_title", edit.nodeId);
      if (
        edit.prompt !== undefined &&
        !isText(edit.prompt, GOAL_LIMITS.maxPromptLength)
      )
        return goalInvalid("invalid_prompt", edit.nodeId);
      const next = {
        ...definition,
        ...(edit.title === undefined ? {} : { title: edit.title }),
        ...(edit.prompt === undefined ? {} : { prompt: edit.prompt }),
      };
      definitions.set(edit.nodeId, { ...next, digest: goalNodeDigest(next) });
      invalidating.add(edit.nodeId);
      continue;
    }
    if (edit.kind === "node-dependencies") {
      const definition = definitions.get(edit.nodeId);
      if (!definition) return goalInvalid("unknown_node", edit.nodeId);
      if (
        !Array.isArray(edit.dependsOn) ||
        edit.dependsOn.length > GOAL_LIMITS.maxDependenciesPerNode ||
        edit.dependsOn.some((id) => typeof id !== "string")
      )
        return goalInvalid("invalid_dependencies", edit.nodeId);
      if (new Set(edit.dependsOn).size !== edit.dependsOn.length)
        return goalInvalid("duplicate_dependency", edit.nodeId);
      if (edit.dependsOn.includes(edit.nodeId))
        return goalInvalid("self_dependency", edit.nodeId);
      const next = { ...definition, dependsOn: [...edit.dependsOn] };
      definitions.set(edit.nodeId, { ...next, digest: goalNodeDigest(next) });
      invalidating.add(edit.nodeId);
      continue;
    }
    if (edit.kind === "disposition") {
      const node = readNode(edit.nodeId);
      if (!node) return goalInvalid("unknown_node", edit.nodeId);
      if (!GOAL_DISPOSITIONS.includes(edit.disposition))
        return goalInvalid("invalid_disposition", edit.nodeId);
      const reason = boundedReason(edit.reason);
      if (!reason) return goalInvalid("missing_reason", edit.nodeId);
      const nodeState = dispositionNodeState(edit.disposition);
      if (!nodeTransitionAllowed(node.state, nodeState))
        return goalInvalid("invalid_disposition", edit.nodeId);
      let evidence = node.evidence;
      if (edit.evidence) {
        const built = manualEvidence(
          edit.evidence,
          "node",
          edit.nodeId,
          revision,
          inputs.now,
          `disposition:${edit.nodeId}:${position + 1}`,
          inputs.artifactReferences,
        );
        if (!built.ok) return built;
        evidence = appendEvidence(evidence, built.value);
      }
      // A skipped node finishes without running, so whatever would have judged
      // it is waived here, by name, under the person who chose to skip it.
      if (edit.disposition === "skip") {
        for (const criterion of definitions.get(edit.nodeId)?.criteria ?? []) {
          evidence = appendEvidence(
            evidence,
            createEvidence({
              scope: "node",
              nodeId: edit.nodeId,
              criterionId: criterion.id,
              kind: "user-attestation",
              trust: "user-accepted",
              summary: `Skipped by ${inputs.actorId}: ${reason}`,
              attemptNumber: null,
              definitionRevision: revision,
              artifact: null,
              discriminator: `skip:${edit.nodeId}:${criterion.id}:${position + 1}`,
              recordedAt: inputs.now,
            }),
          );
        }
      }
      if (edit.disposition === "done") attested.add(edit.nodeId);
      changedNodes.set(edit.nodeId, {
        ...node,
        state: nodeState,
        // Blocking is the one disposition that leaves work outstanding, so it
        // is also the only one that keeps a reason on the node itself.
        blockedReason: edit.disposition === "block" ? reason : null,
        // A finished node has nothing outstanding to point at, while a blocked
        // one keeps whatever Attempt reference a person still needs to inspect.
        currentAttempt: nodeState === "blocked" ? node.currentAttempt : null,
        nextAttemptAt: null,
        evidence,
        updatedAt: inputs.now,
      });
      const entry = audit("goal.disposition", reason, {
        nodeId: edit.nodeId,
        disposition: edit.disposition,
        state: nodeState,
      });
      events.push({
        label: `disposition:${edit.nodeId}:${entry.position}`,
        type: "goal.disposition",
        metadata: {
          goalId: head.goalId,
          nodeId: edit.nodeId,
          disposition: edit.disposition,
          state: nodeState,
          actor: inputs.actor,
          actorId: entry.actorId,
          reason,
        },
      });
      continue;
    }
    if (edit.kind === "resolve-unknown") {
      const node = readNode(edit.nodeId);
      if (!node) return goalInvalid("unknown_node", edit.nodeId);
      const key = `${edit.nodeId}:${edit.attemptNumber}`;
      const attempt = changedAttempts.get(key) ?? attempts.get(key);
      if (!attempt) return goalInvalid("unknown_attempt", key);
      const reason = boundedReason(edit.reason);
      if (!reason) return goalInvalid("missing_reason", edit.nodeId);
      if (!attemptResolutionAllowed(attempt.phase, edit.resolution))
        return goalInvalid("invalid_resolution", key);
      const nodeState =
        edit.resolution === "succeeded"
          ? "done"
          : edit.resolution === "failed"
            ? "failed"
            : "cancelled";
      if (!nodeTransitionAllowed(node.state, nodeState))
        return goalInvalid("invalid_resolution", edit.nodeId);
      let evidence = node.evidence;
      if (edit.evidence) {
        const built = manualEvidence(
          edit.evidence,
          "node",
          edit.nodeId,
          revision,
          inputs.now,
          `resolution:${key}`,
          inputs.artifactReferences,
        );
        if (!built.ok) return built;
        evidence = appendEvidence(evidence, built.value);
      }
      changedAttempts.set(key, {
        ...attempt,
        phase: edit.resolution,
        settledAt: inputs.now,
        error: { code: "user_resolved", message: reason },
      });
      changedNodes.set(edit.nodeId, {
        ...node,
        state: nodeState,
        blockedReason: null,
        currentAttempt: null,
        evidence,
        updatedAt: inputs.now,
      });
      if (edit.resolution === "succeeded") attested.add(edit.nodeId);
      const entry = audit("goal.attempt-resolved", reason, {
        nodeId: edit.nodeId,
        attempt: edit.attemptNumber,
        resolution: edit.resolution,
      });
      events.push({
        label: `resolution:${key}:${entry.position}`,
        type: "goal.attempt-resolved",
        metadata: {
          goalId: head.goalId,
          nodeId: edit.nodeId,
          attempt: edit.attemptNumber,
          resolution: edit.resolution,
          actor: inputs.actor,
          actorId: entry.actorId,
          reason,
        },
      });
      continue;
    }
    if (edit.kind === "waive-criterion") {
      const reason = boundedReason(edit.reason);
      if (!reason) return goalInvalid("missing_reason", edit.criterionId);
      if (edit.scope === "goal") {
        if (!criteria.some((entry) => entry.id === edit.criterionId))
          return goalInvalid("unknown_criterion", edit.criterionId);
        const waiver = createEvidence({
          scope: "goal",
          nodeId: null,
          criterionId: edit.criterionId,
          kind: "user-attestation",
          trust: "user-accepted",
          summary: `Waived by ${inputs.actorId}: ${reason}`,
          attemptNumber: null,
          definitionRevision: revision,
          artifact: null,
          discriminator: `waiver:${edit.criterionId}:${position + 1}`,
          recordedAt: inputs.now,
        });
        head = { ...head, evidence: appendEvidence(head.evidence, waiver) };
      } else {
        const nodeId = edit.nodeId;
        const node = nodeId === undefined ? undefined : readNode(nodeId);
        if (!node || nodeId === undefined)
          return goalInvalid("unknown_node", String(edit.nodeId));
        const definition = definitions.get(nodeId);
        if (
          !definition?.criteria.some((entry) => entry.id === edit.criterionId)
        )
          return goalInvalid("unknown_criterion", edit.criterionId);
        const waiver = createEvidence({
          scope: "node",
          nodeId,
          criterionId: edit.criterionId,
          kind: "user-attestation",
          trust: "user-accepted",
          summary: `Waived by ${inputs.actorId}: ${reason}`,
          attemptNumber: null,
          definitionRevision: revision,
          artifact: null,
          discriminator: `waiver:${nodeId}:${edit.criterionId}:${position + 1}`,
          recordedAt: inputs.now,
        });
        changedNodes.set(nodeId, {
          ...node,
          evidence: appendEvidence(node.evidence, waiver),
          updatedAt: inputs.now,
        });
      }
      const entry = audit("goal.waiver", reason, {
        scope: edit.scope,
        criterionId: edit.criterionId,
        nodeId: edit.nodeId ?? null,
      });
      events.push({
        label: `waiver:${edit.criterionId}:${entry.position}`,
        type: "goal.waiver",
        metadata: {
          goalId: head.goalId,
          scope: edit.scope,
          criterionId: edit.criterionId,
          nodeId: edit.nodeId ?? null,
          actor: inputs.actor,
          actorId: entry.actorId,
          reason,
        },
      });
      continue;
    }
    return goalInvalid("unknown_edit");
  }

  if (invalidateNode !== undefined) {
    if (!nodes.has(invalidateNode))
      return goalInvalid("unknown_node", invalidateNode);
    invalidating.add(invalidateNode);
  }

  let invalidated: readonly string[] = [];
  if (invalidating.size > 0) {
    // Traverse the union of the graph as it was and as it will be, so a node
    // that only just gained a dependency is reset too.
    const adjacency = new Map<string, readonly string[]>();
    for (const node of inputs.nodes) {
      adjacency.set(node.nodeId, [
        ...new Set([
          ...node.definition.dependsOn,
          ...(definitions.get(node.nodeId)?.dependsOn ?? []),
        ]),
      ]);
    }
    const seeds = head.order.filter((id) => invalidating.has(id));
    invalidated = transitiveDependents(adjacency, seeds, head.order);
    for (const nodeId of invalidated) {
      const node = readNode(nodeId);
      if (!node) continue;
      changedNodes.set(nodeId, {
        ...node,
        state: resetNodeState(),
        attemptCount: 0,
        currentAttempt: null,
        nextAttemptAt: null,
        evidence: [],
        blockedReason: null,
        lastError: null,
        updatedAt: inputs.now,
      });
    }
    const selected = seeds.join(",");
    const entry = audit("goal.invalidated", inputs.reason, {
      nodes: invalidated.join(","),
      selected,
    });
    events.push({
      label: `invalidated:${selected}:${entry.position}`,
      type: "goal.invalidated",
      metadata: {
        goalId: head.goalId,
        selected,
        nodes: invalidated.join(","),
        actor: inputs.actor,
        actorId: entry.actorId,
        reason: inputs.reason,
      },
    });
  }

  if (definitionChanged) {
    const ordered = head.order
      .map((id) => definitions.get(id))
      .filter(
        (definition): definition is NonNullable<typeof definition> =>
          !!definition,
      );
    const graph = validateGoalGraph(
      head.goalId,
      objective,
      criteria,
      ordered,
      budget.limits,
    );
    if (!graph.ok) return graph;
    for (const definition of graph.value.nodes) {
      const node = readNode(definition.id);
      if (!node || node.definition.digest === definition.digest) continue;
      changedNodes.set(definition.id, {
        ...node,
        definition,
        updatedAt: inputs.now,
      });
    }
    const entry = audit("goal.edited", inputs.reason, {
      previousDigest: head.revisionDigest,
      digest: graph.value.revisionDigest,
      revision,
      edits: edits.length,
    });
    events.push({
      label: `edited:${graph.value.revisionDigest}`,
      type: "goal.edited",
      metadata: {
        goalId: head.goalId,
        previousDigest: head.revisionDigest,
        digest: graph.value.revisionDigest,
        revision,
        actor: inputs.actor,
        actorId: entry.actorId,
        reason: inputs.reason,
      },
    });
    head = {
      ...head,
      objective,
      criteria,
      budget,
      order: graph.value.order,
      definitionRevision: revision,
      revisionDigest: graph.value.revisionDigest,
    };
  }

  /**
   * The completion gate for a hand-marked node.
   *
   * Marking a node done is a claim that the work happened, so it needs the one
   * thing an Attempt could not supply: a person saying so, at the revision
   * they approved, leaving no criterion unmet. The check runs last because
   * waivers, criteria edits, and invalidation in the same command all move the
   * evidence it reads.
   */
  for (const nodeId of attested) {
    const node = readNode(nodeId);
    const definition = definitions.get(nodeId);
    if (!node || !definition) return goalInvalid("unknown_node", nodeId);
    const accepted = node.evidence.some(
      (entry) =>
        entry.trust === "user-accepted" &&
        entry.definitionRevision === revision,
    );
    const gate = evaluateCriteria(definition.criteria, node.evidence, revision);
    if (!accepted || !gate.satisfied)
      return goalInvalid("criteria_unattested", nodeId);
  }

  head = {
    ...head,
    history: [...head.history, ...history].slice(
      -GOAL_LIMITS.maxHistoryEntries,
    ),
    updatedAt: inputs.now,
  };

  return {
    ok: true,
    value: {
      head,
      nodes: changedNodes,
      attempts: [...changedAttempts.values()],
      events,
      definitionChanged,
      invalidated,
    },
  };
}

function manualEvidence(
  input: NonNullable<Extract<GoalEdit, { kind: "disposition" }>["evidence"]>,
  scope: "goal" | "node",
  nodeId: string | null,
  definitionRevision: number,
  now: number,
  discriminator: string,
  artifactReferences?: ReadonlyMap<string, GoalArtifactReference>,
): GoalOutcome<GoalEvidence> {
  if (!GOAL_EVIDENCE_KINDS.includes(input.kind))
    return goalInvalid("invalid_evidence_kind");
  if (
    typeof input.criterionId !== "string" ||
    input.criterionId.length === 0 ||
    input.criterionId.length > GOAL_LIMITS.maxIdentifierLength
  )
    return goalInvalid("invalid_criterion_id");
  if (
    typeof input.summary !== "string" ||
    input.summary.length === 0 ||
    input.summary.length > GOAL_LIMITS.maxDescriptionLength
  )
    return goalInvalid("invalid_evidence_summary");
  if (
    input.artifactId !== undefined &&
    (typeof input.artifactId !== "string" ||
      !artifactReferences?.has(input.artifactId))
  )
    return goalInvalid("invalid_artifact_id");
  return {
    ok: true,
    value: createEvidence({
      scope,
      nodeId,
      criterionId: input.criterionId,
      kind: input.kind,
      // A person accepting an outcome is explicit evidence, not worker output.
      trust: "user-accepted",
      summary: input.summary,
      attemptNumber: null,
      definitionRevision,
      artifact: input.artifactId
        ? (artifactReferences?.get(input.artifactId) ?? null)
        : null,
      discriminator,
      recordedAt: now,
    }),
  };
}
