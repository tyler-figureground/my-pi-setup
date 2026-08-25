export const defaultPlatformFlags = Object.freeze({
  planMode: false,
  hooks: false,
  rules: false,
  profiles: false,
  workspaces: false,
  languageIntelligence: false,
  review: false,
  mcp: false,
  browser: false,
  messaging: false,
  memory: false,
  monitors: false,
  scheduler: false,
  goals: false,
  artifacts: false,
});

export type PlatformFlagName = keyof typeof defaultPlatformFlags;
export type PlatformFlags = Readonly<Record<PlatformFlagName, boolean>>;

export interface PlatformDiagnostic {
  readonly path: string;
  readonly message: string;
}

export function decodePlatformFlags(input: unknown = undefined): {
  readonly flags: PlatformFlags;
  readonly diagnostics: readonly PlatformDiagnostic[];
} {
  const flags: Record<PlatformFlagName, boolean> = {
    ...defaultPlatformFlags,
  };
  if (input === undefined) return { flags, diagnostics: [] };
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    return {
      flags,
      diagnostics: [
        { path: "$", message: "Platform flags must be an object." },
      ],
    };
  }

  const diagnostics: PlatformDiagnostic[] = [];
  for (const [name, value] of Object.entries(input)) {
    if (!(name in defaultPlatformFlags)) {
      diagnostics.push({
        path: name,
        message: `Unknown platform feature flag ${JSON.stringify(name)}.`,
      });
      continue;
    }
    if (typeof value !== "boolean") {
      diagnostics.push({
        path: name,
        message: `Platform feature flag ${JSON.stringify(name)} must be boolean.`,
      });
      continue;
    }
    if (value) {
      diagnostics.push({
        path: name,
        message: `Platform capability ${JSON.stringify(name)} is unavailable while Phase 1 flags remain disabled.`,
      });
    }
  }
  return { flags, diagnostics };
}
