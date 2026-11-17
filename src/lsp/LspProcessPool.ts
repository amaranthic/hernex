/**
 * @fileoverview Battle-hardened persistent process pool for LSP server instances.
 *
 * `LspProcessPool` maintains one {@link LspClient} per `(serverName, workingDirectory)`
 * pair. Features:
 *
 * - **Lazy spawn** — servers are only started when first needed.
 * - **Idle timeout** — inactive servers are torn down after a configurable
 *   period (default 5 minutes) to reclaim system resources.
 * - **Crash circuit breaker** — after `maxRestarts` consecutive crashes
 *   (default 3) the pool refuses further respawns and returns an error.
 * - **Global PID registry** — all spawned PIDs are tracked in a module-level
 *   set; `process.on("exit")` / `SIGINT` / `SIGTERM` hooks ensure no zombie
 *   processes survive the host process.
 * - **Per-instance isolation** — each `LspTool` instance owns its own pool;
 *   multiple `LspTool` instances with different server configs do not share
 *   state.
 *
 * @packageDocumentation
 */

import { existsSync } from "node:fs";
import { extname } from "node:path";
import { pathToFileURL } from "node:url";
import type {
  LspServerConfig,
  LspServersConfig,
  LspRequestOptions,
  LspPoolResult,
  LspDiagnostic,
} from "./types.js";
import { LspClient, type DiagnosticsHandler } from "./LspClient.js";

// ─────────────────────────────────────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────────────────────────────────────

/** Default idle timeout in ms (5 minutes). */
const DEFAULT_IDLE_TIMEOUT_MS = 300_000;

/** Default maximum crash-restart attempts before circuit breaks. */
const DEFAULT_MAX_RESTARTS = 3;

/** Default per-request timeout in ms. */
const DEFAULT_REQUEST_TIMEOUT_MS = 10_000;

// ─────────────────────────────────────────────────────────────────────────────
// Global PID registry — shared across all pool instances
// ─────────────────────────────────────────────────────────────────────────────

/** All PIDs currently managed by any `LspProcessPool` in this process. */
const globalPidRegistry = new Set<number>();

/**
 * Sends `SIGKILL` to every PID in the registry.
 * Called from process exit hooks to guarantee zero zombie LSP processes.
 */
function killAllTrackedPids(): void {
  for (const pid of globalPidRegistry) {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      /* process may already be dead */
    }
  }
  globalPidRegistry.clear();
}

// Register exit hooks exactly once using a module-level guard.
let hooksRegistered = false;

function ensureExitHooks(): void {
  if (hooksRegistered) return;
  hooksRegistered = true;
  process.on("exit", killAllTrackedPids);
  process.on("SIGINT", () => {
    killAllTrackedPids();
    process.exit(130);
  });
  process.on("SIGTERM", () => {
    killAllTrackedPids();
    process.exit(143);
  });
  process.on("beforeExit", killAllTrackedPids);
}

// ─────────────────────────────────────────────────────────────────────────────
// Pool entry
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Internal record for a single server slot in the pool.
 */
interface PoolEntry {
  /** Active client instance, or `null` if none is running. */
  client: LspClient | null;

  /** Number of consecutive crashes since last successful request. */
  crashCount: number;

  /**
   * Whether the circuit breaker is open.
   * When `true`, no further respawn is attempted.
   */
  circuitOpen: boolean;

  /** Handle for the idle-teardown timer. */
  idleTimer: ReturnType<typeof setTimeout> | null;

  /**
   * Latest diagnostics pushed by the server per file URI.
   * Keyed by `file://` URI.
   */
  diagnosticsCache: Map<string, LspDiagnostic[]>;
}

// ─────────────────────────────────────────────────────────────────────────────
// LspProcessPool
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Persistent process pool for a fixed set of LSP server configurations.
 *
 * One pool is created per `LspTool` instance. The pool is keyed by
 * `serverName + workingDirectory` so the same server config can serve
 * multiple workspace roots without process sharing.
 *
 * @example
 * ```typescript
 * const pool = new LspProcessPool({
 *   typescript: {
 *     command: "typescript-language-server",
 *     args: ["--stdio"],
 *     extensions: [".ts", ".tsx"],
 *   },
 * });
 *
 * const result = await pool.request({
 *   operation: "hover",
 *   filePath: "/home/user/project/src/index.ts",
 *   line: 12,
 *   character: 8,
 * }, "/home/user/project");
 *
 * await pool.dispose();
 * ```
 */
export class LspProcessPool {
  private readonly _servers: LspServersConfig;

  /**
   * Pool map keyed by `"serverName\0workingDirectory"`.
   * Using `\0` as a separator that cannot appear in either component.
   */
  private readonly _entries = new Map<string, PoolEntry>();

  /** Whether `dispose()` has been called on this pool instance. */
  private _disposed = false;

