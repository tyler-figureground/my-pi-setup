import type { PlatformDiagnostic } from "../flags.ts";

export interface PlatformBrowserConfiguration {
  readonly executablePath: string;
  readonly profileName: string;
  readonly allowedOrigins: readonly string[];
  readonly allowLoopback: boolean;
}

export const defaultPlatformBrowserConfiguration: PlatformBrowserConfiguration =
  Object.freeze({
    executablePath: "",
    profileName: "phase5",
    allowedOrigins: [],
    allowLoopback: false,
  });

function origin(value: unknown) {
  if (typeof value !== "string" || Buffer.byteLength(value) > 2_048)
    throw new Error("Browser origin must be a bounded string.");
  const url = new URL(value);
  if (
    (url.protocol !== "http:" && url.protocol !== "https:") ||
    url.username ||
    url.password ||
    url.pathname !== "/" ||
    url.search ||
    url.hash
  )
    throw new Error(
      "Browser allowedOrigins entries must be canonical origins.",
    );
  return url.origin;
}

export function decodeBrowserConfiguration(
  input: unknown,
  base: PlatformBrowserConfiguration,
  scope: "user" | "project",
): {
  readonly browser: PlatformBrowserConfiguration;
  readonly diagnostics: readonly PlatformDiagnostic[];
} {
  if (input === undefined) return { browser: base, diagnostics: [] };
  if (!input || typeof input !== "object" || Array.isArray(input))
    return {
      browser: base,
      diagnostics: [
        {
          path: "browserSettings",
          message: "browserSettings must be an object.",
        },
      ],
    };
  const value = input as Record<string, unknown>;
  const diagnostics: PlatformDiagnostic[] = [];
  const unknown = Object.keys(value).filter(
    (key) =>
      ![
        "executablePath",
        "profileName",
        "allowedOrigins",
        "allowLoopback",
      ].includes(key),
  );
  for (const key of unknown)
    diagnostics.push({
      path: `browserSettings.${key}`,
      message: `Unknown browser setting ${JSON.stringify(key)}.`,
    });
  let executablePath = base.executablePath;
  let profileName = base.profileName;
  if (scope === "project") {
    for (const field of ["executablePath", "profileName"])
      if (value[field] !== undefined)
        diagnostics.push({
          path: `browserSettings.${field}`,
          message: `${field} is user-managed and cannot be changed by project config.`,
        });
  } else {
    if (value.executablePath !== undefined) {
      if (
        typeof value.executablePath !== "string" ||
        !value.executablePath ||
        Buffer.byteLength(value.executablePath) > 4_096 ||
        value.executablePath.includes("\0")
      )
        diagnostics.push({
          path: "browserSettings.executablePath",
          message: "executablePath must be a bounded path.",
        });
      else executablePath = value.executablePath;
    }
    if (value.profileName !== undefined) {
      if (
        typeof value.profileName !== "string" ||
        !/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(value.profileName)
      )
        diagnostics.push({
          path: "browserSettings.profileName",
          message: "profileName is invalid.",
        });
      else profileName = value.profileName;
    }
  }
  let allowedOrigins = [...base.allowedOrigins];
  if (value.allowedOrigins !== undefined) {
    if (
      !Array.isArray(value.allowedOrigins) ||
      value.allowedOrigins.length > 256
    )
      diagnostics.push({
        path: "browserSettings.allowedOrigins",
        message: "allowedOrigins must be a bounded array.",
      });
    else {
      for (let index = 0; index < value.allowedOrigins.length; index += 1) {
        try {
          const canonical = origin(value.allowedOrigins[index]);
          if (!allowedOrigins.includes(canonical))
            allowedOrigins.push(canonical);
        } catch (error) {
          diagnostics.push({
            path: `browserSettings.allowedOrigins[${index}]`,
            message: error instanceof Error ? error.message : String(error),
          });
        }
      }
    }
  }
  let allowLoopback = base.allowLoopback;
  if (value.allowLoopback !== undefined) {
    if (typeof value.allowLoopback !== "boolean")
      diagnostics.push({
        path: "browserSettings.allowLoopback",
        message: "allowLoopback must be boolean.",
      });
    else allowLoopback = value.allowLoopback;
  }
  return {
    browser:
      diagnostics.length > 0
        ? base
        : { executablePath, profileName, allowedOrigins, allowLoopback },
    diagnostics,
  };
}
