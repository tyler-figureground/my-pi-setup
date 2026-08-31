import type {
  ExtensionAPI,
  ExtensionCommandContext,
} from "@earendil-works/pi-coding-agent";
import type { ArtifactStore } from "../core/artifacts/index.ts";
import { readArtifactImportFile } from "../artifacts/file-import.ts";
import {
  exportArtifactBundle,
  importArtifactBundle,
  type ArtifactPublisher,
  type ArtifactUserAuthorityToken,
  type PublicationRepository,
  type PublicationApproval,
} from "../artifacts/index.ts";

export interface ArtifactCommandRuntime {
  readonly artifacts: ArtifactStore;
  readonly publisher: ArtifactPublisher;
  readonly projectId?: string;
  readonly publications?: PublicationRepository;
  readonly credentials?: {
    store(
      secret: string,
      project: string,
      teamId?: string,
    ): Promise<string | undefined>;
    remove(
      reference: string,
      project: string,
      teamId?: string,
    ): Promise<boolean>;
  };
}

export interface ArtifactCommandOptions {
  readonly defaultExpiryMs: number;
  readonly maxExpiryMs: number;
  readonly clock: () => number;
  readonly issue: (scope: string) => ArtifactUserAuthorityToken;
  readonly runtime: () => ArtifactCommandRuntime | undefined;
}

function parseArtifactArguments(raw: string) {
  const tokens: string[] = [];
  let token = "";
  let quote: '"' | "'" | undefined;
  for (const character of raw.trim()) {
    if (character === '"' || character === "'") {
      if (!quote) quote = character;
      else if (quote === character) quote = undefined;
      else token += character;
      continue;
    }
    if (/\s/u.test(character) && !quote) {
      if (token) tokens.push(token);
      token = "";
      continue;
    }
    token += character;
  }
  if (quote) throw new Error("Artifact command contains an unmatched quote.");
  if (token) tokens.push(token);
  return tokens;
}

function safe(value: string, maximum = 512) {
  return value.replace(/[\u0000-\u001f\u007f]/gu, "").slice(0, maximum);
}

function approvalText(approval: PublicationApproval) {
  return [
    `Operation: ${approval.operation}`,
    approval.artifactId ? `Artifact: ${approval.artifactId}` : "",
    approval.outboundArtifactId
      ? `Outbound: ${approval.outboundArtifactId}`
      : "",
    `Target: ${approval.target}`,
    `Provider: ${approval.providerId}`,
    `Interactive script: ${approval.interactive ? "yes" : "no"}`,
    `Live refresh: ${approval.live ? "yes" : "no"}`,
    approval.publicationState
      ? `Current state: ${approval.publicationState}`
      : "",
    `Access: ${approval.access}`,
    `Expires: ${new Date(approval.expiresAt).toISOString()}`,
    `Sensitivity: ${approval.sensitivity.verdict}`,
    ...approval.sensitivity.findings.map(
      ({ ruleId, severity, count }) =>
        `${severity.toUpperCase()}: ${safe(ruleId, 128)} (${count})`,
    ),
  ]
    .filter(Boolean)
    .join("\n");
}

async function publish(
  pi: ExtensionAPI,
  ctx: ExtensionCommandContext,
  options: ArtifactCommandOptions,
  artifactId: string,
  target: "local" | "remote",
  access: "private" | "link",
  expiryMs: number,
) {
  const runtime = options.runtime();
  if (!runtime) throw new Error("Artifact capability is unavailable.");
  if (!ctx.hasUI)
    throw new Error(
      "Artifact publication requires TUI or RPC direct-user confirmation.",
    );
  if (
    !Number.isSafeInteger(expiryMs) ||
    expiryMs < 60_000 ||
    expiryMs > options.maxExpiryMs
  )
    throw new Error("Artifact expiry is outside configured bounds.");
  const intent = {
    artifactId,
    target,
    access,
    expiresAt: options.clock() + expiryMs,
  } as const;
  let result = await runtime.publisher.publish(intent);
  if (
    !result.ok &&
    result.error.code === "approval_required" &&
    result.error.approval
  ) {
    const approval = result.error.approval;
    const confirmed = await ctx.ui.confirm(
      target === "local" ? "Open private Artifact?" : "Publish Artifact?",
      approvalText(approval),
    );
    if (!confirmed) return;
    result = await runtime.publisher.publish({
      ...intent,
      authority: options.issue(approval.scope),
    });
  }
  if (!result.ok) throw new Error(result.error.message);
  pi.appendEntry("artifact-reference", {
    handle: result.value.publication.handle,
    artifactId: result.value.publication.sourceArtifactId,
    target: result.value.publication.target,
    state: result.value.publication.state,
    expiresAt: result.value.publication.expiresAt,
    sensitivity: result.value.publication.sensitivity.verdict,
  });
  ctx.ui.notify(
    [
      target === "local" ? "Private Artifact ready." : "Artifact published.",
      `URL: ${result.value.shareUrl}`,
      `Revocation handle: ${result.value.revocationHandle}`,
    ].join("\n"),
    "info",
  );
}