  /**
   * Constructs a new pool with the given server configurations.
   *
   * @param servers - Map of named server configs. No defaults are injected.
   */
  public constructor(servers: LspServersConfig) {
    this._servers = servers;
    ensureExitHooks();
  }

  // ── Public API ─────────────────────────────────────────────────────────────

  /**
   * Dispatches an LSP operation to the appropriate server and returns the
   * raw result or an error description.
   *
   * The method:
   * 1. Resolves which server handles the file's extension.
   * 2. Ensures the server is running (lazy-spawns if needed).
   * 3. Opens the file in the server (`textDocument/didOpen`).
   * 4. Builds and sends the LSP method call.
   * 5. Resets the idle timer.
   *
   * For `diagnostics`, it additionally waits a short settle period for
   * `publishDiagnostics` push notifications from the server.
   *
   * @param options - Request details including operation, file path, and
   *   optional position/query.
   * @param workingDirectory - Workspace root (absolute path).
   * @returns Discriminated union: `{ ok: true, data }` or `{ ok: false, error }`.
   */
  public async request(
    options: LspRequestOptions,
    workingDirectory: string,
  ): Promise<LspPoolResult> {
    if (this._disposed) {
      return { ok: false, error: "LspProcessPool has been disposed." };
    }

    // Resolve server for this file extension
    const ext = extname(options.filePath).toLowerCase();
    const serverName = this._resolveServerName(ext);
    if (serverName === null) {
      return {
        ok: false,
        error: `No LSP server configured for "${ext}" files.`,
      };
    }

    const config = this._servers[serverName]!;
    const entryKey = `${serverName}\0${workingDirectory}`;
    const entry = this._getOrCreateEntry(entryKey);

    // Guard: circuit breaker
    if (entry.circuitOpen) {
      return {
        ok: false,
        error:
          `LSP server "${config.command}" has crashed ${entry.crashCount} times ` +
          `and the circuit breaker is open. No further respawns will be attempted.`,
      };
    }

    // Ensure the server is alive
    const clientResult = await this._ensureClient(
      entry,
      config,
      workingDirectory,
      entryKey,
    );
    if (!clientResult.ok) return clientResult;

    const client = entry.client!;

    // Open / refresh the file in the server
    const fileUri = pathToFileURL(options.filePath).href;
    const languageId = resolveLanguageId(config, ext);

    try {
      const fileContent = await readFileContent(options.filePath);
      client.sendNotification("textDocument/didOpen", {
        textDocument: {
          uri: fileUri,
          languageId,
          version: 1,
          text: fileContent,
        },
      });
    } catch (err: unknown) {
      return {
        ok: false,
        error: `Could not read file "${options.filePath}": ${String(err)}`,
      };
    }

    // Reset idle timer
    this._resetIdleTimer(entry, entryKey, config);

    // Dispatch operation
    const timeoutMs = options.timeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
    return this._dispatch(client, entry, options, fileUri, timeoutMs);
  }

  /**
   * Tears down all active server processes owned by this pool instance.
   * After calling, the pool cannot be reused.
   *
   * @returns A promise that resolves once all processes have exited.
   */
  public async dispose(): Promise<void> {
    if (this._disposed) return;
    this._disposed = true;

    const teardownPromises: Promise<void>[] = [];
    for (const [, entry] of this._entries) {
      this._clearIdleTimer(entry);
      if (entry.client) {
        const pid = entry.client.pid;
        teardownPromises.push(
          entry.client.dispose().finally(() => {
            globalPidRegistry.delete(pid);
          }),
        );
        entry.client = null;
      }
    }
    this._entries.clear();

    await Promise.allSettled(teardownPromises);
  }

  // ── Private helpers ────────────────────────────────────────────────────────

  /**
   * Returns the first server name whose `extensions` array contains `ext`,
   * or `null` if none match.
   *
   * @param ext - Lower-cased file extension including the leading dot.
   */
  private _resolveServerName(ext: string): string | null {
    for (const [name, config] of Object.entries(this._servers)) {
      if (config.extensions.some((e) => e.toLowerCase() === ext)) {
        return name;
      }
    }
    return null;
  }

  /**
   * Returns the existing pool entry for `key`, or creates a new one.
   *
   * @param key - Composite pool key (`serverName\0workingDirectory`).
   */
  private _getOrCreateEntry(key: string): PoolEntry {
    let entry = this._entries.get(key);
    if (!entry) {
      entry = {
        client: null,
        crashCount: 0,
        circuitOpen: false,
        idleTimer: null,
        diagnosticsCache: new Map(),
      };
      this._entries.set(key, entry);
    }
    return entry;
  }

