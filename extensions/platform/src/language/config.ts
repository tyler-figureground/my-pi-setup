import type { PlatformDiagnostic } from "../flags.ts";
import type { LanguageQueryKind, LanguageServerDefinition } from "./model.ts";

const queryKinds = new Set<LanguageQueryKind>([
  "diagnostics",
  "documentSymbols",
  "workspaceSymbols",
  "definition",
  "references",
  "implementations",
  "hover",
  "callHierarchy",
]);
const serverFields = new Set([
  "id",
  "command",
  "selectors",
  "queries",
  "initializationOptions",
  "settings",
]);

function record(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value))
    return undefined;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null
    ? (value as Record<string, unknown>)
    : undefined;
}

function jsonSnapshot(value: unknown) {
  const encoded = JSON.stringify(value);
  if (encoded === undefined || Buffer.byteLength(encoded) > 64 * 1024)
    throw new Error("must be JSON serializable within 65536 bytes");
  return JSON.parse(encoded) as unknown;
}

export function decodeLanguageServerConfiguration(
  input: unknown,
  base: readonly LanguageServerDefinition[] = [],
): {
  readonly servers: readonly LanguageServerDefinition[];
  readonly diagnostics: readonly PlatformDiagnostic[];
} {
  if (input === undefined) return { servers: base, diagnostics: [] };
  if (!Array.isArray(input) || input.length > 4) {
    return {
      servers: base,
      diagnostics: [
        {
          path: "languageServers",
          message: "languageServers must be an array of at most four servers.",
        },
      ],
    };
  }
  const diagnostics: PlatformDiagnostic[] = [];
  const decoded: LanguageServerDefinition[] = [];
  const ids = new Set<string>();
  const issue = (path: string, message: string) =>
    diagnostics.push({ path, message });

  input.forEach((raw, index) => {
    const prefix = `languageServers[${index}]`;
    const value = record(raw);
    if (!value) {
      issue(prefix, "Language server must be an object.");
      return;
    }
    for (const field of Object.keys(value)) {
      if (!serverFields.has(field))
        issue(
          `${prefix}.${field}`,
          `Unknown language server field ${JSON.stringify(field)}.`,
        );
    }
    if (
      typeof value.id !== "string" ||
      !/^[a-z0-9][a-z0-9._-]{0,63}$/i.test(value.id)
    ) {
      issue(`${prefix}.id`, "id must contain 1-64 safe characters.");
      return;
    }
    if (ids.has(value.id)) {
      issue(
        `${prefix}.id`,
        `Duplicate language server id ${JSON.stringify(value.id)}.`,
      );
      return;
    }
    const command = record(value.command);
    const argv = command?.argv;
    const env = command?.env;
    if (
      !command ||
      Object.keys(command).some(
        (field) => field !== "argv" && field !== "env",
      ) ||
      !Array.isArray(argv) ||
      argv.length < 1 ||
      argv.length > 65 ||
      argv.some(
        (part) =>
          typeof part !== "string" ||
          !part ||
          Buffer.byteLength(part) > 8_192 ||
          /[\u0000\r\n]/.test(part),
      )
    ) {
      issue(
        `${prefix}.command`,
        "command must contain only argv (1-65 bounded strings) and optional env.",
      );
      return;
    }
    const environment = env === undefined ? undefined : record(env);
    if (
      env !== undefined &&
      (!environment ||
        Object.entries(environment).length > 64 ||
        Object.entries(environment).some(
          ([name, setting]) =>
            !/^[A-Za-z_][A-Za-z0-9_]*$/.test(name) ||
            typeof setting !== "string" ||
            Buffer.byteLength(setting) > 8_192,
        ))
    ) {
      issue(
        `${prefix}.command.env`,
        "env must contain at most 64 bounded string entries.",
      );
      return;
    }
    if (
      !Array.isArray(value.selectors) ||
      value.selectors.length < 1 ||
      value.selectors.length > 32
    ) {
      issue(`${prefix}.selectors`, "selectors must contain 1-32 entries.");
      return;
    }
    const selectors: LanguageServerDefinition["selectors"][number][] = [];
    for (const [selectorIndex, rawSelector] of value.selectors.entries()) {
      const selector = record(rawSelector);
      const selectorPath = `${prefix}.selectors[${selectorIndex}]`;
      if (
        !selector ||
        Object.keys(selector).some(
          (field) => field !== "languageId" && field !== "extensions",
        ) ||
        typeof selector.languageId !== "string" ||
        !selector.languageId ||
        Buffer.byteLength(selector.languageId) > 64 ||
        !Array.isArray(selector.extensions) ||
        selector.extensions.length < 1 ||
        selector.extensions.length > 32 ||
        selector.extensions.some(
          (extension) =>
            typeof extension !== "string" ||
            !/^\.[A-Za-z0-9][A-Za-z0-9._+-]{0,31}$/.test(extension),
        )
      ) {
        issue(
          selectorPath,
          "Selector requires languageId and 1-32 safe extensions.",
        );
        return;
      }
      selectors.push({
        languageId: selector.languageId,
        extensions: selector.extensions as string[],
      });
    }
    if (
      !Array.isArray(value.queries) ||
      value.queries.length < 1 ||
      value.queries.some((query) => !queryKinds.has(query as LanguageQueryKind))
    ) {
      issue(
        `${prefix}.queries`,
        "queries contains an unsupported language operation.",
      );
      return;
    }
    try {
      const initializationOptions =
        value.initializationOptions === undefined
          ? undefined
          : jsonSnapshot(value.initializationOptions);
      const settings =
        value.settings === undefined ? undefined : jsonSnapshot(value.settings);
      if (settings !== undefined && !record(settings))
        throw new Error("settings must be an object");
      ids.add(value.id);
      decoded.push({
        id: value.id,
        command: {
          executable: argv[0] as string,
          ...(argv.length > 1 ? { args: argv.slice(1) as string[] } : {}),
          ...(environment
            ? { env: environment as Record<string, string> }
            : {}),
        },
        selectors,
        queries: value.queries as LanguageQueryKind[],
        ...(initializationOptions === undefined
          ? {}
          : { initializationOptions }),
        ...(settings === undefined
          ? {}
          : { settings: settings as Record<string, unknown> }),
      });
    } catch (error) {
      issue(
        prefix,
        `Initialization config ${error instanceof Error ? error.message : String(error)}.`,
      );
    }
  });

  return diagnostics.length > 0
    ? { servers: base, diagnostics }
    : { servers: decoded, diagnostics };
}
