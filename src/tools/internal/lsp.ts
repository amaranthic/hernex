/**
 * @fileoverview On-demand Language Server Protocol engine for Hernex.
 *
 * Implements the LSP JSON-RPC wire protocol from scratch over stdio — no
 * external vscode or jsonrpc packages. Each call to {@link runLspRequest}
 * spawns the configured language server binary, executes exactly one
 * operation (initialize → didOpen → request → shutdown → exit), then exits
 * cleanly. Zero lingering processes.
 *
 * Wire format (per LSP spec §3.1):
 *   `Content-Length: <byteLen>\r\n\r\n<utf-8 json body>`
 *
 * @packageDocumentation
 */

import { execFile, spawn } from "node:child_process";
import { stat } from "node:fs/promises";
import { extname, relative } from "node:path";
import { pathToFileURL } from "node:url";
import { resolvePathWithinWorkspace } from "./pathGuard.js";

// ─────────────────────────────────────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Maximum file size (in bytes) accepted for `textDocument/didOpen`.
 * Files larger than this are rejected before spawning the LSP server.
 */
const MAX_FILE_BYTES = 10 * 1024 * 1024; // 10 MB

/**
 * Default per-request timeout in milliseconds.
 */
export const DEFAULT_LSP_TIMEOUT_MS = 5_000;

/**
 * LSP JSON-RPC error code emitted when a request is cancelled because the
 * document was modified while the server was processing it. Retryable.
 */
const CODE_CONTENT_MODIFIED = -32801;

/**
 * Maximum number of automatic retries for `ContentModified` (-32801) errors.
 */
const MAX_RETRIES = 3;

/**
 * Base delay (ms) for exponential backoff on retryable errors.
 * Actual delays: 500 → 1000 → 2000 ms.
 */
const RETRY_BASE_DELAY_MS = 500;

/**
 * Milliseconds to wait for the LSP server process to exit cleanly after
 * sending `shutdown` + `exit` before issuing SIGKILL.
 */
const TEARDOWN_GRACE_MS = 1_500;

/**
 * Timeout (ms) used specifically for the `shutdown` request during teardown.
 * Shorter than the normal request timeout to avoid stalling on a dying server.
 */
const SHUTDOWN_TIMEOUT_MS = 2_000;

// ─────────────────────────────────────────────────────────────────────────────
// LSP Symbol kind labels (LSP spec §3.16.3 — SymbolKind enum)
// ─────────────────────────────────────────────────────────────────────────────

const SYMBOL_KIND_LABELS: Readonly<Record<number, string>> = {
  1: "File",
  2: "Module",
  3: "Namespace",
  4: "Package",
  5: "Class",
  6: "Method",
  7: "Property",
  8: "Field",
  9: "Constructor",
  10: "Enum",
  11: "Interface",
  12: "Function",
  13: "Variable",
  14: "Constant",
  15: "String",
  16: "Number",
  17: "Boolean",
  18: "Array",
  19: "Object",
  20: "Key",
  21: "Null",
  22: "EnumMember",
  23: "Struct",
  24: "Event",
  25: "Operator",
  26: "TypeParameter",
};

/**
 * LSP DiagnosticSeverity values (LSP spec §3.16.1).
 */
const DIAGNOSTIC_SEVERITY_LABELS: Readonly<Record<number, string>> = {
  1: "Error",
  2: "Warning",
  3: "Information",
  4: "Hint",
};

// ─────────────────────────────────────────────────────────────────────────────
// Extension → LSP languageId lookup (internal — not user-configurable)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Maps file extensions to their canonical LSP `languageId` strings.
 * This table is internal; callers never configure it.
 */
const EXTENSION_TO_LANGUAGE_ID: Readonly<Record<string, string>> = {
  ".ts": "typescript",
  ".tsx": "typescriptreact",
  ".js": "javascript",
  ".jsx": "javascriptreact",
  ".mjs": "javascript",
  ".cjs": "javascript",
  ".py": "python",
  ".pyi": "python",
  ".rs": "rust",
  ".go": "go",
  ".c": "c",
  ".h": "c",
  ".cpp": "cpp",
  ".cc": "cpp",
  ".cxx": "cpp",
  ".hpp": "cpp",
  ".json": "json",
  ".jsonc": "jsonc",
  ".html": "html",
  ".htm": "html",
  ".css": "css",
  ".scss": "scss",
  ".less": "less",
  ".yaml": "yaml",
  ".yml": "yaml",
  ".sh": "shellscript",
  ".bash": "shellscript",
};

// ─────────────────────────────────────────────────────────────────────────────
// Public config types
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Configuration for a single LSP server binary.
 *
 * @example
 * ```typescript
 * const tsConfig: LspServerConfig = {
 *   command: "typescript-language-server",
 *   args: ["--stdio"],
 *   extensions: [".ts", ".tsx", ".js", ".jsx"],
 * };
 * ```
 */
export interface LspServerConfig {
  /**
   * The executable name or absolute path of the LSP server binary.
   * Must be resolvable on the system `PATH` or be an absolute path.
   */
  readonly command: string;

  /**
   * Optional command-line arguments to pass to the binary.
   * Most servers require `["--stdio"]` to enable stdio transport.
   */
  readonly args?: readonly string[] | undefined;

  /**
   * File extensions this server handles (e.g. `[".ts", ".tsx"]`).
   * Each extension must start with a dot. Mandatory — no default.
   */
  readonly extensions: readonly string[];

  /**
   * Optional extra environment variables to merge into the server's process
   * environment. Merged on top of the sanitized safe environment.
   */
  readonly env?: Readonly<Record<string, string>> | undefined;
}

/**
 * A flat map of server name → server configuration.
 * When multiple entries claim the same extension, the first one wins
 * (iteration order of the object).
 *
 * @example
 * ```typescript
 * const config: LspConfig = {
 *   typescript: { command: "typescript-language-server", args: ["--stdio"], extensions: [".ts"] },
 *   python:     { command: "pyright-langserver",         args: ["--stdio"], extensions: [".py"] },
 * };
 * ```
 */
export type LspConfig = Readonly<Record<string, LspServerConfig>>;

/**
 * The seven LSP operations the model can invoke via {@link LspTool}.
 */
export type LspOperation =
  | "hover"
  | "goToDefinition"
  | "goToImplementation"
  | "findReferences"
  | "documentSymbol"
  | "workspaceSymbol"
  | "diagnostics";

