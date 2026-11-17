/**
 * @fileoverview Model-facing AgentTool implementation for on-demand Language
 * Server Protocol (LSP) intelligence.
 *
 * `LspTool` is an opt-in tool — it is **not** registered in
 * `ToolRegistry.registerDefaultTools()`. Callers must register it explicitly
 * with a required `servers` configuration:
 *
 * ```typescript
 * registry.register(
 *   new LspTool({
 *     servers: {
 *       typescript: {
 *         command: "typescript-language-server",
 *         args: ["--stdio"],
 *         extensions: [".ts", ".tsx", ".js"],
 *       },
 *     },
 *   }),
 * );
 * ```
 *
 * No default server configurations are provided by Hernex. Every server
 * entry must be explicitly supplied by the caller.
 *
 * **Process lifecycle:** `LspTool` owns a persistent {@link LspProcessPool}.
 * Server processes are started lazily on first use and kept alive between
 * calls. The pool shuts down idle servers after `idleTimeoutMs` (default
 * 5 minutes). Call {@link LspTool.dispose} to tear down all processes
 * immediately.
 *
 * @packageDocumentation
 */

import { z } from "zod";
import { resolve as resolvePath } from "node:path";
import { existsSync } from "node:fs";
import type { AgentTool } from "./AgentTool.js";
import type { ToolExecutionContext } from "./ToolExecutionContext.js";
import { lspDescription } from "./prompts.js";
import { LspProcessPool } from "../lsp/LspProcessPool.js";
import {
  formatDiagnostics,
  formatHover,
  formatLocations,
  formatDocumentSymbols,
  formatWorkspaceSymbols,
} from "../lsp/formatters.js";
import type { LspServersConfig, LspDiagnostic } from "../lsp/types.js";

// ─────────────────────────────────────────────────────────────────────────────
// LspToolConfig
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Required configuration for constructing an {@link LspTool} instance.
 *
 * @example
 * ```typescript
 * const config: LspToolConfig = {
 *   servers: {
 *     typescript: {
 *       command: "typescript-language-server",
 *       args: ["--stdio"],
 *       extensions: [".ts", ".tsx", ".js"],
 *     },
 *   },
 *   idleTimeoutMs: 300_000,
 * };
 * ```
 */
export interface LspToolConfig {
  /**
   * Map of named language server configurations.
   * Keys are arbitrary human-readable labels; values describe the binary
   * and extensions it handles.
   * **At least one entry is required.**
   */
  readonly servers: LspServersConfig;

  /**
   * Milliseconds of inactivity before an idle server process is torn down.
   * Applied as the default to any server config that does not specify its
   * own `idleTimeoutMs`.
   * @default 300_000 (5 minutes)
   */
  readonly idleTimeoutMs?: number;
}

// ─────────────────────────────────────────────────────────────────────────────
// Input schema
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Zod schema defining and validating input parameters for {@link LspTool}.
 *
 * Position parameters (`line`, `character`) are **1-based** to match editor
 * conventions. They are only required for position-sensitive operations.
 */
export const lspInputSchema = z.object({
  operation: z
    .enum([
      "hover",
      "goToDefinition",
      "goToImplementation",
      "findReferences",
      "documentSymbol",
      "workspaceSymbol",
      "diagnostics",
    ])
    .describe(
      "The LSP operation to perform. " +
        "'hover' returns type signatures and documentation at a position. " +
        "'goToDefinition' returns the definition location of a symbol. " +
        "'goToImplementation' returns concrete implementation locations for interfaces or abstract members. " +
        "'findReferences' returns all usage sites of a symbol across the workspace. " +
        "'documentSymbol' returns a full symbol outline of the file. " +
        "'workspaceSymbol' searches all symbols in the workspace by name query. " +
        "'diagnostics' returns language-server errors, warnings, and hints for the file.",
    ),

  filePath: z
    .string()
    .min(1)
    .describe(
      "Relative or absolute path to the file to query. " +
        "Relative paths are resolved against the workspace working directory.",
    ),

  line: z
    .number()
    .int()
    .min(1)
    .optional()
    .describe(
      "1-based line number of the cursor position. " +
        "Required for 'hover', 'goToDefinition', 'goToImplementation', and 'findReferences'. " +
        "Ignored for 'diagnostics', 'documentSymbol', and 'workspaceSymbol'.",
    ),

  character: z
    .number()
    .int()
    .min(1)
    .optional()
    .describe(
      "1-based character offset (column) of the cursor position. " +
        "Required for the same operations as 'line'. Ignored otherwise.",
    ),

  query: z
    .string()
    .optional()
    .describe(
      "Search query string for 'workspaceSymbol'. " +
        "An empty string or omission returns all workspace symbols. " +
        "Ignored for all other operations.",
    ),
});

