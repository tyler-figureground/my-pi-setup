import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createInMemoryArtifactStore } from "./src/core/artifacts/index.ts";
import type { ResolvedProjectIdentity } from "./src/core/projects/index.ts";
import {
  coreMemoryKinds,
  createHostMemoryBindingFactory,
  createMemoryStoreModule,
  type MemoryScopeSelector,
  type MemoryStore,
} from "./src/memory/index.ts";
import { createSqliteMemoryPersistenceAdapter } from "./src/memory/sqlite-memory-persistence.ts";
import type { WorkspaceLease } from "./src/workspaces/index.ts";

type KindName = keyof typeof coreMemoryKinds;
type Actor = {
  readonly project: "alpha" | "beta";
  readonly worktree: "main" | "linked";
  readonly workspace?: "alpha-feature";
};
type Fixture = {
  readonly id: string;
  readonly writer: string;
  readonly kind: KindName;
  readonly scope: MemoryScopeSelector;
  readonly content: string;
  readonly expiresAt?: number;
  readonly categories: readonly string[];
};
type RetrievalCase = {
  readonly id: string;
  readonly actor: string;
  readonly query: string;
  readonly within?: readonly MemoryScopeSelector[];
  readonly categories: readonly string[];
  readonly relevant: readonly string[];
  readonly forbidden: readonly string[];
};
type ExtractionCase = {
  readonly id: string;
  readonly locale: string;
  readonly input: string;
  readonly shouldRemember: boolean;
  readonly expectedMemory?: string;
};
interface EvaluationDataset {
  readonly dataset: string;
  readonly version: string;
  readonly evaluation: {
    readonly asOf: number;
    readonly k: number;
    readonly runsPerQuery: number;
  };
  readonly thresholds: {
    readonly retrieval: {
      readonly minPrecisionAtK: number;
      readonly minRecallAtK: number;
      readonly minMrr: number;
      readonly maxScopeLeaks: number;
      readonly maxForbiddenHits: number;
      readonly maxP95LatencyMs: number;
      readonly maxContextBytes: number;
    };
    readonly automaticExtraction: {
      readonly minRecall: number;
      readonly maxFalsePositiveRate: number;
      readonly maxFalseMemoryRate: number;
      readonly requireReviewState: boolean;
      readonly requireDirectUserPromotion: boolean;
    };
  };
  readonly actors: Readonly<Record<string, Actor>>;
  readonly memories: readonly Fixture[];
  readonly contradictionPairs: readonly (readonly [string, string])[];
  readonly retrievalCases: readonly RetrievalCase[];
  readonly automaticExtraction: {
    readonly currentExtractor: "absent";
    readonly currentPrediction: "no-writes";
    readonly automaticExtractionEnabled: false;
    readonly promotionPolicy: {
      readonly proposalStatus: "review";
      readonly promotionIngress: "direct-user";
    };
    readonly cases: readonly ExtractionCase[];
  };
}

const dataset = JSON.parse(
  readFileSync(
    join(
      import.meta.dirname,
      "../../docs/verification/phase-6-memory-evaluation.json",
    ),
    "utf8",
  ),
) as EvaluationDataset;

function projectIdentity(project: "alpha" | "beta", worktree: string) {
  const mainWorktree = `C:/memory-evaluation/${project}`;
  const currentWorktree =
    worktree === "main" ? mainWorktree : `${mainWorktree}-linked`;
  return {
    kind: "git" as const,
    projectId: `git:memory-evaluation-${project}`,
    requestedCwd: currentWorktree,
    canonicalCwd: currentWorktree,
    cwdWasAliased: false,
    commonGitDir: `${mainWorktree}/.git`,
    worktreeGitDir:
      worktree === "main"
        ? `${mainWorktree}/.git`
        : `${mainWorktree}/.git/worktrees/linked`,
    repositoryRoot: currentWorktree,
    mainWorktree,
    currentWorktree,
    bare: false as const,
  } satisfies ResolvedProjectIdentity;
}

function workspaceLease(
  projectId: string,
  workspaceId: string,
  expiresAt: number,
) {
  return {
    workspaceId,
    owner: { sessionId: "memory-evaluation", agentId: "quality-benchmark" },
    fence: 1,
    expiresAt,
    snapshot: {
      workspaceId,
      projectId,
      projectRoot: "C:/memory-evaluation/alpha",
      path: "C:/memory-evaluation/alpha-linked",
      branch: "evaluation/alpha-feature",
      baseCommit: "a".repeat(40),
      currentCommit: "b".repeat(40),
      state: "leased" as const,
      createdAt: 1,
      updatedAt: 1,
    },
  } satisfies WorkspaceLease;
}

