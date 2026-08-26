import type {
  ExtensionAPI,
  ExtensionCommandContext,
} from "@earendil-works/pi-coding-agent";
import type {
  LocalReview,
  ReviewProgress,
  ReviewTarget,
} from "../review/index.ts";

const STATUS_KEY = "local-review";

export interface ReviewCapability {
  start(review: LocalReview): void;
  stop(): Promise<void>;
}

export interface CreateReviewCapabilityOptions {
  readonly review?: LocalReview;
}

function sanitize(value: string, max = 500) {
  return value
    .replace(/\x1b(?:\[[0-?]*[ -/]*[@-~]|\][^\x07]*(?:\x07|\x1b\\))/g, "")
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "")
    .slice(0, max);
}

function statusText(progress: ReviewProgress) {
  return {
    capturing: "capturing target",
    reviewing: "reviewing",
    "second-pass": "second review",
    validating: "validating findings",
    persisting: "persisting artifact",
  }[progress];
}

function parseExplicitTarget(tokens: readonly string[]): ReviewTarget {
  const kind = tokens[0];
  if (kind === "uncommitted" && tokens.length === 1)
    return { kind: "uncommitted" };
  if (kind === "base" && tokens.length <= 2) {
    const remoteBranch = tokens[1];
    if (!remoteBranch) return { kind: "base" };
    const separator = remoteBranch.indexOf("/");
    return separator < 0
      ? { kind: "base", branch: remoteBranch }
      : {
          kind: "base",
          remote: remoteBranch.slice(0, separator),
          branch: remoteBranch.slice(separator + 1),
        };
  }
  if (kind === "commit" && tokens.length === 2)
    return { kind: "commit", revision: tokens[1]! };
  if (
    kind === "range" &&
    (tokens.length === 3 || (tokens.length === 4 && tokens[3] === "merge-base"))
  )
    return {
      kind: "range",
      from: tokens[1]!,
      to: tokens[2]!,
      ...(tokens[3] === "merge-base" ? { comparison: "merge-base" } : {}),
    };
  throw new Error(
    "Usage: /review [uncommitted | base [remote/branch] | commit <revision> | range <from> <to> [merge-base]] [--second] [--allow-stale] [--tests]",
  );
}

async function pickTarget(
  ctx: ExtensionCommandContext,
): Promise<ReviewTarget | undefined> {
  const choice = await ctx.ui.select("Review target", [
    "uncommitted changes",
    "base branch",
    "commit",
    "custom range",
  ]);
  if (!choice) return undefined;
  if (choice === "uncommitted changes") return { kind: "uncommitted" };
  if (choice === "base branch") {
    const value = await ctx.ui.input("Remote/base branch", "origin/main");
    if (!value?.trim()) return undefined;
    return parseExplicitTarget(["base", value.trim()]);
  }
  if (choice === "commit") {
    const revision = await ctx.ui.input("Commit revision", "HEAD");
    return revision?.trim()
      ? { kind: "commit", revision: revision.trim() }
      : undefined;
  }
  const range = await ctx.ui.input("Custom range", "<from> <to> [merge-base]");
  return range?.trim()
    ? parseExplicitTarget(["range", ...range.trim().split(/\s+/)])
    : undefined;
}

export function createReviewCapability(
  pi: ExtensionAPI,
  options: CreateReviewCapabilityOptions,
): ReviewCapability {
  let review: LocalReview | undefined = options.review;
  let active:
    | { readonly controller: AbortController; readonly settled: Promise<void> }
    | undefined;

  pi.registerCommand("review", {
    description: "Run a read-only local review with structured findings",
    handler: async (rawArgs, ctx) => {
      if (!ctx.hasUI)
        throw new Error(
          "/review requires TUI or RPC mode so its bounded result and artifact id are observable.",
        );
      const rawTokens = rawArgs.trim().split(/\s+/).filter(Boolean);
      if (rawTokens[0] === "cancel") {
        if (!active) {
          ctx.ui.notify("No local review is running.", "info");
          return;
        }
        active.controller.abort(new Error("Cancelled by user."));
        await active.settled;
        return;
      }
      if (!review) {
        ctx.ui.notify(
          "Local review is unavailable for this project.",
          "warning",
        );
        return;
      }
      if (active) {
        ctx.ui.notify(
          "A local review is already running. Use /review cancel first.",
          "warning",
        );
        return;
      }

      const second = rawTokens.includes("--second");
      const allowStaleBase = rawTokens.includes("--allow-stale");
      const includeTests = rawTokens.includes("--tests");
      const targetTokens = rawTokens.filter(
        (token) =>
          token !== "--second" &&
          token !== "--allow-stale" &&
          token !== "--tests",
      );
      let target: ReviewTarget | undefined;
      try {
        target =
          targetTokens.length > 0
            ? parseExplicitTarget(targetTokens)
            : await pickTarget(ctx);
      } catch (error) {
        ctx.ui.notify(
          error instanceof Error ? error.message : String(error),
          "error",
        );
        return;
      }
      if (!target) return;

      const controller = new AbortController();
      const settled = (async () => {
        try {
          const result = await review!.run(target, {
            signal: controller.signal,
            allowStaleBase,
            includeTests,
            ...(second ? { secondPass: "independent" as const } : {}),
            onProgress: (progress) =>
              ctx.ui.setStatus(STATUS_KEY, statusText(progress)),
          });
          if (!result.ok) {
            const artifactId = result.error.details?.artifactId;
            ctx.ui.notify(
              sanitize(
                `${result.error.message}${typeof artifactId === "string" ? `\nArtifact: ${artifactId}` : ""}`,
              ),
              result.error.code === "cancelled" ? "info" : "error",
            );
            return;
          }
          const report = result.value;
          const freshness =
            report.freshness.kind === "fresh"
              ? `Base freshness: ahead ${report.freshness.ahead} / behind ${report.freshness.behind}`
              : report.freshness.kind === "not-applicable"
                ? ""
                : `Base freshness: ${report.freshness.kind} - ${sanitize(report.freshness.reason)}`;
          const lines = [
            report.conclusion === "no-findings"
              ? "Local review completed: no findings."
              : `Local review completed: ${report.findings.length} finding(s).`,
            freshness,
            ...report.findings
              .slice(0, 50)
              .map(
                (finding) =>
                  `${finding.severity.toUpperCase()} ${sanitize(finding.file, 260)}:${finding.range.startLine}-${finding.range.endLine} [${finding.confidence}] ${sanitize(finding.summary)}`,
              ),
            report.findings.length > 50
              ? `... ${report.findings.length - 50} additional finding(s) in artifact.`
              : "",
            `Artifact: ${report.artifact.id}`,
          ].filter(Boolean);
          ctx.ui.notify(
            lines.join("\n"),
            report.findings.length ? "warning" : "info",
          );
        } finally {
          ctx.ui.setStatus(STATUS_KEY, undefined);
        }
      })();
      active = { controller, settled };
      try {
        await settled;
      } finally {
        if (active?.settled === settled) active = undefined;
      }
    },
  });

  return {
    start(nextReview) {
      if (active)
        throw new Error(
          "Cannot replace LocalReview while a review is running.",
        );
      review = nextReview;
    },
    async stop() {
      const current = active;
      review = undefined;
      if (!current) return;
      current.controller.abort(new Error("Session stopped."));
      await current.settled;
      if (active === current) active = undefined;
    },
  };
}