/**
 * Options for a single on-demand LSP request.
 */
export interface LspRequestOptions {
  /**
   * Absolute or workspace-relative path of the file to query.
   * Resolved and security-checked before the server is spawned.
   */
  readonly filePath: string;

  /** The LSP operation to perform. */
  readonly operation: LspOperation;

  /**
   * 1-based line number. Converted to 0-based before writing LSP frames.
   * Ignored for `documentSymbol`, `workspaceSymbol`, and `diagnostics`.
   */
  readonly line: number;

  /**
   * 1-based character offset. Converted to 0-based before writing LSP frames.
   * Ignored for `documentSymbol`, `workspaceSymbol`, and `diagnostics`.
   */
  readonly character: number;

  /**
   * Search query string; required only for `workspaceSymbol`.
   * Silently treated as `""` for other operations.
   */
  readonly query?: string | undefined;

  /**
   * Absolute path of the workspace root used for path containment checks
   * and for constructing the `rootUri` passed to the LSP server.
   */
  readonly workingDirectory: string;

  /**
   * Optional config override. When omitted, {@link defaultLspConfig} is used.
   */
  readonly config?: LspConfig | undefined;

  /**
   * Per-request timeout in milliseconds. Defaults to {@link DEFAULT_LSP_TIMEOUT_MS}.
   */
  readonly timeoutMs?: number | undefined;
}

/**
 * Discriminated result returned by {@link runLspRequest}.
 */
export type LspResult =
  | { readonly ok: true; readonly markdown: string }
  | { readonly ok: false; readonly error: string };

// ─────────────────────────────────────────────────────────────────────────────
// Default LSP configurations (10 servers covering the most common languages)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Built-in LSP server configurations covering the ten most common languages.
 *
 * Used when {@link LspRequestOptions.config} is not provided.
 * All binaries must be installed separately on the host system.
 *
 * | Key           | Binary                            | Extensions                                |
 * |---------------|-----------------------------------|-------------------------------------------|
 * | typescript    | typescript-language-server        | .ts .tsx .js .jsx .mjs .cjs               |
 * | python        | pyright-langserver                | .py .pyi                                  |
 * | rust          | rust-analyzer                     | .rs                                       |
 * | go            | gopls                             | .go                                       |
 * | clangd        | clangd                            | .c .cpp .cc .cxx .h .hpp                  |
 * | json          | vscode-json-language-server       | .json .jsonc                              |
 * | html          | vscode-html-language-server       | .html .htm                                |
 * | css           | vscode-css-language-server        | .css .scss .less                          |
 * | yaml          | yaml-language-server              | .yaml .yml                                |
 * | shell         | bash-language-server              | .sh .bash                                 |
 */
export const defaultLspConfig: LspConfig = {
  typescript: {
    command: "typescript-language-server",
    args: ["--stdio"],
    extensions: [".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"],
  },
  python: {
    command: "pyright-langserver",
    args: ["--stdio"],
    extensions: [".py", ".pyi"],
  },
  rust: {
    command: "rust-analyzer",
    extensions: [".rs"],
  },
  go: {
    command: "gopls",
    extensions: [".go"],
  },
  clangd: {
    command: "clangd",
    args: ["--background-index"],
    extensions: [".c", ".cpp", ".cc", ".cxx", ".h", ".hpp"],
  },
  json: {
    command: "vscode-json-language-server",
    args: ["--stdio"],
    extensions: [".json", ".jsonc"],
  },
  html: {
    command: "vscode-html-language-server",
    args: ["--stdio"],
    extensions: [".html", ".htm"],
  },
  css: {
    command: "vscode-css-language-server",
    args: ["--stdio"],
    extensions: [".css", ".scss", ".less"],
  },
  yaml: {
    command: "yaml-language-server",
    args: ["--stdio"],
    extensions: [".yaml", ".yml"],
  },
  shell: {
    command: "bash-language-server",
    args: ["start"],
    extensions: [".sh", ".bash"],
  },
};

// ─────────────────────────────────────────────────────────────────────────────
// Internal JSON-RPC message types (wire shapes, not exported)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * JSON-RPC 2.0 error object embedded in a response.
 * @internal
 */
interface JsonRpcError {
  readonly code: number;
  readonly message: string;
  readonly data?: unknown;
}

/**
 * A JSON-RPC 2.0 request (has `id`).
 * @internal
 */
interface JsonRpcRequest {
  readonly jsonrpc: "2.0";
  readonly id: number;
  readonly method: string;
  readonly params: unknown;
}

/**
 * A JSON-RPC 2.0 notification (no `id`).
 * @internal
 */
interface JsonRpcNotification {
  readonly jsonrpc: "2.0";
  readonly method: string;
  readonly params: unknown;
}

/**
 * A JSON-RPC 2.0 response (has `id` + `result` or `error`).
 * @internal
 */
interface JsonRpcResponse {
  readonly jsonrpc: "2.0";
  readonly id: number;
  readonly result?: unknown;
  readonly error?: JsonRpcError;
}

/** Union of all valid JSON-RPC message shapes. @internal */
type JsonRpcMessage = JsonRpcRequest | JsonRpcNotification | JsonRpcResponse;

// ─────────────────────────────────────────────────────────────────────────────
// Minimal LSP wire-shape types (from LSP spec — no package)
// ─────────────────────────────────────────────────────────────────────────────

/** LSP Position (0-based). @internal */
interface LspPosition {
  readonly line: number;
  readonly character: number;
}

/** LSP Range. @internal */
interface LspRange {
  readonly start: LspPosition;
  readonly end: LspPosition;
}

/** LSP Location. @internal */
interface LspLocation {
  readonly uri: string;
  readonly range: LspRange;
}

/** LSP LocationLink. @internal */
interface LspLocationLink {
  readonly targetUri: string;
  readonly targetRange: LspRange;
  readonly targetSelectionRange: LspRange;
  readonly originSelectionRange?: LspRange | undefined;
}

/** LSP MarkupContent. @internal */
interface LspMarkupContent {
  readonly kind: "plaintext" | "markdown";
  readonly value: string;
}

/** LSP MarkedString. @internal */
type LspMarkedString =
  string | { readonly language: string; readonly value: string };