function percentile(values: readonly number[], quantile: number) {
  const ordered = [...values].sort((left, right) => left - right);
  return ordered[Math.max(0, Math.ceil(ordered.length * quantile) - 1)] ?? 0;
}
function mean(values: readonly number[]) {
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}
function rounded(value: number) {
  return Number(value.toFixed(4));
}

test("versioned Memory evaluation meets retrieval gates and keeps absent extraction off", async (t) => {
  assert.equal(dataset.dataset, "pi-phase-6-memory-evaluation");
  assert.match(dataset.version, /^\d+\.\d+\.\d+$/);
  assert.equal(
    new Set(dataset.memories.map(({ id }) => id)).size,
    dataset.memories.length,
  );
  assert.equal(
    new Set(dataset.retrievalCases.map(({ id }) => id)).size,
    dataset.retrievalCases.length,
  );
  const categories = new Set([
    ...dataset.memories.flatMap(({ categories }) => categories),
    ...dataset.retrievalCases.flatMap(({ categories }) => categories),
  ]);
  for (const required of [
    "exact-terms",
    "paraphrases",
    "identifiers",
    "dates",
    "stale",
    "contradictions",
    "expiry",
    "linked-worktrees",
    "cross-project-isolation",
    "multilingual",
  ])
    assert.ok(categories.has(required), `Dataset lacks ${required} labels`);
  assert.ok(
    dataset.automaticExtraction.cases.some(
      ({ shouldRemember }) => shouldRemember,
    ),
  );
  assert.ok(
    dataset.automaticExtraction.cases.some(
      ({ shouldRemember }) => !shouldRemember,
    ),
  );

  const directory = mkdtempSync(join(tmpdir(), "pi-memory-quality-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const persistence = createSqliteMemoryPersistenceAdapter({
    path: join(directory, "memory.sqlite"),
  });
  if (!persistence.ok) assert.fail(persistence.error.message);

  let now = dataset.evaluation.asOf - 10_000;
  let nextId = 0;
  const memoryModule = createMemoryStoreModule({
    persistence: persistence.value,
    artifacts: createInMemoryArtifactStore({ clock: () => now }),
    clock: () => now,
    id: () => `quality-${++nextId}`,
  });
  const bindingFactory = createHostMemoryBindingFactory({
    revalidate: (binding) => binding,
  });
  const actorAuthorities = new Map<
    string,
    {
      readonly project: ResolvedProjectIdentity;
      readonly workspace?: WorkspaceLease;
    }
  >();
  const actorStores = new Map<string, MemoryStore>();

  for (const [actorId, actor] of Object.entries(dataset.actors)) {
    const project = projectIdentity(actor.project, actor.worktree);
    const workspace = actor.workspace
      ? workspaceLease(
          project.projectId,
          actor.workspace,
          dataset.evaluation.asOf + 3_600_000,
        )
      : undefined;
    const authority = { project, ...(workspace ? { workspace } : {}) };
    actorAuthorities.set(actorId, authority);
    actorStores.set(
      actorId,
      memoryModule.bind(
        bindingFactory.issue({
          executionRole: "parent",
          ingress: "direct-user",
          sessionId: `evaluation-${actorId}`,
          ...authority,
        }),
      ),
    );
  }

  const memoryIds = new Map<string, string>();
  const labelsByMemoryId = new Map<string, string>();
  for (const fixture of dataset.memories) {
    const store = actorStores.get(fixture.writer);
    assert.ok(store, `Unknown fixture writer ${fixture.writer}`);
    const remembered = await store.remember({
      requestId: `quality-fixture-${fixture.id}`,
      kind: coreMemoryKinds[fixture.kind],
      scope: fixture.scope,
      content: fixture.content,
      ...(fixture.expiresAt === undefined
        ? {}
        : { expiresAt: fixture.expiresAt }),
    });
    assert.equal(
      remembered.ok && remembered.value.state,
      "created",
      `Could not create fixture ${fixture.id}`,
    );
    if (!remembered.ok) continue;
    memoryIds.set(fixture.id, remembered.value.memory.id);
    labelsByMemoryId.set(remembered.value.memory.id, fixture.id);
  }
  assert.equal(memoryIds.size, dataset.memories.length);

  for (const [leftLabel, rightLabel] of dataset.contradictionPairs) {
    const leftId = memoryIds.get(leftLabel);
    const rightId = memoryIds.get(rightLabel);
    assert.ok(leftId && rightId);
    const store = actorStores.get("alpha-main");
    assert.ok(store);
    const [left, right] = await Promise.all([
      store.inspect({ id: leftId }),
      store.inspect({ id: rightId }),
    ]);
    assert.equal(left.ok, true);
    assert.equal(right.ok, true);
    if (left.ok && right.ok) {
      assert.equal(
        left.value.memories[0]?.relationships.some(
          ({ kind, targetId }) =>
            kind === "pi/contradicts" && targetId === rightId,
        ),
        true,
      );
      assert.equal(
        right.value.memories[0]?.relationships.some(
          ({ kind, targetId }) =>
            kind === "pi/contradicts" && targetId === leftId,
        ),
        true,
      );
    }
  }

  now = dataset.evaluation.asOf;
  const precisionAtK: number[] = [];
  const recallAtK: number[] = [];
  const reciprocalRanks: number[] = [];
  const latencies: number[] = [];
  let scopeLeaks = 0;
  let forbiddenHits = 0;
  let maxContextBytes = 0;

  for (const evaluationCase of dataset.retrievalCases) {
    const store = actorStores.get(evaluationCase.actor);
    const authority = actorAuthorities.get(evaluationCase.actor);
    assert.ok(store && authority, `Unknown actor ${evaluationCase.actor}`);
    let labels: readonly string[] = [];

    for (let run = 0; run < dataset.evaluation.runsPerQuery; run += 1) {
      const startedAt = performance.now();
      const result: Awaited<ReturnType<MemoryStore["search"]>> =
        await store.search({
          text: evaluationCase.query,
          limit: dataset.evaluation.k,
          asOf: dataset.evaluation.asOf,
          ...(evaluationCase.within ? { within: evaluationCase.within } : {}),
        });
      latencies.push(performance.now() - startedAt);
      assert.equal(result.ok, true, `Search failed for ${evaluationCase.id}`);
      if (!result.ok) continue;
      maxContextBytes = Math.max(
        maxContextBytes,
        Buffer.byteLength(JSON.stringify(result.value)),
      );
      const runLabels: string[] = result.value.map(({ memory }) => {
        const label = labelsByMemoryId.get(memory.id);
        assert.ok(label, `Search returned unknown Memory ${memory.id}`);
        const accessible =
          memory.scope.kind === "user" ||
          (memory.scope.projectId === authority.project.projectId &&
            (memory.scope.kind === "project" ||
              memory.scope.workspaceId === authority.workspace?.workspaceId));
        if (!accessible) scopeLeaks += 1;
        return label;
      });
      if (run === 0) labels = runLabels;
      else
        assert.deepEqual(
          runLabels,
          labels,
          `${evaluationCase.id} was unstable`,
        );
    }

    forbiddenHits += labels.filter((label) =>
      evaluationCase.forbidden.includes(label),
    ).length;
    if (evaluationCase.relevant.length === 0) continue;
    const relevant = new Set(evaluationCase.relevant);
    const relevantHits = labels.filter((label) => relevant.has(label)).length;
    precisionAtK.push(relevantHits / dataset.evaluation.k);
    recallAtK.push(relevantHits / relevant.size);
    const firstRelevant = labels.findIndex((label) => relevant.has(label));
    reciprocalRanks.push(firstRelevant < 0 ? 0 : 1 / (firstRelevant + 1));
  }

  const retrieval = {
    precisionAtK: rounded(mean(precisionAtK)),
    recallAtK: rounded(mean(recallAtK)),
    mrr: rounded(mean(reciprocalRanks)),
    scopeLeaks,
    forbiddenHits,
    latencyMs: {
      median: rounded(percentile(latencies, 0.5)),
      p95: rounded(percentile(latencies, 0.95)),
      maximum: rounded(Math.max(...latencies)),
    },
    contextBytes: { maximum: maxContextBytes },
    positiveQueries: precisionAtK.length,
    safetyQueries: dataset.retrievalCases.length - precisionAtK.length,
    measuredSearches: latencies.length,
  };
  const retrievalThresholds = dataset.thresholds.retrieval;
  assert.ok(
    retrieval.precisionAtK >= retrievalThresholds.minPrecisionAtK,
    `precision@${dataset.evaluation.k} ${retrieval.precisionAtK}`,
  );
  assert.ok(
    retrieval.recallAtK >= retrievalThresholds.minRecallAtK,
    `recall@${dataset.evaluation.k} ${retrieval.recallAtK}`,
  );
  assert.ok(
    retrieval.mrr >= retrievalThresholds.minMrr,
    `MRR ${retrieval.mrr}`,
  );
  assert.ok(retrieval.scopeLeaks <= retrievalThresholds.maxScopeLeaks);
  assert.ok(retrieval.forbiddenHits <= retrievalThresholds.maxForbiddenHits);
  assert.ok(
    retrieval.latencyMs.p95 <= retrievalThresholds.maxP95LatencyMs,
    `p95 latency ${retrieval.latencyMs.p95}ms`,
  );
  assert.ok(
    retrieval.contextBytes.maximum <= retrievalThresholds.maxContextBytes,
    `context ${retrieval.contextBytes.maximum} bytes`,
  );

  const extractionCases = dataset.automaticExtraction.cases;
  const shouldRemember = extractionCases.filter(
    (entry) => entry.shouldRemember,
  );
  const shouldNotRemember = extractionCases.filter(
    (entry) => !entry.shouldRemember,
  );
  const predictedWrites = 0;
  const truePositiveWrites = 0;
  const falsePositiveWrites = 0;
  const falseMemoryWrites = 0;
  const extractionRecall = truePositiveWrites / shouldRemember.length;
  const falsePositiveRate = falsePositiveWrites / shouldNotRemember.length;
  const falseMemoryRate =
    predictedWrites === 0 ? 0 : falseMemoryWrites / predictedWrites;

  const alphaAuthority = actorAuthorities.get("alpha-main");
  const directStore = actorStores.get("alpha-main");
  assert.ok(alphaAuthority && directStore);
  assert.equal("extract" in directStore, false);
  const automaticStore = memoryModule.bind(
    bindingFactory.issue({
      executionRole: "parent",
      ingress: "automatic-proposal",
      sessionId: "automatic-proposal-evaluation",
      ...alphaAuthority,
    }),
  );
  const proposal = await automaticStore.remember({
    requestId: "quality-review-state-probe",
    kind: coreMemoryKinds.preference,
    scope: "project",
    content: "Candidate automatic extraction requires explicit review.",
  });
  assert.equal(proposal.ok && proposal.value.state, "review-required");
  if (!proposal.ok) assert.fail("Automatic proposal probe failed");
  assert.equal(proposal.value.memory.status, "review");
  const hiddenProposal = await directStore.search({
    text: "Candidate automatic extraction explicit review",
    within: ["project"],
  });
  assert.equal(hiddenProposal.ok, true);
  if (hiddenProposal.ok) assert.equal(hiddenProposal.value.length, 0);
  const automaticPromotion = await automaticStore.change({
    type: "promote",
    requestId: "quality-automatic-promotion-denied",
    id: proposal.value.memory.id,
    expectedRevision: proposal.value.memory.revision,
  });
  assert.equal(automaticPromotion.ok, false);
  if (!automaticPromotion.ok)
    assert.equal(automaticPromotion.error.code, "import_requires_direct_user");
  const directPromotion = await directStore.change({
    type: "promote",
    requestId: "quality-direct-promotion",
    id: proposal.value.memory.id,
    expectedRevision: proposal.value.memory.revision,
  });
  assert.equal(directPromotion.ok, true);

  const reviewStateRequired =
    proposal.value.memory.status ===
      dataset.automaticExtraction.promotionPolicy.proposalStatus &&
    hiddenProposal.ok &&
    hiddenProposal.value.length === 0;
  const directUserPromotionRequired =
    !automaticPromotion.ok && directPromotion.ok;
  const extractionThresholds = dataset.thresholds.automaticExtraction;
  const extractionGatePassed =
    extractionRecall >= extractionThresholds.minRecall &&
    falsePositiveRate <= extractionThresholds.maxFalsePositiveRate &&
    falseMemoryRate <= extractionThresholds.maxFalseMemoryRate &&
    (!extractionThresholds.requireReviewState || reviewStateRequired) &&
    (!extractionThresholds.requireDirectUserPromotion ||
      directUserPromotionRequired);
  const automaticExtraction = {
    extractor: dataset.automaticExtraction.currentExtractor,
    predictedWrites,
    recall: extractionRecall,
    falsePositiveRate,
    falseMemoryRate,
    reviewStateRequired,
    directUserPromotionRequired,
    gatePassed: extractionGatePassed,
    enabled: dataset.automaticExtraction.automaticExtractionEnabled,
    labeledPositiveCases: shouldRemember.length,
    labeledNegativeCases: shouldNotRemember.length,
  };
  assert.equal(automaticExtraction.predictedWrites, 0);
  assert.equal(automaticExtraction.falsePositiveRate, 0);
  assert.equal(automaticExtraction.falseMemoryRate, 0);
  assert.equal(automaticExtraction.recall, 0);
  assert.equal(automaticExtraction.reviewStateRequired, true);
  assert.equal(automaticExtraction.directUserPromotionRequired, true);
  assert.equal(automaticExtraction.gatePassed, false);
  assert.equal(automaticExtraction.enabled, false);

  console.log(
    `MEMORY_QUALITY_METRICS ${JSON.stringify({
      dataset: `${dataset.dataset}@${dataset.version}`,
      k: dataset.evaluation.k,
      retrieval,
      automaticExtraction,
    })}`,
  );
});