export function registerArtifactCommand(
  pi: ExtensionAPI,
  options: ArtifactCommandOptions,
) {
  pi.registerCommand("artifacts", {
    description: "Browse, list, open, share, inspect, or revoke Artifacts.",
    async handler(raw, ctx) {
      const runtime = options.runtime();
      if (!runtime) {
        ctx.ui.notify("Artifact capability is unavailable.", "warning");
        return;
      }
      if (!ctx.hasUI)
        throw new Error(
          "/artifacts requires TUI or RPC mode; use artifact_inspect for bounded metadata in print/JSON mode.",
        );
      const tokens = parseArtifactArguments(raw);
      const operation = tokens[0] ?? "list";
      if (operation === "credential-store") {
        const project = tokens[1];
        const teamId = tokens[2] === "-" ? undefined : tokens[2];
        const environmentName = tokens[3];
        if (
          !runtime.credentials ||
          !project ||
          !/^[a-z0-9][a-z0-9-]{0,99}$/u.test(project) ||
          (teamId !== undefined && !/^[A-Za-z0-9_-]{1,128}$/u.test(teamId)) ||
          !environmentName ||
          !/^[A-Za-z_][A-Za-z0-9_]{0,127}$/u.test(environmentName)
        )
          throw new Error(
            "Usage: /artifacts credential-store <project> <team-id|-> <ENV_NAME>",
          );
        const secret = process.env[environmentName];
        if (!secret)
          throw new Error(
            `Environment variable ${environmentName} is unavailable.`,
          );
        delete process.env[environmentName];
        const reference = await runtime.credentials.store(
          secret,
          project,
          teamId,
        );
        if (!reference)
          throw new Error("Artifact provider credential could not be stored.");
        ctx.ui.notify(
          `Stored opaque Artifact credential reference: ${reference}`,
          "info",
        );
        return;
      }
      if (operation === "credential-remove") {
        const reference = tokens[1];
        const project = tokens[2];
        const teamId = tokens[3] === "-" ? undefined : tokens[3];
        if (!runtime.credentials || !reference || !project)
          throw new Error(
            "Usage: /artifacts credential-remove <reference> <project> <team-id|->",
          );
        if (!(await runtime.credentials.remove(reference, project, teamId)))
          throw new Error("Artifact provider credential could not be removed.");
        ctx.ui.notify("Artifact provider credential removed.", "info");
        return;
      }
      if (operation === "create") {
        const path = tokens[1];
        const mediaType = tokens[2];
        const flags = new Set(tokens.slice(3));
        const interactive = flags.has("interactive");
        const live = flags.has("live");
        const sensitivity =
          tokens
            .slice(3)
            .find((token) =>
              [
                "unknown",
                "public",
                "internal",
                "confidential",
                "restricted",
              ].includes(token),
            ) ?? "internal";
        const allowedMedia = new Map<
          string,
          "markdown" | "html" | "json" | "image"
        >([
          ["text/markdown", "markdown"],
          ["text/html", "html"],
          ["application/json", "json"],
          ["image/png", "image"],
          ["image/jpeg", "image"],
          ["image/gif", "image"],
          ["image/webp", "image"],
        ] as const);
        const kind = mediaType ? allowedMedia.get(mediaType) : undefined;
        if (
          !path ||
          !mediaType ||
          !kind ||
          (interactive && kind !== "html") ||
          ![
            "unknown",
            "public",
            "internal",
            "confidential",
            "restricted",
          ].includes(sensitivity)
        )
          throw new Error(
            "Usage: /artifacts create <path> <text/markdown|text/html|application/json|image/...> [interactive] [live] [sensitivity]",
          );
        const imported = await readArtifactImportFile(path);
        if (
          !(await ctx.ui.confirm(
            "Create local Artifact?",
            `File: ${safe(imported.filename, 255)}\nMIME: ${mediaType}\nInteractive: ${interactive ? "yes" : "no"}\nLive: ${live ? "yes" : "no"}\nSensitivity: ${sensitivity}\nBytes: ${imported.body.byteLength}`,
          ))
        )
          return;
        const stored = await runtime.artifacts.put({
          body: imported.body,
          filename: imported.filename,
          mediaType,
          title: imported.filename,
          creator: "direct-user",
          ...(runtime.projectId ? { projectId: runtime.projectId } : {}),
          kind,
          sensitivity: sensitivity as
            "unknown" | "public" | "internal" | "confidential" | "restricted",
          ...(interactive || live ? { metadata: { interactive, live } } : {}),
        });
        if (!stored.ok) throw new Error(stored.error.message);
        pi.appendEntry("artifact-reference", {
          artifactId: stored.value.id,
          target: "local",
          state: "stored",
          sensitivity,
        });
        ctx.ui.notify(`Artifact created: ${stored.value.id}`, "info");
        return;
      }
      if (operation === "refresh") {
        const handle = tokens[1];
        const artifactId = tokens[2];
        if (!handle || !artifactId)
          throw new Error(
            "Usage: /artifacts refresh <live-publication-handle> <artifact-id>",
          );
        let result = await runtime.publisher.refresh({ handle, artifactId });
        if (
          !result.ok &&
          result.error.code === "approval_required" &&
          result.error.approval
        ) {
          const approval = result.error.approval;
          if (
            !(await ctx.ui.confirm(
              "Refresh live Artifact?",
              approvalText(approval),
            ))
          )
            return;
          result = await runtime.publisher.refresh({
            handle,
            artifactId,
            authority: options.issue(approval.scope),
          });
        }
        if (!result.ok) throw new Error(result.error.message);
        ctx.ui.notify(`Live Artifact refreshed: ${handle}`, "info");
        return;
      }
      if (operation === "browser") {
        if (!ctx.hasUI || ctx.mode !== "tui")
          throw new Error("/artifacts browser requires interactive TUI mode.");
        const listed = await runtime.artifacts.list({ limit: 100 });
        if (!listed.ok) throw new Error(listed.error.message);
        if (listed.value.artifacts.length === 0) {
          ctx.ui.notify("No Artifacts.", "info");
          return;
        }
        const labels = listed.value.artifacts.map(
          ({ id, title, filename, mediaType, size }) =>
            `${safe(title ?? filename ?? "Artifact", 80)} · ${safe(mediaType ?? "unknown", 48)} · ${size} bytes · ${id.slice(0, 12)}`,
        );
        const selected = await ctx.ui.select("Artifacts", labels);
        const index = selected === undefined ? -1 : labels.indexOf(selected);
        const artifact = listed.value.artifacts[index];
        if (!artifact) return;
        const action = await ctx.ui.select("Artifact action", [
          "Open private local viewer",
          "Share expiring remote link",
          "Cancel",
        ]);
        if (action === "Open private local viewer")
          await publish(
            pi,
            ctx,
            options,
            artifact.id,
            "local",
            "private",
            options.defaultExpiryMs,
          );
        if (action === "Share expiring remote link")
          await publish(
            pi,
            ctx,
            options,
            artifact.id,
            "remote",
            "link",
            options.defaultExpiryMs,
          );
        return;
      }
      if (operation === "publications") {
        if (!runtime.publications)
          throw new Error("Artifact publication registry is unavailable.");
        const listed = await runtime.publications.list();
        if (!listed.ok) throw new Error(listed.error.message);
        ctx.ui.notify(
          listed.value.length === 0
            ? "No Artifact publications."
            : listed.value
                .map(
                  ({ publication, adapterId }) =>
                    `${publication.handle}  ${publication.state}  ${adapterId}  expires ${new Date(publication.expiresAt).toISOString()}`,
                )
                .join("\n"),
          "info",
        );
        return;
      }
      if (operation === "list") {
        const listed = await runtime.artifacts.list({ limit: 50 });
        if (!listed.ok) throw new Error(listed.error.message);
        ctx.ui.notify(
          listed.value.artifacts.length === 0
            ? "No Artifacts."
            : listed.value.artifacts
                .map(
                  ({ id, filename, mediaType, size }) =>
                    `${id}  ${safe(filename ?? "artifact", 80)}  ${safe(mediaType ?? "unknown", 80)}  ${size} bytes`,
                )
                .join("\n"),
          "info",
        );
        return;
      }
      if (operation === "open" || operation === "share") {
        const artifactId = tokens[1];
        if (!artifactId)
          throw new Error(
            `Usage: /artifacts ${operation} <artifact-id> [private|link] [minutes]`,
          );
        const access =
          operation === "share"
            ? tokens[2] === "private"
              ? "private"
              : "link"
            : "private";
        const minutes = tokens[3] === undefined ? undefined : Number(tokens[3]);
        await publish(
          pi,
          ctx,
          options,
          artifactId,
          operation === "open" ? "local" : "remote",
          access,
          minutes === undefined ? options.defaultExpiryMs : minutes * 60_000,
        );
        return;
      }
      if (operation === "status") {
        const handle = tokens[1];
        if (!handle) throw new Error("Usage: /artifacts status <handle>");
        const result = await runtime.publisher.status(handle);
        if (!result.ok) throw new Error(result.error.message);
        ctx.ui.notify(
          `${result.value.handle}: ${result.value.state} (expires ${new Date(result.value.expiresAt).toISOString()})`,
          "info",
        );
        return;
      }
      if (operation === "revoke") {
        const handle = tokens[1];
        if (!handle) throw new Error("Usage: /artifacts revoke <handle>");
        if (!ctx.hasUI)
          throw new Error(
            "Artifact revocation requires direct-user confirmation.",
          );
        let result = await runtime.publisher.revoke({ handle });
        if (
          !result.ok &&
          result.error.code === "approval_required" &&
          result.error.approval
        ) {
          const approval = result.error.approval;
          if (
            !(await ctx.ui.confirm(
              "Revoke Artifact publication?",
              approvalText(approval),
            ))
          )
            return;
          result = await runtime.publisher.revoke({
            handle,
            authority: options.issue(approval.scope),
          });
        }
        if (!result.ok) throw new Error(result.error.message);
        ctx.ui.notify(`${handle}: ${result.value.state}`, "info");
        return;
      }
      if (operation === "export") {
        const artifactId = tokens[1];
        const directory = tokens.slice(2).join(" ");
        if (!artifactId || !directory)
          throw new Error("Usage: /artifacts export <artifact-id> <directory>");
        if (
          !ctx.hasUI ||
          !(await ctx.ui.confirm(
            "Export Artifact?",
            `Artifact: ${artifactId}\nDirectory: ${safe(directory, 260)}`,
          ))
        )
          return;
        const result = await runtime.artifacts.export(artifactId, {
          directory,
        });
        if (!result.ok) throw new Error(result.error.message);
        ctx.ui.notify(
          `Artifact exported: ${safe(result.value.path, 500)}`,
          "info",
        );
        return;
      }
      if (operation === "bundle-export") {
        const path = tokens[1];
        const artifactIds = tokens.slice(2);
        if (!path || artifactIds.length === 0)
          throw new Error(
            "Usage: /artifacts bundle-export <path> <artifact-id...>",
          );
        if (
          !ctx.hasUI ||
          !(await ctx.ui.confirm(
            "Export Artifact bundle?",
            `${artifactIds.length} Artifact(s)\nPath: ${safe(path, 260)}`,
          ))
        )
          return;
        const result = await exportArtifactBundle(
          runtime.artifacts,
          artifactIds,
          path,
        );
        if (!result.ok) throw new Error(result.error.message);
        ctx.ui.notify(`Artifact bundle exported: ${safe(path, 500)}`, "info");
        return;
      }
      if (operation === "bundle-import") {
        const path = tokens.slice(1).join(" ");
        if (!path) throw new Error("Usage: /artifacts bundle-import <path>");
        if (
          !ctx.hasUI ||
          !(await ctx.ui.confirm(
            "Import Artifact bundle?",
            `Path: ${safe(path, 260)}`,
          ))
        )
          return;
        const result = await importArtifactBundle(runtime.artifacts, path);
        if (!result.ok) throw new Error(result.error.message);
        ctx.ui.notify(
          `Imported ${result.value.artifactIds.length} Artifact(s).`,
          "info",
        );
        return;
      }
      if (operation === "delete") {
        const artifactId = tokens[1];
        if (!artifactId)
          throw new Error("Usage: /artifacts delete <artifact-id>");
        if (
          !ctx.hasUI ||
          !(await ctx.ui.confirm(
            "Delete local Artifact?",
            `Artifact: ${artifactId}`,
          ))
        )
          return;
        const result = await runtime.artifacts.remove(artifactId);
        if (!result.ok) throw new Error(result.error.message);
        ctx.ui.notify(`Artifact deleted: ${artifactId}`, "info");
        return;
      }
      throw new Error(
        "Usage: /artifacts [create <path> <mime> [interactive] [live] [sensitivity] | refresh <handle> <id> | browser | list | publications | open <id> | share <id> [private|link] [minutes] | status <handle> | revoke <handle> | export <id> <directory> | bundle-export <path> <id...> | bundle-import <path> | delete <id> | credential-store <ENV_NAME> | credential-remove <reference>]",
      );
    },
  });
}

export { parseArtifactArguments, safe as safeArtifactText };