/** LSP Hover result. @internal */
interface LspHover {
  readonly contents:
    LspMarkupContent | LspMarkedString | readonly LspMarkedString[];
  readonly range?: LspRange | undefined;
}

/** LSP DocumentSymbol (tree node). @internal */
interface LspDocumentSymbol {
  readonly name: string;
  readonly kind: number;
  readonly range: LspRange;
  readonly selectionRange: LspRange;
  readonly detail?: string | undefined;
  readonly children?: readonly LspDocumentSymbol[] | undefined;
}

/** LSP SymbolInformation (flat). @internal */
interface LspSymbolInformation {
  readonly name: string;
  readonly kind: number;
  readonly location: LspLocation;
  readonly containerName?: string | undefined;
}

/** LSP Diagnostic. @internal */
interface LspDiagnostic {
  readonly range: LspRange;
  readonly severity?: number | undefined;
  readonly message: string;
  readonly source?: string | undefined;
  readonly code?: string | number | undefined;
}

/** LSP publishDiagnostics params. @internal */
interface LspPublishDiagnosticsParams {
  readonly uri: string;
  readonly diagnostics: readonly LspDiagnostic[];
}

// ─────────────────────────────────────────────────────────────────────────────
// Frame reader
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Handle returned by {@link createFrameReader}.
 * @internal
 */
interface FrameReader {
  /**
   * Registers a handler for every fully-decoded JSON-RPC message.
   * Only one handler may be registered at a time; calling this again
   * silently replaces the previous one.
   *
   * @param handler - Called synchronously as each complete frame is decoded.
   */
  onMessage(handler: (msg: JsonRpcMessage) => void): void;

  /**
   * Removes the data listener from the readable stream and clears the buffer.
   * Must be called in teardown to prevent memory leaks.
   */
  dispose(): void;
}

/**
 * Creates a stateful LSP frame reader attached to a readable stream.
 *
 * Accumulates incoming `Buffer` chunks, parses `Content-Length` headers,
 * and emits one decoded {@link JsonRpcMessage} per complete frame.
 * Malformed JSON is swallowed and logged to `stderr` without crashing the
 * process — the caller handles the resulting missing response via timeout.
 *
 * @param readable - The `stdout` stream of the spawned LSP server process.
 * @returns A {@link FrameReader} handle for handler registration and cleanup.
 *
 * @internal
 */
function createFrameReader(readable: NodeJS.ReadableStream): FrameReader {
  let accumulator = Buffer.alloc(0);
  let messageHandler: ((msg: JsonRpcMessage) => void) | null = null;

  function tryDecode(): void {
    // Loop so we consume multiple buffered frames in a single call.
    while (true) {
      // Find the header terminator \r\n\r\n
      const separatorIndex = accumulator.indexOf("\r\n\r\n");
      if (separatorIndex === -1) {
        // Header not yet complete — wait for more data.
        break;
      }

      const headerBlock = accumulator
        .slice(0, separatorIndex)
        .toString("ascii");
      let contentLength = -1;

      for (const line of headerBlock.split("\r\n")) {
        // Case-insensitive per HTTP/LSP spec; most servers send exact casing.
        const match = /^content-length:\s*(\d+)$/i.exec(line);
        if (match !== null) {
          const parsed = parseInt(match[1] ?? "0", 10);
          if (!isNaN(parsed) && parsed >= 0) {
            contentLength = parsed;
          }
          break;
        }
      }

      if (contentLength === -1) {
        // Protocol violation — no Content-Length in header block.
        // Cannot recover; drain the accumulator to unblock.
        process.stderr.write(
          "[hernex/lsp] Frame missing Content-Length header; discarding frame.\n",
        );
        accumulator = Buffer.alloc(0);
        break;
      }

      const bodyStart = separatorIndex + 4; // skip \r\n\r\n

      if (accumulator.length < bodyStart + contentLength) {
        // Body not yet fully received — wait for more data.
        break;
      }

      const bodyBytes = accumulator.slice(bodyStart, bodyStart + contentLength);
      // Advance the accumulator past this frame.
      accumulator = accumulator.slice(bodyStart + contentLength);

      let parsed: unknown;
      try {
        parsed = JSON.parse(bodyBytes.toString("utf8")) as unknown;
      } catch {
        process.stderr.write(
          "[hernex/lsp] Failed to parse JSON frame body; skipping.\n",
        );
        // Continue loop — there may be more valid frames buffered.
        continue;
      }

      if (
        messageHandler !== null &&
        typeof parsed === "object" &&
        parsed !== null
      ) {
        messageHandler(parsed as JsonRpcMessage);
      }
    }
  }

  const dataListener = (chunk: Buffer): void => {
    accumulator = Buffer.concat([accumulator, chunk]);
    tryDecode();
  };

  readable.on("data", dataListener);

  return {
    onMessage(handler: (msg: JsonRpcMessage) => void): void {
      messageHandler = handler;
    },
    dispose(): void {
      readable.removeListener("data", dataListener);
      accumulator = Buffer.alloc(0);
      messageHandler = null;
    },
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Frame writer
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Encodes a JSON-RPC message into an LSP wire frame and writes it to the
 * given writable stream (the LSP server's stdin).
 *
 * Format: `Content-Length: <byteLen>\r\n\r\n<utf8 body>`
 *
 * @param writable - The `stdin` stream of the spawned LSP server process.
 * @param msg - The JSON-RPC message to encode and send.
 *
 * @internal
 */
function writeFrame(
  writable: NodeJS.WritableStream,
  msg: JsonRpcMessage,
): void {
  const body = JSON.stringify(msg);
  const byteLength = Buffer.byteLength(body, "utf8");
  writable.write(`Content-Length: ${byteLength}\r\n\r\n${body}`, "utf8");
}

// ─────────────────────────────────────────────────────────────────────────────
// Utilities
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Returns a promise that resolves after `ms` milliseconds.
 *
 * @param ms - Duration to sleep in milliseconds.
 * @internal
 */
function sleep(ms: number): Promise<void> {
  return new Promise<void>((resolve) => setTimeout(resolve, ms));
}

/**
 * Checks whether a binary name is resolvable on the system `PATH` by running
 * `which <command>`. Returns `true` if found, `false` if not.
 *
 * Uses `execFile` (not `exec`) to avoid shell injection from `command`.
 *
 * @param command - The binary name or absolute path to check.
 * @returns Promise resolving to `true` if the binary is accessible.
 *
 * @internal
 */
function isBinaryOnPath(command: string): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    execFile("which", [command], (error) => {
      resolve(error === null);
    });
  });
}

