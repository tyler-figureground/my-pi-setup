import assert from "node:assert/strict";
import test from "node:test";
import {
  GOAL_LIMITS,
  appendEvidence,
  evaluateCriteria,
  evidenceTrustRank,
  type GoalCriterion,
  type GoalEvidence,
  type GoalEvidenceKind,
  type GoalEvidenceTrust,
} from "./src/goals/index.ts";

function criterion(overrides: Partial<GoalCriterion> = {}): GoalCriterion {
  return {
    id: "tests-pass",
    description: "Tests pass",
    acceptedEvidenceKinds: ["test-report"],
    minimumEvidenceCount: 1,
    minimumTrust: "host-verified",
    ...overrides,
  };
}

function evidence(overrides: Partial<GoalEvidence> = {}): GoalEvidence {
  return {
    id: `evidence-${Math.random().toString(36).slice(2)}`,
    kind: "test-report" as GoalEvidenceKind,
    trust: "host-verified" as GoalEvidenceTrust,
    criterionId: "tests-pass",
    scope: "node",
    nodeId: "build",
    attemptNumber: 1,
    definitionRevision: 1,
    summary: "12 tests passed",
    artifact: null,
    recordedAt: 1_000,
    ...overrides,
  };
}

test("trust ranking places user acceptance above host verification", () => {
  assert.ok(
    evidenceTrustRank("host-verified") > evidenceTrustRank("worker-reported"),
  );
  assert.ok(
    evidenceTrustRank("user-accepted") >= evidenceTrustRank("host-verified"),
  );
});

test("empty criteria are satisfied without evidence", () => {
  const evaluation = evaluateCriteria([], [], 1);
  assert.equal(evaluation.satisfied, true);
  assert.deepEqual(evaluation.unmet, []);
});

test("host verified evidence satisfies a matching criterion", () => {
  const evaluation = evaluateCriteria([criterion()], [evidence()], 1);
  assert.equal(evaluation.satisfied, true);
});

test("worker reported output alone never satisfies a host verified criterion", () => {
  const evaluation = evaluateCriteria(
    [criterion()],
    [evidence({ trust: "worker-reported" })],
    1,
  );
  assert.equal(evaluation.satisfied, false);
  assert.deepEqual(evaluation.unmet, [
    { criterionId: "tests-pass", reason: "insufficient_trust" },
  ]);
});

test("an explicit user waiver satisfies a criterion and stays visible", () => {
  const waiver = evidence({
    trust: "user-accepted",
    kind: "user-attestation",
    summary: "Waived: flaky suite tracked separately",
  });
  const evaluation = evaluateCriteria(
    [criterion({ acceptedEvidenceKinds: ["test-report", "user-attestation"] })],
    [waiver],
    1,
  );
  assert.equal(evaluation.satisfied, true);
});

test("evidence of an unaccepted kind does not count", () => {
  const evaluation = evaluateCriteria(
    [criterion()],
    [evidence({ kind: "worker-output" })],
    1,
  );
  assert.deepEqual(evaluation.unmet, [
    { criterionId: "tests-pass", reason: "missing_evidence" },
  ]);
});

test("evidence bound to an older definition revision is stale", () => {
  const evaluation = evaluateCriteria(
    [criterion()],
    [evidence({ definitionRevision: 1 })],
    2,
  );
  assert.equal(evaluation.satisfied, false);
  assert.deepEqual(evaluation.unmet, [
    { criterionId: "tests-pass", reason: "stale_revision" },
  ]);
});

test("minimum evidence counts need distinct evidence records", () => {
  const single = evidence({ id: "same-evidence" });
  const twice = evaluateCriteria(
    [criterion({ minimumEvidenceCount: 2 })],
    [single, { ...single }],
    1,
  );
  assert.deepEqual(twice.unmet, [
    { criterionId: "tests-pass", reason: "insufficient_count" },
  ]);
  const distinct = evaluateCriteria(
    [criterion({ minimumEvidenceCount: 2 })],
    [evidence({ id: "one" }), evidence({ id: "two" })],
    1,
  );
  assert.equal(distinct.satisfied, true);
});

test("unmet criteria are reported for every criterion, not just the first", () => {
  const evaluation = evaluateCriteria(
    [
      criterion(),
      criterion({ id: "reviewed", acceptedEvidenceKinds: ["review-report"] }),
    ],
    [],
    1,
  );
  assert.equal(evaluation.satisfied, false);
  assert.deepEqual(
    evaluation.unmet.map((entry) => entry.criterionId),
    ["tests-pass", "reviewed"],
  );
});

test("evidence for another criterion never leaks across the gate", () => {
  const evaluation = evaluateCriteria(
    [criterion()],
    [evidence({ criterionId: "something-else" })],
    1,
  );
  assert.deepEqual(evaluation.unmet, [
    { criterionId: "tests-pass", reason: "missing_evidence" },
  ]);
});

test("evidence retention is bounded and deduplicated by identifier", () => {
  let stored: readonly GoalEvidence[] = [];
  for (let index = 0; index < GOAL_LIMITS.maxEvidencePerNode + 4; index += 1) {
    stored = appendEvidence(
      stored,
      evidence({ id: `evidence-${index}`, recordedAt: index }),
    );
  }
  assert.equal(stored.length, GOAL_LIMITS.maxEvidencePerNode);
  assert.equal(
    stored.at(-1)?.id,
    `evidence-${GOAL_LIMITS.maxEvidencePerNode + 3}`,
  );
  assert.equal(stored.at(0)?.id, "evidence-4");

  const deduplicated = appendEvidence(
    [evidence({ id: "stable", summary: "first" })],
    evidence({ id: "stable", summary: "second" }),
  );
  assert.equal(deduplicated.length, 1);
  assert.equal(deduplicated[0]?.summary, "second");
});
