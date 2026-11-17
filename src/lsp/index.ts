/**
 * @fileoverview Public barrel for the `src/lsp/` subsystem.
 *
 * Re-exports everything that `LspTool` and external consumers need.
 * Internal implementation details (`LspClient`) are intentionally not
 * re-exported here.
 *
 * @packageDocumentation
 */

export type {
  LspServerConfig,
  LspServersConfig,
  LspOperation,
  LspRequestOptions,
  LspDiagnostic,
  LspDiagnosticSeverityValue,
  LspPoolResult,
} from "./types.js";

export { LspDiagnosticSeverity } from "./types.js";
export { LspProcessPool } from "./LspProcessPool.js";
export {
  formatDiagnostics,
  formatHover,
  formatLocations,
  formatDocumentSymbols,
  formatWorkspaceSymbols,
} from "./formatters.js";