/**
 * Builds a reverse lookup from each file extension to the first
 * {@link LspServerConfig} entry in `config` that claims it.
 *
 * @param config - The resolved LSP config to index.
 * @returns A `Map` from extension (e.g. `".ts"`) to the matching config entry.
 *
 * @internal
 */
function buildExtensionMap(config: LspConfig): Map<string, LspServerConfig> {
  const map = new Map<string, LspServerConfig>();
  for (const serverConfig of Object.values(config)) {
    for (const ext of serverConfig.extensions) {
      if (!map.has(ext)) {
        map.set(ext, serverConfig);
      }
    }
  }
  return map;
}

/**
 * Converts a file URI (`file:///abs/path`) to an absolute filesystem path.
 * Used when converting LSP Location URIs back to display paths.
 *
 * @param uri - The `file://` URI to convert.
 * @returns The decoded absolute filesystem path, or the original URI string
 *          if it is not a `file://` URI (e.g. `untitled://...`).
 *
 * @internal
 */
function fileUriToPath(uri: string): string {
  if (!uri.startsWith("file://")) {
    return uri;
  }
  try {
    return new URL(uri).pathname;
  } catch {
    return uri;
  }
}

/**
 * Formats a 0-based LSP {@link LspPosition} as a human-readable 1-based
 * `line:col` string.
 *
 * @param pos - The LSP position with 0-based line and character.
 * @returns A `"<line>:<col>"` string with 1-based values.
 *
 * @internal
 */
function formatPosition(pos: LspPosition): string {
  return `${pos.line + 1}:${pos.character + 1}`;
}

/**
 * Renders a file URI as a workspace-relative path with an optional position
 * suffix, e.g. `src/tools/BashTool.ts:42:10`.
 *
 * @param uri - The `file://` URI from an LSP Location.
 * @param workingDirectory - The workspace root used for relativisation.
 * @param pos - Optional 0-based LSP position to append.
 * @returns A compact relative `path[:line:col]` string.
 *
 * @internal
 */
function formatLocation(
  uri: string,
  workingDirectory: string,
  pos?: LspPosition,
): string {
  const absPath = fileUriToPath(uri);
  const rel = relative(workingDirectory, absPath) || absPath;
  return pos !== undefined ? `${rel}:${formatPosition(pos)}` : rel;
}

// ─────────────────────────────────────────────────────────────────────────────
// Result formatters (operation → markdown string)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Extracts plain text from LSP hover `contents`, which may be a
 * {@link LspMarkupContent}, a {@link LspMarkedString}, or an array thereof.
 *
 * @param contents - The raw `contents` field from the LSP hover response.
 * @returns A flat string suitable for markdown output.
 *
 * @internal
 */
function extractHoverText(
  contents: LspMarkupContent | LspMarkedString | readonly LspMarkedString[],
): string {
  if (typeof contents === "string") {
    return contents;
  }
  if (Array.isArray(contents)) {
    return (contents as readonly LspMarkedString[])
      .map((c) =>
        typeof c === "string" ? c : `\`\`\`${c.language}\n${c.value}\n\`\`\``,
      )
      .join("\n\n");
  }
  // LspMarkupContent or { language, value }
  if ("kind" in contents) {
    return contents.value;
  }
  if ("language" in contents && "value" in contents) {
    return `\`\`\`${contents.language}\n${contents.value}\n\`\`\``;
  }
  return String(contents);
}

/**
 * Normalises a `textDocument/definition`, `textDocument/implementation`, or
 * `textDocument/references` result into an array of {@link LspLocation}
 * objects regardless of whether the server returned a single Location,
 * an array of Locations, or an array of LocationLinks.
 *
 * @param raw - The raw `result` from the LSP response.
 * @returns An array of normalised {@link LspLocation} objects.
 *
 * @internal
 */
function normaliseLocations(raw: unknown): LspLocation[] {
  if (raw === null || raw === undefined) {
    return [];
  }
  // Single Location object: { uri, range }
  if (
    typeof raw === "object" &&
    !Array.isArray(raw) &&
    "uri" in raw &&
    "range" in raw
  ) {
    return [raw as LspLocation];
  }
  if (!Array.isArray(raw)) {
    return [];
  }
  const locations: LspLocation[] = [];
  for (const item of raw as unknown[]) {
    if (typeof item !== "object" || item === null) continue;
    if ("uri" in item && "range" in item) {
      // Location
      locations.push(item as LspLocation);
    } else if ("targetUri" in item && "targetSelectionRange" in item) {
      // LocationLink
      const link = item as LspLocationLink;
      locations.push({
        uri: link.targetUri,
        range: link.targetSelectionRange,
      });
    }
  }
  return locations;
}

/**
 * Formats hover results into a compact markdown code block.
 *
 * @param raw - The raw `result` from `textDocument/hover`.
 * @returns Formatted markdown string, or `"No hover information."`.
 *
 * @internal
 */
function formatHover(raw: unknown): string {
  if (raw === null || raw === undefined) {
    return "No hover information.";
  }
  const hover = raw as LspHover;
  const text = extractHoverText(hover.contents).trim();
  if (text.length === 0) {
    return "No hover information.";
  }
  return `**Hover**\n\n${text}`;
}

/**
 * Formats definition / implementation / references results into a markdown
 * bullet list of `path:line:col` locations.
 *
 * @param raw - The raw `result` from the LSP response.
 * @param header - Section heading (e.g. `"Definitions"`).
 * @param workingDirectory - Workspace root for relative path rendering.
 * @returns Formatted markdown string.
 *
 * @internal
 */
function formatLocations(
  raw: unknown,
  header: string,
  workingDirectory: string,
): string {
  const locations = normaliseLocations(raw);
  if (locations.length === 0) {
    return `No ${header.toLowerCase()}.`;
  }
  const lines = locations.map(
    (loc) => `- ${formatLocation(loc.uri, workingDirectory, loc.range.start)}`,
  );
  return `**${header}**\n\n${lines.join("\n")}`;
}