  /**
   * Ensures a healthy `LspClient` exists on `entry.client`.
   * Spawns a new client if needed, respecting the circuit breaker.
   *
   * @param entry - The pool entry to check/update.
   * @param config - Server configuration.
   * @param workingDirectory - Workspace root.
   * @param entryKey - Pool key (for crash handling).
   * @returns `{ ok: true }` with the client set, or `{ ok: false, error }`.
   */
  private async _ensureClient(
    entry: PoolEntry,
    config: LspServerConfig,
    workingDirectory: string,
    entryKey: string,
  ): Promise<LspPoolResult> {
    if (entry.client?.isReady) {
      return { ok: true, data: null };
    }

    // Clean up stale crashed client
    if (entry.client?.hasCrashed) {
      globalPidRegistry.delete(entry.client.pid);
      entry.client = null;
    }

    const maxRestarts = config.maxRestarts ?? DEFAULT_MAX_RESTARTS;

    // Spawn
    let client: LspClient;
    try {
      const diagnosticsHandler: DiagnosticsHandler = (uri, diags) => {
        const e = this._entries.get(entryKey);
        if (e) e.diagnosticsCache.set(uri, diags);
      };
      client = new LspClient(config, workingDirectory, diagnosticsHandler);
      client.ready.catch(() => {
        /* prevent unhandled rejection warning */
      });
    } catch (err: unknown) {
      return {
        ok: false,
        error: `LSP server "${config.command}" was not found on PATH or could not be spawned.`,
      };
    }

    globalPidRegistry.add(client.pid);

    // Await initialize
    try {
      await client.ready;
    } catch (err: unknown) {
      globalPidRegistry.delete(client.pid);
      entry.crashCount++;
      if (entry.crashCount >= maxRestarts) {
        entry.circuitOpen = true;
        return {
          ok: false,
          error:
            `LSP server "${config.command}" failed to initialize ${entry.crashCount} times. ` +
            `Circuit breaker is now open.`,
        };
      }
      return {
        ok: false,
        error: `LSP server "${config.command}" failed to initialize: ${err instanceof Error ? err.message : String(err)}`,
      };
    }

    // Handle future crashes
    client.ready.catch(() => {
      /* handled on next request via hasCrashed check */
    });

    entry.client = client;
    entry.crashCount = 0; // reset on successful init
    return { ok: true, data: null };
  }