/**
 * Inferred TypeScript type for validated {@link LspTool} input parameters.
 *
 * @example
 * ```typescript
 * const params: LspInput = {
 *   operation: "hover",
 *   filePath: "src/index.ts",
 *   line: 12,
 *   character: 8,
 * };
 * ```
 */
export type LspInput = z.infer<typeof lspInputSchema>;

// ─────────────────────────────────────────────────────────────────────────────
// Position-sensitive operations (require line + character)
// ─────────────────────────────────────────────────────────────────────────────

const POSITION_SENSITIVE_OPS = new Set([
  "hover",
  "goToDefinition",
  "goToImplementation",
  "findReferences",
]);

// ─────────────────────────────────────────────────────────────────────────────
// LspTool class
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Model-facing AgentTool that exposes on-demand Language Server Protocol
 * intelligence to the Hernex agent engine.
 *
 * **Registration (opt-in — not in default tool suite):**
 * ```typescript
 * const registry = new ToolRegistry({ includeDefaults: true });
 * registry.register(
 *   new LspTool({
 *     servers: {
 *       typescript: {
 *         command: "typescript-language-server",
 *         args: ["--stdio"],
 *         extensions: [".ts", ".tsx"],
 *       },
 *     },
 *   }),
 * );
 * ```
 *
 * **Process lifecycle:** Servers are started lazily, kept warm between calls,
 * and torn down after the configured idle timeout. Call {@link dispose} when
 * the tool is no longer needed to immediately release all processes.
 *
 * @example
 * ```typescript
 * import { LspTool } from "@amaranthic/hernex";
 *
 * const lsp = new LspTool({
 *   servers: {
 *     typescript: {
 *       command: "typescript-language-server",
 *       args: ["--stdio"],
 *       extensions: [".ts", ".tsx", ".js"],
 *     },
 *   },
 * });
 *
 * const result = await lsp.execute(
 *   { operation: "hover", filePath: "src/index.ts", line: 12, character: 8 },
 *   context,
 * );
 * ```
 */
export class LspTool implements AgentTool<typeof lspInputSchema, string> {
  /** Unique tool name exposed to the language model. */
  public static readonly toolName = "lsp";

  public readonly name = LspTool.toolName;
  public readonly description = lspDescription;
  public readonly inputSchema = lspInputSchema;

  /** The resolved tool configuration. */
  private readonly _config: LspToolConfig;

  /**
   * Returns the configuration used by this tool instance.
   */
  public get config(): LspToolConfig {
    return this._config;
  }

  /** Persistent process pool owned by this tool instance. */
  private readonly _pool: LspProcessPool;

  /**
   * Constructs a new `LspTool` instance.
   *
   * @param config - Required tool configuration including the `servers` map.
   *   No default server configurations are injected by Hernex.
   *
   * @example
   * ```typescript
   * const lsp = new LspTool({
   *   servers: {
   *     rust: {
   *       command: "rust-analyzer",
   *       extensions: [".rs"],
   *     },
   *   },
   *   idleTimeoutMs: 600_000, // 10 minutes
   * });
   * ```
   */
  public constructor(config: LspToolConfig) {
    this._config = config;

    // Apply tool-level idleTimeoutMs as default to servers that omit it.
    const servers: Record<string, LspServersConfig[string]> = {};
    for (const [name, serverCfg] of Object.entries(config.servers)) {
      const idleTimeoutMs = serverCfg.idleTimeoutMs ?? config.idleTimeoutMs;
      servers[name] = {
        ...serverCfg,
        ...(idleTimeoutMs !== undefined ? { idleTimeoutMs } : {}),
      };
    }

    this._pool = new LspProcessPool(servers);
  }

