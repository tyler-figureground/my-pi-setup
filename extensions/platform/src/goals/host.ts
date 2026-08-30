import type { ProfileCatalog, ProfileCatalogError } from "../profiles/index.ts";
import type { ResolvedAgentProfile } from "../../../shared/agent-profile.ts";
import type { GoalWorkerExecutor } from "../../../shared/goal-worker.ts";
import type { Outcome } from "../core/result.ts";
import type { LocalReview } from "../review/index.ts";
import type { GoalOutcome } from "./model.ts";
import type {
  GoalClock,
  GoalExecutorPort,
  GoalProfilePort,
  GoalProfileResolution,
  GoalReviewPort,
} from "./ports.ts";

/**
 * Production bindings between the Goal runtime and the host subsystems it
 * reuses: the Agent Supervisor's Goal Worker seam, the Agent Profile catalog,
 * and Local Review. Each one narrows what the Goal domain can see to plain
 * data, and each one fails closed rather than inventing authority it lacks.
 */

/** Node timers cannot represent more than about 24.8 days. */
const MAX_TIMER_MS = 2_147_483_647;

export function createSystemGoalClock(): GoalClock {
  return {
    now: Date.now,
    arm(at: number, wake: () => void) {
      const delay = Math.min(Math.max(0, at - Date.now()), MAX_TIMER_MS);
      const timer = setTimeout(wake, delay);
      timer.unref?.();
      return () => clearTimeout(timer);
    },
  };
}

/**
 * Adapt the host-only Goal Worker seam to the Goal execution port.
 *
 * The Goal Worker creates, leases, renews, and preserves the Guarded Workspace
 * for an isolated Agent Profile, because it is the component that holds the
 * lease while the child runs. It reports the workspace identifier back with
 * every outcome, so this port declares executor ownership and the runtime
 * records the identifier instead of preparing a second workspace.
 *
 * Metering is declared per dimension and only where it is proven. The Agent
 * Supervisor meters whole-attempt tokens: it folds each backend's own
 * cumulative billed total, polls it against the cap while the child runs, and
 * certifies the figure at settlement. It prices nothing, so cost stays
 * unmetered and a finite cost budget is still refused before dispatch.
 *
 * The token cap stops a run rather than capping it exactly: a meter advances
 * only when a request completes, so an Attempt can overshoot by at most one
 * in-flight request. The Goal budget covers that by reserving each node's full
 * worst case before dispatch, so the overshoot is charged against an amount
 * already held, never against capacity another Attempt was promised.
 */
export function createGoalWorkerExecutorPort(
  executor: GoalWorkerExecutor,
): GoalExecutorPort {
  return {
    // Agent Supervisor proves whole-attempt tokens; it prices no run.
    metering: { tokens: true, cost: false },
    workspaceOwnership: "executor",
    run(request, signal) {
      if (request.maxCostMicros !== undefined) {
        return Promise.resolve({
          ok: false as const,
          error: {
            code: "metering_unavailable",
            message:
              "Production Goal Worker has no authoritative cost metering.",
            retryable: false,
            certainty: "not-started" as const,
          },
        });
      }
      return executor.run(
        {
          attemptKey: request.attemptKey,
          prompt: request.prompt,
          cwd: request.cwd,
          projectId: request.projectId,
          profile: {
            name: request.profile.name,
            contentDigest: request.profile.contentDigest,
            catalogGeneration: request.profile.catalogGeneration,
            source: {
              scope: request.profile.source.scope,
              path: request.profile.source.path,
            },
          },
          timeoutMs: request.timeoutMs,
          maxOutputBytes: request.maxOutputBytes,
          // Omitted, never undefined: the Goal Worker validates its request as
          // an exact field set, so an absent cap must be an absent key.
          ...(request.maxTokens === undefined
            ? {}
            : { maxTokens: request.maxTokens }),
        },
        signal,
      );
    },
    inspect(attemptKey) {
      return executor.inspect(attemptKey);
    },
  };
}

export interface GoalProfilePortOptions {
  readonly catalog: Pick<ProfileCatalog, "resolve"> &
    Partial<Pick<ProfileCatalog, "revalidate">>;
  readonly projectRoot: string;
  readonly projectTrusted: () => boolean;
  /** Whether a WorkspaceManager exists for isolated Agent Profiles. */
  readonly workspacesAvailable: () => boolean;
}