/**
 * Recursively renders a {@link LspDocumentSymbol} tree as an indented
 * markdown list.
 *
 * @param symbols - Array of document symbols (may be nested).
 * @param indent - Current indentation prefix string.
 * @returns Lines of the rendered tree.
 *
 * @internal
 */
function renderDocumentSymbolTree(
  symbols: readonly LspDocumentSymbol[],
  indent: string,
): string[] {
  const lines: string[] = [];
  for (const sym of symbols) {
    const kindLabel = SYMBOL_KIND_LABELS[sym.kind] ?? `Kind(${sym.kind})`;
    const detail = sym.detail !== undefined ? ` — ${sym.detail}` : "";
    const pos = formatPosition(sym.selectionRange.start);
    lines.push(
      `${indent}- **${sym.name}** \`${kindLabel}\`${detail} ·\u202F\`${pos}\``,
    );
    if (sym.children !== undefined && sym.children.length > 0) {
      lines.push(...renderDocumentSymbolTree(sym.children, `${indent}  `));
    }
  }
  return lines;
}

/**
 * Formats `textDocument/documentSymbol` results into a markdown tree.
 * The server may return {@link LspDocumentSymbol}[] (hierarchical) or
 * {@link LspSymbolInformation}[] (flat) — both are handled.
 *
 * @param raw - The raw `result` from `textDocument/documentSymbol`.
 * @param workingDirectory - Workspace root (used for flat SymbolInformation).
 * @returns Formatted markdown string.
 *
 * @internal
 */
function formatDocumentSymbol(raw: unknown, workingDirectory: string): string {
  if (!Array.isArray(raw) || raw.length === 0) {
    return "No symbols found.";
  }

  const first = raw[0];
  if (
    typeof first === "object" &&
    first !== null &&
    "selectionRange" in first
  ) {
    // DocumentSymbol[] — hierarchical
    const symbols = raw as LspDocumentSymbol[];
    const lines = renderDocumentSymbolTree(symbols, "");
    return `**Document Symbols**\n\n${lines.join("\n")}`;
  }

  // SymbolInformation[] — flat (older LSP servers)
  const symbols = raw as LspSymbolInformation[];
  const lines = symbols.map((sym) => {
    const kindLabel = SYMBOL_KIND_LABELS[sym.kind] ?? `Kind(${sym.kind})`;
    const loc = formatLocation(
      sym.location.uri,
      workingDirectory,
      sym.location.range.start,
    );
    const container =
      sym.containerName !== undefined ? ` _(${sym.containerName})_` : "";
    return `- **${sym.name}** \`${kindLabel}\`${container} · \`${loc}\``;
  });
  return `**Document Symbols**\n\n${lines.join("\n")}`;
}

/**
 * Formats `workspace/symbol` results into a markdown list.
 *
 * @param raw - The raw `result` from `workspace/symbol`.
 * @param workingDirectory - Workspace root for relative path rendering.
 * @returns Formatted markdown string.
 *
 * @internal
 */
function formatWorkspaceSymbol(raw: unknown, workingDirectory: string): string {
  if (!Array.isArray(raw) || raw.length === 0) {
    return "No workspace symbols found.";
  }
  const symbols = raw as LspSymbolInformation[];
  const lines = symbols.slice(0, 100).map((sym) => {
    const kindLabel = SYMBOL_KIND_LABELS[sym.kind] ?? `Kind(${sym.kind})`;
    const loc = formatLocation(
      sym.location.uri,
      workingDirectory,
      sym.location.range.start,
    );
    return `- \`${kindLabel}\` **${sym.name}** · \`${loc}\``;
  });
  const truncated =
    symbols.length > 100
      ? `\n\n_(${symbols.length - 100} more results omitted)_`
      : "";
  return `**Workspace Symbols**\n\n${lines.join("\n")}${truncated}`;
}

/**
 * Formats `textDocument/publishDiagnostics` notifications into a markdown
 * report grouped by severity.
 *
 * @param diagnostics - Collected diagnostics from the server notification.
 * @param fileUri - The file URI these diagnostics belong to.
 * @param workingDirectory - Workspace root for relative path rendering.
 * @returns Formatted markdown string.
 *
 * @internal
 */
function formatDiagnostics(
  diagnostics: readonly LspDiagnostic[],
  fileUri: string,
  workingDirectory: string,
): string {
  if (diagnostics.length === 0) {
    return "No diagnostics. File is clean.";
  }

  const relPath = formatLocation(fileUri, workingDirectory);

  // Group by severity (1=Error, 2=Warning, 3=Information, 4=Hint, undefined=Unknown)
  const grouped = new Map<number, LspDiagnostic[]>();
  for (const diag of diagnostics) {
    const sev = diag.severity ?? 1;
    let bucket = grouped.get(sev);
    if (bucket === undefined) {
      bucket = [];
      grouped.set(sev, bucket);
    }
    bucket.push(diag);
  }

  const sections: string[] = [];
  for (const [sev, items] of [...grouped.entries()].sort(([a], [b]) => a - b)) {
    const label = DIAGNOSTIC_SEVERITY_LABELS[sev] ?? "Unknown";
    const lines = items.map((d) => {
      const pos = formatPosition(d.range.start);
      const src = d.source !== undefined ? ` [${d.source}]` : "";
      const code = d.code !== undefined ? ` (${String(d.code)})` : "";
      return `  - \`${relPath}:${pos}\`${src}${code} — ${d.message}`;
    });
    sections.push(`**${label}** (${items.length})\n${lines.join("\n")}`);
  }

  return `**Diagnostics**\n\n${sections.join("\n\n")}`;
}

// ─────────────────────────────────────────────────────────────────────────────
// Main exported function
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Executes a single on-demand LSP operation against the appropriate language
 * server for the given file.
 *
 * **Lifecycle per call:**
 * 1. Validate inputs (path guard, file size, binary presence).
 * 2. Spawn the LSP server with sanitized stdio.
 * 3. Await the `'spawn'` event before writing any frames.
 * 4. Perform the LSP handshake: `initialize` → `initialized`.
 * 5. Send `textDocument/didOpen`.
 * 6. Dispatch the requested operation (with retry on `-32801`).
 * 7. Teardown: `shutdown` → `exit` → drain → SIGKILL if needed.
 * 8. Return a `{ ok: true, markdown }` or `{ ok: false, error }` result.
 *
 * @param options - Request parameters; see {@link LspRequestOptions}.
 * @returns A promise resolving to an {@link LspResult}.
 *
 * @example
 * ```typescript
 * const result = await runLspRequest({
 *   filePath: "src/index.ts",
 *   operation: "hover",
 *   line: 12,
 *   character: 8,
 *   workingDirectory: "/home/user/myproject",
 * });
 * if (result.ok) {
 *   console.log(result.markdown);
 * } else {
 *   console.error(result.error);
 * }
 * ```
 */