  /**
   * Executes the requested LSP operation against the matching language server.
   *
   * Returns a Markdown-formatted string with the result. On any error
   * (missing binary, timeout, path guard violation, no server for extension,
   * etc.) returns a plain-text `"LSP error: ..."` description rather than
   * throwing, so the agent engine always receives a usable tool result.
   *
   * @param parameters - Validated input parameters from the model.
   * @param context - Execution context supplying `workingDirectory`.
   * @returns A promise resolving to a Markdown string with the operation result,
   *          or a plain-text `"LSP error: ..."` description on failure.
   *
   * @example
   * ```typescript
   * const output = await lspTool.execute(
   *   { operation: "diagnostics", filePath: "src/index.ts" },
   *   { threadId: "t1", toolCallId: "c1", workingDirectory: "/home/user/project" },
   * );
   * ```
   */
  public async execute(
    parameters: LspInput,
    context: ToolExecutionContext,
  ): Promise<string> {
    const { operation, filePath, line, character, query } = parameters;
    const { workingDirectory } = context;

    // ── Resolve absolute file path ──────────────────────────────────────────
    const absPath = resolvePath(workingDirectory, filePath);

    // ── Path guard: must be within workingDirectory ──────────────────────────
    if (
      !absPath.startsWith(workingDirectory + "/") &&
      absPath !== workingDirectory
    ) {
      return `LSP error: Access denied — "${filePath}" resolves outside the workspace.`;
    }

    // ── File existence check ─────────────────────────────────────────────────
    if (!existsSync(absPath)) {
      return `LSP error: File not found — "${filePath}".`;
    }

    // ── Position required for position-sensitive operations ──────────────────
    if (POSITION_SENSITIVE_OPS.has(operation)) {
      if (line === undefined || character === undefined) {
        return (
          `LSP error: "line" and "character" are required for "${operation}". ` +
          `They are 1-based integers (e.g. line: 1, character: 1).`
        );
      }
    }

    // ── Dispatch to pool ─────────────────────────────────────────────────────
    const result = await this._pool.request(
      {
        operation,
        filePath: absPath,
        line,
        character,
        query,
      },
      workingDirectory,
    );

    if (!result.ok) {
      return `LSP error: ${result.error}`;
    }

    // ── Format result ────────────────────────────────────────────────────────
    return this._format(operation, result.data, absPath, workingDirectory);
  }

  /**
   * Tears down all language server processes owned by this tool instance.
   *
   * Safe to call multiple times. After disposal, calling `execute()` will
   * return an `"LSP error: ..."` message for all requests.
   *
   * @returns A promise that resolves once all processes have exited.
   */
  public async dispose(): Promise<void> {
    await this._pool.dispose();
  }

  // ── Private helpers ────────────────────────────────────────────────────────

  /**
   * Routes the raw LSP result to the appropriate formatter.
   *
   * @param operation - The operation that produced the result.
   * @param data - Raw result data from the pool.
   * @param absPath - Absolute path to the queried file.
   * @param workingDirectory - Workspace root for relative path computation.
   * @returns Formatted Markdown string.
   */
  private _format(
    operation: LspInput["operation"],
    data: unknown,
    absPath: string,
    workingDirectory: string,
  ): string {
    switch (operation) {
      case "diagnostics":
        return formatDiagnostics(data as LspDiagnostic[], absPath);

      case "hover":
        return formatHover(data);

      case "goToDefinition":
        return formatLocations(data, "Definition", workingDirectory);

      case "goToImplementation":
        return formatLocations(data, "Implementation", workingDirectory);

      case "findReferences":
        return formatLocations(data, "References", workingDirectory);

      case "documentSymbol":
        return formatDocumentSymbols(data);

      case "workspaceSymbol":
        return formatWorkspaceSymbols(data, workingDirectory);
    }
  }
}