  /**
   * Dispatches the actual LSP method call after the client is confirmed ready.
   *
   * @param client - Ready `LspClient` instance.
   * @param entry - Pool entry (for diagnostics cache access).
   * @param options - Request options.
   * @param fileUri - `file://` URI for the target file.
   * @param timeoutMs - Per-request timeout.
   */
  private async _dispatch(
    client: LspClient,
    entry: PoolEntry,
    options: LspRequestOptions,
    fileUri: string,
    timeoutMs: number,
  ): Promise<LspPoolResult> {
    // Position (0-based for the wire)
    const line0 = Math.max(0, (options.line ?? 1) - 1);
    const char0 = Math.max(0, (options.character ?? 1) - 1);
    const position = { line: line0, character: char0 };

    try {
      switch (options.operation) {
        case "diagnostics": {
          // Clear cached diagnostics so we get fresh data
          entry.diagnosticsCache.delete(fileUri);

          // Trigger the server to re-evaluate by sending didSave
          client.sendNotification("textDocument/didSave", {
            textDocument: { uri: fileUri },
          });

          // Wait up to timeoutMs for publishDiagnostics push
          const diags = await waitForDiagnostics(
            entry.diagnosticsCache,
            fileUri,
            timeoutMs,
          );
          return { ok: true, data: diags };
        }

        case "hover": {
          const result = await client.sendRequest(
            "textDocument/hover",
            { textDocument: { uri: fileUri }, position },
            timeoutMs,
          );
          return { ok: true, data: result };
        }

        case "goToDefinition": {
          const result = await client.sendRequest(
            "textDocument/definition",
            { textDocument: { uri: fileUri }, position },
            timeoutMs,
          );
          return { ok: true, data: result };
        }

        case "goToImplementation": {
          const result = await client.sendRequest(
            "textDocument/implementation",
            { textDocument: { uri: fileUri }, position },
            timeoutMs,
          );
          return { ok: true, data: result };
        }

        case "findReferences": {
          const result = await client.sendRequest(
            "textDocument/references",
            {
              textDocument: { uri: fileUri },
              position,
              context: { includeDeclaration: true },
            },
            timeoutMs,
          );
          return { ok: true, data: result };
        }

        case "documentSymbol": {
          const result = await client.sendRequest(
            "textDocument/documentSymbol",
            { textDocument: { uri: fileUri } },
            timeoutMs,
          );
          return { ok: true, data: result };
        }

        case "workspaceSymbol": {
          const result = await client.sendRequest(
            "workspace/symbol",
            { query: options.query ?? "" },
            timeoutMs,
          );
          return { ok: true, data: result };
        }
      }
    } catch (err: unknown) {
      return {
        ok: false,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }

  /**
   * Resets the idle teardown timer for a pool entry.
   * Any previous timer is cleared before the new one is set.
   *
   * @param entry - Pool entry to reset.
   * @param entryKey - Key used to remove entry on expiry.
   * @param config - Server config (for `idleTimeoutMs`).
   */
  private _resetIdleTimer(
    entry: PoolEntry,
    entryKey: string,
    config: LspServerConfig,
  ): void {
    this._clearIdleTimer(entry);
    const idleMs = config.idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS;
    entry.idleTimer = setTimeout(() => {
      void this._teardownEntry(entry, entryKey);
    }, idleMs);
    // Allow the timer to not block process exit
    if (typeof entry.idleTimer.unref === "function") {
      entry.idleTimer.unref();
    }
  }

  /**
   * Clears the idle teardown timer for an entry if one is set.
   *
   * @param entry - Pool entry whose timer should be cleared.
   */
  private _clearIdleTimer(entry: PoolEntry): void {
    if (entry.idleTimer !== null) {
      clearTimeout(entry.idleTimer);
      entry.idleTimer = null;
    }
  }

  /**
   * Disposes the client in an entry and removes it from the pool map.
   *
   * @param entry - The pool entry to tear down.
   * @param entryKey - Key to remove from the pool map.
   */
  private async _teardownEntry(
    entry: PoolEntry,
    entryKey: string,
  ): Promise<void> {
    this._clearIdleTimer(entry);
    if (entry.client) {
      const pid = entry.client.pid;
      await entry.client.dispose().catch(() => {
        /* best-effort */
      });
      globalPidRegistry.delete(pid);
      entry.client = null;
    }
    this._entries.delete(entryKey);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Module-level helpers
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Derives the LSP `languageId` for a file based on server config and extension.
 *
 * Uses `config.languageId` when explicitly set; otherwise maps common
 * extensions. Falls back to stripping the leading dot.
 *
 * @param config - Server configuration that may carry a `languageId` override.
 * @param ext - Lower-cased file extension including the leading dot.
 * @returns LSP language identifier string.
 */
function resolveLanguageId(config: LspServerConfig, ext: string): string {
  if (config.languageId) return config.languageId;
  const knownMap: Record<string, string> = {
    ".ts": "typescript",
    ".tsx": "typescriptreact",
    ".js": "javascript",
    ".jsx": "javascriptreact",
    ".mjs": "javascript",
    ".cjs": "javascript",
    ".py": "python",
    ".rs": "rust",
    ".go": "go",
    ".c": "c",
    ".cpp": "cpp",
    ".h": "c",
    ".hpp": "cpp",
    ".json": "json",
    ".jsonc": "jsonc",
    ".html": "html",
    ".css": "css",
    ".scss": "scss",
    ".less": "less",
    ".yaml": "yaml",
    ".yml": "yaml",
    ".sh": "shellscript",
    ".bash": "shellscript",
    ".md": "markdown",
    ".lua": "lua",
    ".rb": "ruby",
    ".java": "java",
    ".kt": "kotlin",
    ".swift": "swift",
    ".cs": "csharp",
  };
  return knownMap[ext] ?? ext.slice(1);
}

/**
 * Reads the content of a file from disk.
 *
 * @param filePath - Absolute path to the file.
 * @returns File content as a UTF-8 string.
 * @throws {Error} If the file does not exist or is not readable.
 */
async function readFileContent(filePath: string): Promise<string> {
  const { readFile } = await import("node:fs/promises");
  if (!existsSync(filePath)) {
    throw new Error(`File not found: "${filePath}"`);
  }
  return readFile(filePath, "utf-8");
}

/**
 * Waits for a `textDocument/publishDiagnostics` push for the given file URI
 * to be stored in `cache`. Resolves as soon as the entry exists or when
 * `timeoutMs` elapses, returning whatever has been collected.
 *
 * @param cache - Diagnostics cache map keyed by `file://` URI.
 * @param fileUri - Target `file://` URI to watch.
 * @param timeoutMs - Maximum wait time in milliseconds.
 * @returns Array of diagnostics (may be empty if the server reported none).
 */
function waitForDiagnostics(
  cache: Map<string, LspDiagnostic[]>,
  fileUri: string,
  timeoutMs: number,
): Promise<LspDiagnostic[]> {
  return new Promise<LspDiagnostic[]>((resolve) => {
    const deadline = Date.now() + timeoutMs;
    const poll = setInterval(() => {
      const diags = cache.get(fileUri);
      if (diags !== undefined || Date.now() >= deadline) {
        clearInterval(poll);
        resolve(diags ?? []);
      }
    }, 50);
    // Unref so it doesn't block process exit
    if (typeof poll.unref === "function") poll.unref();
  });
}