export async function runLspRequest(
  options: LspRequestOptions,
): Promise<LspResult> {
  const {
    operation,
    workingDirectory,
    query,
    timeoutMs = DEFAULT_LSP_TIMEOUT_MS,
  } = options;

  const resolvedConfig = options.config ?? defaultLspConfig;

  // ── Step 1: Resolve the file path (path containment guard) ────────────────

  let resolvedFilePath: string;
  try {
    resolvedFilePath = resolvePathWithinWorkspace(
      options.filePath,
      workingDirectory,
    );
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    return { ok: false, error: msg };
  }

  // ── Step 2: Determine the file extension and find the matching LSP server ──

  const ext = extname(resolvedFilePath).toLowerCase();
  const extensionMap = buildExtensionMap(resolvedConfig);
  const serverConfig = extensionMap.get(ext);

  if (serverConfig === undefined) {
    return {
      ok: false,
      error:
        `No LSP server configured for "${ext}" files. ` +
        `Add a server entry with \`extensions: ["${ext}"]\` to your LspConfig, ` +
        `or use the default config which covers .ts, .py, .rs, .go, .c, .cpp, ` +
        `.json, .html, .css, .yaml, and .sh.`,
    };
  }

  // ── Step 3: File stat (existence + size check) ────────────────────────────

  let fileStat: Awaited<ReturnType<typeof stat>>;
  try {
    fileStat = await stat(resolvedFilePath);
  } catch (err: unknown) {
    const code =
      typeof err === "object" && err !== null && "code" in err
        ? (err as { code: unknown }).code
        : undefined;
    if (code === "ENOENT") {
      return {
        ok: false,
        error: `File not found: ${options.filePath}`,
      };
    }
    const msg = err instanceof Error ? err.message : String(err);
    return { ok: false, error: `Failed to stat file: ${msg}` };
  }

  if (!fileStat.isFile()) {
    return {
      ok: false,
      error: `Path "${options.filePath}" is not a regular file.`,
    };
  }

  if (fileStat.size > MAX_FILE_BYTES) {
    const mb = (fileStat.size / (1024 * 1024)).toFixed(1);
    return {
      ok: false,
      error: `File "${options.filePath}" is ${mb} MB, which exceeds the 10 MB limit for LSP analysis.`,
    };
  }

  // ── Step 4: Binary presence check ─────────────────────────────────────────

  const binaryFound = await isBinaryOnPath(serverConfig.command);
  if (!binaryFound) {
    return {
      ok: false,
      error:
        `LSP server binary "${serverConfig.command}" was not found on PATH. ` +
        `Install it and ensure it is accessible before using this operation.`,
    };
  }

  // ── Step 5: Build the subprocess environment ───────────────────────────────
  // Inherit only the safe host variables (PATH, HOME, etc.) and merge in any
  // server-specific extras. We do not forward secrets or Hernex internals.

  const safeEnv: Record<string, string> = {};
  const SAFE_HOST_VARS = new Set([
    "PATH",
    "HOME",
    "USER",
    "LOGNAME",
    "SHELL",
    "LANG",
    "LC_ALL",
    "LC_CTYPE",
    "LC_MESSAGES",
    "TMPDIR",
    "TMP",
    "TEMP",
    "PWD",
    "EDITOR",
    "VISUAL",
    "PAGER",
    "NODE_PATH",
    "NODE_ENV",
    "XDG_RUNTIME_DIR",
    "XDG_CONFIG_HOME",
    "XDG_DATA_HOME",
  ]);
  const SENSITIVE_ENV_PATTERN =
    /(API_KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL|AUTH|HERNEX_HOME|GREG_)/i;

  for (const [key, value] of Object.entries(process.env)) {
    if (value === undefined) continue;
    if (SAFE_HOST_VARS.has(key) && !SENSITIVE_ENV_PATTERN.test(key)) {
      safeEnv[key] = value;
    }
  }

  if (serverConfig.env !== undefined) {
    for (const [key, value] of Object.entries(serverConfig.env)) {
      safeEnv[key] = value;
    }
  }

  // ── Step 6: Spawn the LSP server ──────────────────────────────────────────

  const args = serverConfig.args !== undefined ? [...serverConfig.args] : [];
  const proc = spawn(serverConfig.command, args, {
    stdio: ["pipe", "pipe", "pipe"],
    env: safeEnv,
    cwd: workingDirectory,
  });

  let processDead = false;
  let processExitCode: number | null = null;
  let processExitSignal: NodeJS.Signals | null = null;

  proc.on("exit", (code, signal) => {
    processDead = true;
    processExitCode = code;
    processExitSignal = signal;
  });

  // Collect stderr for diagnostics — never surface to model unless we re-throw.
  let stderrAccum = "";
  proc.stderr.on("data", (chunk: Buffer) => {
    stderrAccum += chunk.toString("utf8");
    // Cap stderr buffer to 8 KB to avoid unbounded memory growth.
    if (stderrAccum.length > 8192) {
      stderrAccum = stderrAccum.slice(stderrAccum.length - 8192);
    }
  });

  // ── Step 7: Await the 'spawn' event (guards against ENOENT at exec time) ──

  try {
    await new Promise<void>((resolve, reject) => {
      const spawnTimer = setTimeout(() => {
        reject(new Error("LSP server process did not emit 'spawn' within 5s."));
      }, 5_000);

      proc.once("spawn", () => {
        clearTimeout(spawnTimer);
        resolve();
      });

      proc.once("error", (err: NodeJS.ErrnoException) => {
        clearTimeout(spawnTimer);
        reject(err);
      });
    });
  } catch (spawnErr: unknown) {
    const msg = spawnErr instanceof Error ? spawnErr.message : String(spawnErr);
    return {
      ok: false,
      error: `Failed to start LSP server "${serverConfig.command}": ${msg}`,
    };
  }

  // ── Step 8: Set up frame reader and pending request registry ──────────────

  const frameReader = createFrameReader(proc.stdout);

  // Collected notifications (for diagnostics capture)
  const notifications: JsonRpcNotification[] = [];

  // Pending requests: id → { resolve, reject, timer }
  const pendingRequests = new Map<
    number,
    {
      resolve: (value: unknown) => void;
      reject: (reason: Error) => void;
      timer: ReturnType<typeof setTimeout>;
    }
  >();

  let nextId = 1;

  frameReader.onMessage((msg: JsonRpcMessage) => {
    if (processDead) return;

    // Determine message type by shape.
    if ("id" in msg && ("result" in msg || "error" in msg)) {
      // JSON-RPC Response
      const response = msg as JsonRpcResponse;
      const pending = pendingRequests.get(response.id);
      if (pending !== undefined) {
        clearTimeout(pending.timer);
        pendingRequests.delete(response.id);
        if (response.error !== undefined) {
          const rpcErr = new Error(
            `LSP error ${response.error.code}: ${response.error.message}`,
          );
          // Attach the code so retry logic can inspect it.
          (rpcErr as Error & { code: number }).code = response.error.code;
          pending.reject(rpcErr);
        } else {
          pending.resolve(response.result);
        }
      }
    } else if ("method" in msg && !("id" in msg)) {
      // JSON-RPC Notification
      notifications.push(msg as JsonRpcNotification);
    }
    // Requests from the server (e.g. window/showMessage) are intentionally ignored.
  });

  // ── Teardown helper (always runs) ─────────────────────────────────────────

  async function teardown(): Promise<void> {
    // Cancel all pending requests to unblock any awaiting callers.
    for (const [id, pending] of pendingRequests.entries()) {
      clearTimeout(pending.timer);
      pending.reject(new Error("LSP session terminated during teardown."));
      pendingRequests.delete(id);
    }

    if (!processDead) {
      // Send shutdown request (best-effort, short timeout).
      try {
        const shutdownId = nextId++;
        await new Promise<void>((resolve) => {
          const t = setTimeout(resolve, SHUTDOWN_TIMEOUT_MS);
          const shutdownMsg: JsonRpcRequest = {
            jsonrpc: "2.0",
            id: shutdownId,
            method: "shutdown",
            params: null,
          };
          pendingRequests.set(shutdownId, {
            resolve: () => {
              clearTimeout(t);
              resolve();
            },
            reject: () => {
              clearTimeout(t);
              resolve();
            }, // ignore shutdown errors
            timer: t,
          });
          writeFrame(proc.stdin, shutdownMsg);
        });
      } catch {
        // Ignore — server may already be exiting.
      }

      // Send exit notification.
      if (!processDead) {
        try {
          const exitNotif: JsonRpcNotification = {
            jsonrpc: "2.0",
            method: "exit",
            params: undefined,
          };
          writeFrame(proc.stdin, exitNotif);
          proc.stdin.end();
        } catch {
          // stdin may already be closed.
        }
      }

      // Wait for the process to exit with a grace period.
      await new Promise<void>((resolve) => {
        if (processDead) {
          resolve();
          return;
        }
        const graceTimer = setTimeout(() => {
          if (!processDead) {
            proc.kill("SIGKILL");
          }
          resolve();
        }, TEARDOWN_GRACE_MS);
        proc.once("exit", () => {
          clearTimeout(graceTimer);
          resolve();
        });
      });
    }

    frameReader.dispose();
  }

  // ── sendRequest helper ────────────────────────────────────────────────────

  /**
   * Sends a JSON-RPC request and returns a promise that resolves with the
   * `result` value, or rejects with an error on timeout, server error, or
   * process death.
   *
   * @param method - The JSON-RPC method name.
   * @param params - The method parameters.
   * @param overrideTimeoutMs - Override timeout for this specific request.
   * @internal
   */
  function sendRequest(
    method: string,
    params: unknown,
    overrideTimeoutMs?: number,
  ): Promise<unknown> {
    return new Promise<unknown>((resolve, reject) => {
      if (processDead) {
        reject(
          new Error(
            `LSP server exited (code ${String(processExitCode)}, signal ${String(processExitSignal)}) before "${method}" could be sent.`,
          ),
        );
        return;
      }

      const id = nextId++;
      const effectiveTimeout = overrideTimeoutMs ?? timeoutMs;

      const timer = setTimeout(() => {
        pendingRequests.delete(id);
        reject(
          new Error(
            `LSP request "${method}" timed out after ${effectiveTimeout}ms.`,
          ),
        );
      }, effectiveTimeout);

      pendingRequests.set(id, { resolve, reject, timer });

      const request: JsonRpcRequest = {
        jsonrpc: "2.0",
        id,
        method,
        params,
      };

      try {
        writeFrame(proc.stdin, request);
      } catch (writeErr: unknown) {
        clearTimeout(timer);
        pendingRequests.delete(id);
        const msg =
          writeErr instanceof Error ? writeErr.message : String(writeErr);
        reject(new Error(`Failed to write LSP frame for "${method}": ${msg}`));
      }
    });
  }

  /**
   * Sends a JSON-RPC notification (no response expected).
   *
   * @param method - The notification method name.
   * @param params - The notification parameters.
   * @internal
   */
  function sendNotification(method: string, params: unknown): void {
    if (processDead) return;
    const notif: JsonRpcNotification = {
      jsonrpc: "2.0",
      method,
      params,
    };
    try {
      writeFrame(proc.stdin, notif);
    } catch {
      // stdin may be closed — nothing to do.
    }
  }

  // ── Main operation flow ───────────────────────────────────────────────────

  try {
    // ── Step 9: initialize handshake ────────────────────────────────────────

    const rootUri = pathToFileURL(workingDirectory).href;

    await sendRequest("initialize", {
      processId: process.pid,
      rootUri,
      capabilities: {
        textDocument: {
          hover: { contentFormat: ["plaintext", "markdown"] },
          definition: {},
          references: {},
          implementation: {},
          documentSymbol: { hierarchicalDocumentSymbolSupport: true },
          publishDiagnostics: {
            versionSupport: false,
            relatedInformation: false,
          },
        },
        workspace: {
          symbol: { resolveSupport: { properties: [] } },
        },
      },
      workspaceFolders: null,
    });

    // ── Step 10: initialized notification ───────────────────────────────────

    sendNotification("initialized", {});

    // ── Step 11: textDocument/didOpen ────────────────────────────────────────
    // Read file contents synchronously — we already stat'd the file above and
    // know it is a regular file within the size limit.

    const { readFileSync } = await import("node:fs");
    const fileText = readFileSync(resolvedFilePath, "utf8");

    const textDocumentUri = pathToFileURL(resolvedFilePath).href;
    const languageId = EXTENSION_TO_LANGUAGE_ID[ext] ?? "plaintext";

    sendNotification("textDocument/didOpen", {
      textDocument: {
        uri: textDocumentUri,
        languageId,
        version: 1,
        text: fileText,
      },
    });

    // ── Step 12: Dispatch the operation (with retry for -32801) ─────────────

    // 0-based coordinates for LSP wire protocol.
    const lspLine = options.line - 1;
    const lspCharacter = options.character - 1;
    const positionParams = {
      textDocument: { uri: textDocumentUri },
      position: { line: lspLine, character: lspCharacter },
    };

    let operationResult: unknown;

    if (operation === "diagnostics") {
      // ── Diagnostics: send didSave, capture publishDiagnostics ─────────────
      //
      // Some servers emit diagnostics after didOpen; others only after didSave.
      // We send didSave to trigger a fresh analysis pass and wait up to
      // `timeoutMs` for `textDocument/publishDiagnostics` with a matching URI.

      sendNotification("textDocument/didSave", {
        textDocument: { uri: textDocumentUri },
      });

      const matchingDiags = await new Promise<LspPublishDiagnosticsParams>(
        (resolve) => {
          const deadline = setTimeout(() => {
            // Timeout — return whatever we have (even empty).
            resolve({ uri: textDocumentUri, diagnostics: [] });
          }, timeoutMs);

          // Check notifications already buffered before this point.
          const checkBuffered = (): boolean => {
            for (let i = notifications.length - 1; i >= 0; i--) {
              const n = notifications[i]!;
              if (
                n.method === "textDocument/publishDiagnostics" &&
                typeof n.params === "object" &&
                n.params !== null &&
                "uri" in n.params &&
                (n.params as { uri: string }).uri === textDocumentUri
              ) {
                clearTimeout(deadline);
                resolve(n.params as LspPublishDiagnosticsParams);
                return true;
              }
            }
            return false;
          };

          if (checkBuffered()) return;

          // Poll newly arriving notifications by wrapping the frame handler.
          const originalHandler = (msg: JsonRpcMessage): void => {
            if (
              "method" in msg &&
              !("id" in msg) &&
              msg.method === "textDocument/publishDiagnostics" &&
              typeof msg.params === "object" &&
              msg.params !== null &&
              "uri" in msg.params &&
              (msg.params as { uri: string }).uri === textDocumentUri
            ) {
              clearTimeout(deadline);
              resolve(msg.params as LspPublishDiagnosticsParams);
            }
          };

          frameReader.onMessage((msg: JsonRpcMessage) => {
            // Run the original routing (responses + generic notifications).
            if ("id" in msg && ("result" in msg || "error" in msg)) {
              const response = msg as JsonRpcResponse;
              const pending = pendingRequests.get(response.id);
              if (pending !== undefined) {
                clearTimeout(pending.timer);
                pendingRequests.delete(response.id);
                if (response.error !== undefined) {
                  const rpcErr = new Error(
                    `LSP error ${response.error.code}: ${response.error.message}`,
                  );
                  (rpcErr as Error & { code: number }).code =
                    response.error.code;
                  pending.reject(rpcErr);
                } else {
                  pending.resolve(response.result);
                }
              }
            } else if ("method" in msg && !("id" in msg)) {
              notifications.push(msg as JsonRpcNotification);
              originalHandler(msg);
            }
          });
        },
      );

      operationResult = formatDiagnostics(
        matchingDiags.diagnostics,
        textDocumentUri,
        workingDirectory,
      );
    } else {
      // ── All other operations: send the request with retry ──────────────────

      let lastError: Error | null = null;

      for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
        if (attempt > 0) {
          await sleep(RETRY_BASE_DELAY_MS * Math.pow(2, attempt - 1));
        }

        try {
          let raw: unknown;

          switch (operation) {
            case "hover":
              raw = await sendRequest("textDocument/hover", positionParams);
              operationResult = formatHover(raw);
              break;

            case "goToDefinition":
              raw = await sendRequest(
                "textDocument/definition",
                positionParams,
              );
              operationResult = formatLocations(
                raw,
                "Definitions",
                workingDirectory,
              );
              break;

            case "goToImplementation":
              raw = await sendRequest(
                "textDocument/implementation",
                positionParams,
              );
              operationResult = formatLocations(
                raw,
                "Implementations",
                workingDirectory,
              );
              break;

            case "findReferences":
              raw = await sendRequest("textDocument/references", {
                ...positionParams,
                context: { includeDeclaration: true },
              });
              operationResult = formatLocations(
                raw,
                "References",
                workingDirectory,
              );
              break;

            case "documentSymbol":
              raw = await sendRequest("textDocument/documentSymbol", {
                textDocument: { uri: textDocumentUri },
              });
              operationResult = formatDocumentSymbol(raw, workingDirectory);
              break;

            case "workspaceSymbol":
              raw = await sendRequest("workspace/symbol", {
                query: query ?? "",
              });
              operationResult = formatWorkspaceSymbol(raw, workingDirectory);
              break;
          }

          lastError = null;
          break; // Success — exit retry loop.
        } catch (err: unknown) {
          const isContentModified =
            err instanceof Error &&
            "code" in err &&
            (err as Error & { code: number }).code === CODE_CONTENT_MODIFIED;

          if (isContentModified && attempt < MAX_RETRIES) {
            lastError = err instanceof Error ? err : new Error(String(err));
            continue; // Retry.
          }

          // Non-retryable or exhausted retries — rethrow.
          throw err;
        }
      }

      if (lastError !== null) {
        throw lastError;
      }
    }

    // ── Success ───────────────────────────────────────────────────────────────

    const markdown =
      typeof operationResult === "string"
        ? operationResult
        : JSON.stringify(operationResult);

    return { ok: true, markdown };
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    return {
      ok: false,
      error: msg,
    };
  } finally {
    // ── Step 13: Teardown — always runs regardless of success or failure ─────
    await teardown();
  }
}
