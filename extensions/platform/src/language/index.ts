/**
 * Public barrel for Language Intelligence: the project-bound
 * `LanguageIntelligence` module (discover, synchronize, query), its stdio and
 * fixture server adapters, and the model types.
 *
 * Results are advisory only; repository-native build, typecheck, lint, and
 * tests remain authoritative. src/composition.ts dynamically imports
 * intelligence.ts and stdio.ts directly, so nothing loads until first use.
 *
 * See: docs/adr/0005-build-persistent-language-intelligence.md
 */

export { createFixtureLanguageServerAdapter } from "./fixture.ts";
export { createStdioLanguageServerAdapter } from "./stdio.ts";
export {
  createLanguageIntelligence,
  DEFAULT_LANGUAGE_LIMITS,
} from "./intelligence.ts";
export type {
  FixtureLanguageServerAdapter,
  FixtureLanguageServerDefinition,
  LanguageDocumentUpdate,
  LanguageDiscovery,
  LanguageError,
  LanguageErrorCode,
  LanguageIntelligence,
  LanguageIntelligenceOptions,
  LanguageLimits,
  LanguageOutcome,
  LanguageQuery,
  LanguageQueryKind,
  LanguageQueryResult,
  LanguageSelector,
  LanguageServerAdapter,
  LanguageServerCommand,
  LanguageServerConnection,
  LanguageServerDefinition,
  LanguageSynchronization,
  MappedLanguagePath,
  NormalizedCall,
  NormalizedDiagnostic,
  NormalizedHover,
  NormalizedLanguageItem,
  NormalizedLocation,
  NormalizedSymbol,
  StdioLanguageServerAdapterOptions,
} from "./model.ts";
