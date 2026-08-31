import type { PlatformDiagnostic } from "../flags.ts";

export interface PlatformArtifactConfiguration {
  readonly defaultExpiryMs: number;
  readonly maxExpiryMs: number;
  readonly vercel?: {
    readonly project: string;
    readonly teamId?: string;
    readonly credentialReference: string;
  };
}

export const defaultPlatformArtifactConfiguration: PlatformArtifactConfiguration =
  Object.freeze({
    defaultExpiryMs: 60 * 60 * 1_000,
    maxExpiryMs: 7 * 24 * 60 * 60 * 1_000,
  });

export function decodeArtifactConfiguration(
  input: unknown,
  base: PlatformArtifactConfiguration,
  scope: "user" | "project",
): {
  readonly artifacts: PlatformArtifactConfiguration;
  readonly diagnostics: readonly PlatformDiagnostic[];
} {
  if (input === undefined) return { artifacts: base, diagnostics: [] };
  if (scope === "project")
    return {
      artifacts: base,
      diagnostics: [
        {
          path: "artifactSettings",
          message: "Artifact provider settings are user-managed.",
        },
      ],
    };
  if (!input || typeof input !== "object" || Array.isArray(input))
    return {
      artifacts: base,
      diagnostics: [
        {
          path: "artifactSettings",
          message: "artifactSettings must be an object.",
        },
      ],
    };
  const value = input as Record<string, unknown>;
  const diagnostics: PlatformDiagnostic[] = [];
  for (const key of Object.keys(value)) {
    if (!["defaultExpiryMs", "maxExpiryMs", "vercel"].includes(key))
      diagnostics.push({
        path: `artifactSettings.${key}`,
        message: `Unknown Artifact setting ${JSON.stringify(key)}.`,
      });
  }
  const duration = (name: string, candidate: unknown, fallback: number) => {
    if (candidate === undefined) return fallback;
    if (
      !Number.isSafeInteger(candidate) ||
      Number(candidate) < 60_000 ||
      Number(candidate) > 30 * 24 * 60 * 60 * 1_000
    ) {
      diagnostics.push({
        path: `artifactSettings.${name}`,
        message: `${name} must be an integer from one minute through 30 days.`,
      });
      return fallback;
    }
    return Number(candidate);
  };
  const defaultExpiryMs = duration(
    "defaultExpiryMs",
    value.defaultExpiryMs,
    base.defaultExpiryMs,
  );
  const maxExpiryMs = duration(
    "maxExpiryMs",
    value.maxExpiryMs,
    base.maxExpiryMs,
  );
  if (defaultExpiryMs > maxExpiryMs)
    diagnostics.push({
      path: "artifactSettings.defaultExpiryMs",
      message: "defaultExpiryMs cannot exceed maxExpiryMs.",
    });
  let vercel = base.vercel;
  if (value.vercel !== undefined) {
    if (
      !value.vercel ||
      typeof value.vercel !== "object" ||
      Array.isArray(value.vercel)
    )
      diagnostics.push({
        path: "artifactSettings.vercel",
        message: "vercel must be an object.",
      });
    else {
      const candidate = value.vercel as Record<string, unknown>;
      for (const key of Object.keys(candidate)) {
        if (!["project", "teamId", "credentialReference"].includes(key))
          diagnostics.push({
            path: `artifactSettings.vercel.${key}`,
            message: `Unknown Vercel Artifact setting ${JSON.stringify(key)}.`,
          });
      }
      if (
        typeof candidate.project !== "string" ||
        !/^[a-z0-9][a-z0-9-]{0,99}$/u.test(candidate.project) ||
        (candidate.teamId !== undefined &&
          (typeof candidate.teamId !== "string" ||
            !/^[A-Za-z0-9_-]{1,128}$/u.test(candidate.teamId))) ||
        typeof candidate.credentialReference !== "string" ||
        !/^credential:[A-Za-z0-9][A-Za-z0-9._-]{0,223}$/u.test(
          candidate.credentialReference,
        )
      )
        diagnostics.push({
          path: "artifactSettings.vercel",
          message:
            "Vercel Artifact project, teamId, or credentialReference is invalid.",
        });
      else
        vercel = {
          project: candidate.project,
          ...(candidate.teamId === undefined
            ? {}
            : { teamId: candidate.teamId }),
          credentialReference: candidate.credentialReference,
        };
    }
  }
  return diagnostics.length > 0
    ? { artifacts: base, diagnostics }
    : {
        artifacts: {
          defaultExpiryMs,
          maxExpiryMs,
          ...(vercel ? { vercel } : {}),
        },
        diagnostics,
      };
}