function profileDenied(reason: string, message: string): GoalOutcome<never> {
  return {
    ok: false,
    error: {
      code: "profile_denied",
      message,
      retryable: false,
      details: { reason },
    },
  };
}

/**
 * Resolve an Agent Profile pin for the Goal runtime.
 *
 * Revalidation is preferred over the cached snapshot so a profile edited after
 * submission is seen: the runtime compares the fresh digest and catalog
 * generation against the Attempt's pin and blocks the Goal when they drift.
 * The Execution Role is passed through untouched - only the Goal core decides
 * whether a role may run a Goal Attempt.
 */
export function createProfileCatalogGoalProfiles(
  options: GoalProfilePortOptions,
): GoalProfilePort {
  return {
    async resolve(name) {
      const projectTrusted = options.projectTrusted();
      if (!projectTrusted) {
        return profileDenied(
          "untrusted_project",
          "Goal Attempts require a trusted project decision.",
        );
      }
      let resolved: Outcome<ResolvedAgentProfile, ProfileCatalogError>;
      try {
        resolved = options.catalog.revalidate
          ? await options.catalog.revalidate(name, {
              projectRoot: options.projectRoot,
              projectTrusted,
            })
          : options.catalog.resolve(name);
      } catch {
        return profileDenied(
          "revalidation_failed",
          `Agent Profile ${name} could not be revalidated.`,
        );
      }
      if (!resolved.ok) {
        return profileDenied(
          "unresolved",
          `Agent Profile ${name} is unavailable.`,
        );
      }
      const profile = resolved.value;
      const workspacePolicy: GoalProfileResolution["workspacePolicy"] =
        profile.policy.workspace === "isolated" ? "isolated" : "inherit";
      if (workspacePolicy === "isolated" && !options.workspacesAvailable()) {
        return profileDenied(
          "workspace_unavailable",
          `Agent Profile ${name} requires Guarded Workspace authority that is not available.`,
        );
      }
      return {
        ok: true,
        value: {
          name: profile.identity.name,
          contentDigest: profile.identity.contentDigest,
          catalogGeneration: profile.identity.catalogGeneration,
          source: {
            scope: profile.identity.source.scope,
            path: profile.identity.source.path,
          },
          role: profile.policy.role,
          workspacePolicy,
        },
      };
    },
  };
}

export interface GoalReviewPortOptions {
  readonly review: () => LocalReview | undefined;
}

/**
 * Host-verified review evidence from Local Review.
 *
 * Local Review is bound to the project working tree, so it can only speak for
 * an Attempt that ran there. An Attempt that ran inside a Guarded Workspace,
 * a criterion that does not accept a review report, or an unavailable reviewer
 * all decline rather than certify a tree nobody inspected.
 */
export function createLocalReviewGoalReview(
  options: GoalReviewPortOptions,
): GoalReviewPort {
  const declined = (summary: string) => ({
    ok: true as const,
    value: {
      satisfied: false,
      kind: "review-report" as const,
      summary,
      artifact: null,
    },
  });
  return {
    async verify(request) {
      if (!request.acceptedEvidenceKinds.includes("review-report")) {
        return declined(
          `Criterion ${request.criterionId} does not accept host review evidence.`,
        );
      }
      if (request.workspaceId !== null) {
        return declined(
          "Local Review cannot verify a Guarded Workspace from the project tree.",
        );
      }
      const review = options.review();
      if (!review) return declined("Local Review is unavailable.");
      const report = await review.run(
        { kind: "uncommitted" },
        { includeTests: true },
      );
      if (!report.ok) {
        return {
          ok: false,
          error: {
            code: "invalid_request",
            message: `Local Review failed: ${report.error.message.slice(0, 500)}`,
            retryable: report.error.retryable ?? false,
          },
        };
      }
      const satisfied = report.value.conclusion === "no-findings";
      return {
        ok: true,
        value: {
          satisfied,
          kind: "review-report",
          summary: satisfied
            ? `Local Review found no findings for ${request.nodeId}.`
            : `Local Review reported ${report.value.findings.length} findings for ${request.nodeId}.`,
          artifact: {
            id: report.value.artifact.id,
            sha256: report.value.artifact.sha256,
            size: report.value.artifact.size,
            ...(report.value.artifact.mediaType === undefined
              ? {}
              : { mediaType: report.value.artifact.mediaType }),
          },
        },
      };
    },
  };
}
