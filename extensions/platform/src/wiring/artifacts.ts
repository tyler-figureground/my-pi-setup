import { Type } from "typebox";
import { Text } from "@earendil-works/pi-tui";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createArtifactAuthority } from "./artifacts-authority.ts";
import {
  registerArtifactCommand,
  safeArtifactText,
  type ArtifactCommandRuntime,
} from "./artifacts-command.ts";

export interface ArtifactCapabilityOptions {
  readonly defaultExpiryMs: number;
  readonly maxExpiryMs: number;
  readonly clock?: () => number;
}

export function createArtifactCapability(
  pi: ExtensionAPI,
  options: ArtifactCapabilityOptions,
) {
  const clock = options.clock ?? Date.now;
  const authority = createArtifactAuthority(clock);
  let runtime: ArtifactCommandRuntime | undefined;

  pi.registerEntryRenderer("artifact-reference", (entry, _view, theme) => {
    const data = entry.data as Record<string, unknown>;
    return new Text(
      `${theme.fg("accent", "Artifact")} ${theme.fg("muted", safeArtifactText(String(data.artifactId ?? "unknown"), 80))}\n${theme.fg("dim", `${safeArtifactText(String(data.target ?? "local"), 16)} · ${safeArtifactText(String(data.state ?? "unknown"), 16)}`)}`,
      1,
      0,
    );
  });

  pi.registerTool({
    name: "artifact_inspect",
    label: "Inspect Artifacts",
    description:
      "Inspect bounded Artifact metadata. Bodies and publication capability URLs are never returned.",
    parameters: Type.Object({
      limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 25 })),
      cursor: Type.Optional(Type.String({ maxLength: 64 })),
    }),
    async execute(_id, input) {
      if (!runtime) throw new Error("Artifact capability is unavailable.");
      const listed = await runtime.artifacts.list({
        limit: input.limit ?? 25,
        ...(input.cursor ? { cursor: input.cursor } : {}),
      });
      if (!listed.ok) throw new Error(listed.error.message);
      const projected = listed.value.artifacts.map(
        ({
          id,
          sha256,
          size,
          createdAt,
          filename,
          mediaType,
          title,
          creator,
          projectId,
          kind,
          sensitivity,
          expiresAt,
        }) => ({
          id,
          sha256,
          size,
          createdAt,
          filename,
          mediaType,
          title,
          creator,
          projectId,
          kind,
          sensitivity,
          expiresAt,
        }),
      );
      return {
        content: [
          {
            type: "text" as const,
            text:
              projected.length === 0
                ? "No Artifacts."
                : projected
                    .map(
                      ({
                        id,
                        filename,
                        mediaType,
                        size,
                        createdAt,
                        expiresAt,
                      }) =>
                        `${id} ${filename ?? "artifact"} ${mediaType ?? "unknown"} ${size} bytes created=${createdAt}${expiresAt === undefined ? "" : ` expires=${expiresAt}`}`,
                    )
                    .join("\n"),
          },
        ],
        details: {
          artifacts: projected,
          nextCursor: listed.value.nextCursor,
        },
      };
    },
  });

  registerArtifactCommand(pi, {
    defaultExpiryMs: options.defaultExpiryMs,
    maxExpiryMs: options.maxExpiryMs,
    clock,
    issue: authority.issue,
    runtime: () => runtime,
  });

  return {
    authority,
    start(next: ArtifactCommandRuntime) {
      runtime = next;
    },
    async stop() {
      const current = runtime;
      runtime = undefined;
      authority.clear();
      await current?.publisher.close();
    },
  };
}
