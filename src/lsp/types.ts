/**
 * @fileoverview Core type definitions for the Hernex LSP subsystem.
 *
 * All types in this module are pure data shapes — no runtime logic.
 * `LspProcessPool` and `LspClient` consume these types; `LspTool`
 * passes them through as explicit configuration.
 *
 * @packageDocumentation
 */

// ─────────────────────────────────────────────────────────────────────────────
// Server configuration
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Configuration for a single Language Server Protocol server binary.
 *
 * @example
 * ```typescript
 * const tsServer: LspServerConfig = {
 *   command: "typescript-language-server",
 *   args: ["--stdio"],
 *   extensions: [".ts", ".tsx", ".js", ".jsx"],
 * };
 * ```
 */
export interface LspServerConfig {
  /**
   * The executable command to spawn. Must be on PATH or an absolute path.
   * No default is provided — the caller must supply this explicitly.
   */
  readonly command: string;

  /**
   * Optional argument list forwarded to the server process.
   * Most stdio-based LSP servers require `["--stdio"]`.
   */
  readonly args?: readonly string[] | undefined;

  /**
   * File extensions this server handles (each must start with `.`).
   *
   * @example `[".ts", ".tsx", ".js"]`
   */
  readonly extensions: readonly string[];

  /**
   * Optional LSP `languageId` override.
   * When omitted the pool derives it from the file extension.
   */
  readonly languageId?: string | undefined;

  /**
   * Optional extra environment variables injected into the server process.
   * These are merged on top of the sanitized base environment produced by
   * `getSafeBashEnvironment`. Sensitive keys (API_KEY, TOKEN, etc.) are
   * still stripped before the merge.
   */
  readonly env?: Readonly<Record<string, string>> | undefined;

  /**
   * Milliseconds of inactivity before the server process is torn down.
   * Resets on every request. Defaults to `300_000` (5 minutes) when omitted.
   */
  readonly idleTimeoutMs?: number | undefined;

  /**
   * Maximum number of automatic restart attempts after a crash before the
   * circuit breaker opens and further spawns are refused.
   * Defaults to `3` when omitted.
   */
  readonly maxRestarts?: number | undefined;
}

/**
 * Map of named server entries passed to `LspTool`.
 *
 * Keys are arbitrary human-readable labels (e.g. `"typescript"`, `"rust"`).
 * No built-in defaults exist — every entry must be supplied by the caller.
 *
 * @example
 * ```typescript
 * const servers: LspServersConfig = {
 *   typescript: {
 *     command: "typescript-language-server",
 *     args: ["--stdio"],
 *     extensions: [".ts", ".tsx"],
 *   },
 * };
 * ```
 */
export type LspServersConfig = Readonly<Record<string, LspServerConfig>>;

// ─────────────────────────────────────────────────────────────────────────────
// Operations
// ─────────────────────────────────────────────────────────────────────────────

/**
 * All supported LSP operations exposed through `LspTool`.
 *
 * - `diagnostics`        — File-level errors/warnings; no position required.
 * - `hover`              — Type signature and docs at a cursor position.
 * - `goToDefinition`     — Source location(s) where a symbol is defined.
 * - `goToImplementation` — Concrete implementation(s) of abstract members.
 * - `findReferences`     — All reference sites across the workspace.
 * - `documentSymbol`     — Full symbol outline of the file.
 * - `workspaceSymbol`    — Search symbols by name across the whole workspace.
 */
export type LspOperation =
  | "diagnostics"
  | "hover"
  | "goToDefinition"
  | "goToImplementation"
  | "findReferences"
  | "documentSymbol"
  | "workspaceSymbol";

// ─────────────────────────────────────────────────────────────────────────────
// Request / result
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Input options for a single LSP request dispatched through `LspProcessPool`.
 *
 * Position fields (`line`, `character`) are **1-based** at this interface
 * boundary. The pool converts them to 0-based values on the wire.
 */
export interface LspRequestOptions {
  /** The LSP operation to run. */
  readonly operation: LspOperation;

  /**
   * Absolute path to the file being queried.
   * The pool caller is responsible for resolving relative paths before
   * passing them here.
   */
  readonly filePath: string;

  /**
   * 1-based line number. Required for all position-sensitive operations
   * (`hover`, `goToDefinition`, `goToImplementation`, `findReferences`).
   * Ignored for `diagnostics`, `documentSymbol`, and `workspaceSymbol`.
   */
  readonly line?: number | undefined;

  /**
   * 1-based character offset (column). Required for the same position-sensitive
   * operations as `line`. Ignored otherwise.
   */
  readonly character?: number | undefined;

  /**
   * Query string for `workspaceSymbol`. An empty string or omission causes
   * the server to return all workspace symbols.
   */
  readonly query?: string | undefined;

  /**
   * Milliseconds before the in-flight request is aborted.
   * @default 10_000
   */
  readonly timeoutMs?: number | undefined;
}

// ─────────────────────────────────────────────────────────────────────────────
// Diagnostics
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Numeric severity levels as defined by LSP specification §3.17.1.
 *
 * | Value | Meaning     |
 * |-------|-------------|
 * | 1     | Error       |
 * | 2     | Warning     |
 * | 3     | Information |
 * | 4     | Hint        |
 */
export const LspDiagnosticSeverity = {
  Error: 1,
  Warning: 2,
  Information: 3,
  Hint: 4,
} as const;

/** Numeric severity value from the LSP spec. */
export type LspDiagnosticSeverityValue =
  (typeof LspDiagnosticSeverity)[keyof typeof LspDiagnosticSeverity];

/**
 * A single diagnostic item returned by the language server.
 */
export interface LspDiagnostic {
  /** Severity level per {@link LspDiagnosticSeverity}. `undefined` means unknown. */
  readonly severity: LspDiagnosticSeverityValue | undefined;

  /** Human-readable diagnostic message. */
  readonly message: string;

  /**
   * Optional source tag (e.g. `"typescript"`, `"eslint"`).
   * Taken from the LSP `Diagnostic.source` field.
   */
  readonly source: string | undefined;

  /**
   * Optional diagnostic code (e.g. `2345`, `"TS2345"`).
   * Taken from the LSP `Diagnostic.code` field.
   */
  readonly code: string | number | undefined;

  /** 1-based start line of the affected range. */
  readonly startLine: number;

  /** 1-based start character (column) of the affected range. */
  readonly startCharacter: number;
}

// ─────────────────────────────────────────────────────────────────────────────
// Pool-level result union
// ─────────────────────────────────────────────────────────────────────────────

/** Discriminated union returned by `LspProcessPool.request()`. */
export type LspPoolResult =
  | { readonly ok: true; readonly data: unknown }
  | { readonly ok: false; readonly error: string };
