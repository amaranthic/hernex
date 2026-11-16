/**
 * @fileoverview Model-facing AgentTool implementation for on-demand Language
 * Server Protocol (LSP) intelligence.
 *
 * `LspTool` is an opt-in tool — it is **not** registered in
 * `ToolRegistry.registerDefaultTools()`. Callers must register it explicitly:
 *
 * ```typescript
 * registry.register(new LspTool());                    // uses defaultLspConfig
 * registry.register(new LspTool(customConfig));        // custom server map
 * ```
 *
 * Each invocation spawns the appropriate LSP server binary on demand,
 * performs exactly one operation, then exits cleanly. Zero lingering processes.
 *
 * @packageDocumentation
 */

import { z } from "zod";
import type { AgentTool } from "./AgentTool.js";
import type { ToolExecutionContext } from "./ToolExecutionContext.js";
import { lspDescription } from "./prompts.js";
import {
  DEFAULT_LSP_TIMEOUT_MS,
  defaultLspConfig,
  runLspRequest,
  type LspConfig,
} from "./internal/lsp.js";

// ─────────────────────────────────────────────────────────────────────────────
// Input schema
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Zod schema defining and validating input parameters for {@link LspTool}.
 *
 * All position parameters are **1-based** (line 1 and character 1 refer to
 * the very first character of the file), matching editor conventions.
 * The internal engine converts them to 0-based values before writing LSP wire
 * frames.
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
    .describe(
      "1-based line number of the cursor position. " +
        "For 'documentSymbol', 'workspaceSymbol', and 'diagnostics', pass 1.",
    ),

  character: z
    .number()
    .int()
    .min(1)
    .describe(
      "1-based character offset (column) of the cursor position. " +
        "For 'documentSymbol', 'workspaceSymbol', and 'diagnostics', pass 1.",
    ),

  query: z
    .string()
    .optional()
    .describe(
      "Search query string for 'workspaceSymbol'. " +
        "An empty string returns all symbols. Ignored for all other operations.",
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
// LspTool class
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Model-facing AgentTool that exposes on-demand Language Server Protocol
 * intelligence to the Hernex agent engine.
 *
 * **Registration (opt-in — not in default tool suite):**
 * ```typescript
 * const registry = new ToolRegistry({ includeDefaults: true });
 * registry.register(new LspTool());                      // default 10 servers
 * registry.register(new LspTool(customLspConfig));       // custom server map
 * ```
 *
 * **Config priority:** If `lsps` is provided to the constructor it is used
 * exclusively; otherwise {@link defaultLspConfig} is used as a fallback.
 * Both configs are plain objects — no env vars, no ambient globals.
 *
 * **Process lifecycle:** Each `execute()` call owns the full LSP process
 * lifecycle (spawn → initialize → operation → shutdown → exit). Zero lingering
 * processes between calls.
 *
 * @example
 * ```typescript
 * import { LspTool, type LspConfig } from "@amaranthic/hernex";
 *
 * // With a custom config that only enables TypeScript:
 * const config: LspConfig = {
 *   typescript: {
 *     command: "typescript-language-server",
 *     args: ["--stdio"],
 *     extensions: [".ts", ".tsx"],
 *   },
 * };
 *
 * const lsp = new LspTool(config);
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

  /**
   * The resolved LSP configuration used by this tool instance.
   * Stored as a readonly reference — never mutated after construction.
   */
  private readonly resolvedConfig: LspConfig;

  /**
   * Constructs a new `LspTool` instance.
   *
   * @param lsps - Optional LSP server configuration map. When omitted,
   *   {@link defaultLspConfig} is used (10 built-in server entries covering
   *   TypeScript, Python, Rust, Go, C/C++, JSON, HTML, CSS, YAML, and Shell).
   *
   * @example
   * ```typescript
   * // Default config (10 built-in servers):
   * const lsp = new LspTool();
   *
   * // Custom config:
   * const lsp = new LspTool({
   *   typescript: {
   *     command: "typescript-language-server",
   *     args: ["--stdio"],
   *     extensions: [".ts", ".tsx", ".js"],
   *   },
   * });
   * ```
   */
  public constructor(lsps?: LspConfig) {
    this.resolvedConfig = lsps ?? defaultLspConfig;
  }

  /**
   * Executes the requested LSP operation against the matching language server.
   *
   * Spawns the LSP server binary, runs the full LSP handshake, dispatches the
   * operation, tears down the process, and returns the result as formatted
   * markdown. On any error (missing binary, timeout, server crash, path guard
   * violation, etc.) returns a plain-text error description rather than
   * throwing, so the agent engine always receives a usable tool result.
   *
   * @param parameters - Validated input parameters from the model.
   * @param context - Execution context supplying `workingDirectory` and optional `abortSignal`.
   * @returns A promise resolving to a markdown string with the operation result,
   *          or a plain-text `"LSP error: ..."` description on failure.
   *
   * @example
   * ```typescript
   * const output = await lspTool.execute(
   *   { operation: "diagnostics", filePath: "src/index.ts", line: 1, character: 1 },
   *   { threadId: "t1", toolCallId: "c1", workingDirectory: "/home/user/project" },
   * );
   * console.log(output);
   * // **Diagnostics**
   * // **Error** (2)
   * //   - `src/index.ts:14:3` [typescript] — Cannot find name 'foo'.
   * ```
   */
  public async execute(
    parameters: LspInput,
    context: ToolExecutionContext,
  ): Promise<string> {
    const result = await runLspRequest({
      filePath: parameters.filePath,
      operation: parameters.operation,
      line: parameters.line,
      character: parameters.character,
      query: parameters.query,
      workingDirectory: context.workingDirectory,
      config: this.resolvedConfig,
      timeoutMs: DEFAULT_LSP_TIMEOUT_MS,
    });

    if (!result.ok) {
      return `LSP error: ${result.error}`;
    }

    return result.markdown;
  }
}
