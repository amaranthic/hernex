/**
 * @fileoverview Persistent LSP client wrapping a single language server process.
 *
 * `LspClient` owns the full lifecycle of one language server process:
 * - Spawns the binary via `child_process.spawn`.
 * - Establishes a JSON-RPC 2.0 connection over stdio using `vscode-jsonrpc`.
 * - Sends the LSP `initialize` / `initialized` handshake once on startup.
 * - Exposes `sendRequest` and `sendNotification` for callers.
 * - Registers a `textDocument/publishDiagnostics` push handler so the pool
 *   can collect server-pushed diagnostics.
 * - Tears down the process gracefully: LSP `shutdown` → `exit` notification
 *   → 2-second grace period → `SIGKILL` escalation.
 *
 * **This module is an internal implementation detail of `LspProcessPool`.**
 * Direct usage outside of `src/lsp/` is unsupported.
 *
 * @packageDocumentation
 */

import { spawn, type ChildProcess } from "node:child_process";
import { pathToFileURL } from "node:url";
import {
  createMessageConnection,
  StreamMessageReader,
  StreamMessageWriter,
  type MessageConnection,
} from "vscode-jsonrpc/node";
import type { LspServerConfig, LspDiagnostic } from "./types.js";
import { getSafeBashEnvironment } from "../tools/internal/bashEnvironment.js";
import { LspDiagnosticSeverity } from "./types.js";

// ─────────────────────────────────────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────────────────────────────────────

/** Default request timeout in milliseconds. */
const DEFAULT_REQUEST_TIMEOUT_MS = 10_000;

/** Grace period (ms) between LSP `exit` notification and `SIGKILL`. */
const TEARDOWN_GRACE_MS = 2_000;

/** LSP `initialize` request timeout — servers may be slow to warm up. */
const INITIALIZE_TIMEOUT_MS = 15_000;

// ─────────────────────────────────────────────────────────────────────────────
// PublishDiagnostics notification shape (LSP §3.17.1)
// ─────────────────────────────────────────────────────────────────────────────

interface RawDiagnosticRange {
  start: { line: number; character: number };
}

interface RawDiagnostic {
  severity?: number;
  message: string;
  source?: string;
  code?: string | number;
  range: RawDiagnosticRange;
}

interface PublishDiagnosticsParams {
  uri: string;
  diagnostics: RawDiagnostic[];
}

// ─────────────────────────────────────────────────────────────────────────────
// LspClient
// ─────────────────────────────────────────────────────────────────────────────

/**
 * State machine for the LSP client's connection lifecycle.
 *
 * ```
 * starting → ready → disposing → disposed
 *                ↘ crashed (before dispose)
 * ```
 */
type LspClientState =
  "starting" | "ready" | "disposing" | "disposed" | "crashed";

/**
 * Callback invoked by `LspClient` whenever the language server pushes a
 * `textDocument/publishDiagnostics` notification.
 *
 * @param uri - The `file://` URI of the file the diagnostics belong to.
 * @param diagnostics - Normalized diagnostic items (empty array = no issues).
 */
export type DiagnosticsHandler = (
  uri: string,
  diagnostics: LspDiagnostic[],
) => void;

/**
 * Persistent JSON-RPC client for a single language server process.
 *
 * Consumers should await {@link LspClient.ready} before calling
 * {@link LspClient.sendRequest} or {@link LspClient.sendNotification}.
 *
 * @example
 * ```typescript
 * const client = new LspClient(config, "/home/user/project", onDiagnostics);
 * await client.ready;
 * const result = await client.sendRequest("textDocument/hover", params, 5000);
 * await client.dispose();
 * ```
 */
export class LspClient {
  /** The underlying OS process. Exposed for the global PID registry. */
  public readonly pid: number;

  /** Settles once the LSP `initialize` handshake completes. */
  public readonly ready: Promise<void>;

  private readonly _process: ChildProcess;
  private readonly _connection: MessageConnection;
  private readonly _workingDirectory: string;
  private readonly _config: LspServerConfig;

  private _state: LspClientState = "starting";
  private _rejectReady!: (err: Error) => void;

  /**
   * Constructs and immediately spawns the language server process.
   *
   * @param config - Server binary configuration.
   * @param workingDirectory - Workspace root passed as `rootUri` during
   *   LSP `initialize`.
   * @param onDiagnostics - Called whenever the server pushes
   *   `textDocument/publishDiagnostics`.
   * @throws {Error} If the process cannot be spawned (binary not found, etc.).
   */
  public constructor(
    config: LspServerConfig,
    workingDirectory: string,
    onDiagnostics: DiagnosticsHandler,
  ) {
    this._config = config;
    this._workingDirectory = workingDirectory;

    // ── Build sanitized environment ──────────────────────────────────────────
    const baseEnv = getSafeBashEnvironment();
    const env: Record<string, string> = { ...baseEnv };
    if (config.env) {
      for (const [k, v] of Object.entries(config.env)) {
        env[k] = v;
      }
    }

    // ── Spawn ────────────────────────────────────────────────────────────────
    const args = config.args ? [...config.args] : [];
    this._process = spawn(config.command, args, {
      stdio: ["pipe", "pipe", "pipe"],
      cwd: workingDirectory,
      env,
    });

    // Handle spawn error immediately to prevent unhandled error event crash
    this._process.on("error", (err: Error) => {
      if (this._state !== "disposing" && this._state !== "disposed") {
        this._state = "crashed";
        this._rejectReady?.(
          new Error(
            `LSP server "${config.command}" was not found on PATH or could not be spawned: ${err.message}`,
          ),
        );
      }
      try {
        this._connection?.dispose();
      } catch {
        /* ignore */
      }
    });

    if (!this._process.pid) {
      throw new Error(
        `LSP server "${config.command}" was not found on PATH or could not be spawned.`,
      );
    }

    this.pid = this._process.pid;

    // ── Wire vscode-jsonrpc connection ───────────────────────────────────────
    this._connection = createMessageConnection(
      new StreamMessageReader(this._process.stdout!),
      new StreamMessageWriter(this._process.stdin!),
    );

    // ── Suppress unhandled error noise from the connection ───────────────────
    this._connection.onError(() => {
      /* errors surface via rejected sendRequest promises */
    });

    // ── Handle publishDiagnostics push ───────────────────────────────────────
    this._connection.onNotification(
      "textDocument/publishDiagnostics",
      (params: PublishDiagnosticsParams) => {
        const normalized = normalizeDiagnostics(params.diagnostics);
        onDiagnostics(params.uri, normalized);
      },
    );

    // ── Handle server exit ───────────────────────────────────────────────────
    this._process.on("exit", (code, signal) => {
      if (this._state !== "disposing" && this._state !== "disposed") {
        this._state = "crashed";
        const reason =
          signal != null
            ? `killed by signal ${signal}`
            : `exited with code ${code ?? "null"}`;
        this._rejectReady?.(new Error(`LSP server process crashed: ${reason}`));
      }
      try {
        this._connection.dispose();
      } catch {
        /* ignore */
      }
    });

    // ── Start listening (must happen before initialize) ───────────────────────
    this._connection.listen();

    // ── Initialize handshake ──────────────────────────────────────────────────
    this.ready = new Promise<void>((resolve, reject) => {
      this._rejectReady = reject;
      this._initialize().then(resolve, reject);
    });
  }

  /**
   * Sends a JSON-RPC request to the language server.
   *
   * @param method - LSP method name (e.g. `"textDocument/hover"`).
   * @param params - Request parameters object.
   * @param timeoutMs - Abort deadline in milliseconds.
   * @returns The raw result from the server.
   * @throws {Error} On timeout, server error, or disconnection.
   */
  public async sendRequest(
    method: string,
    params: unknown,
    timeoutMs: number = DEFAULT_REQUEST_TIMEOUT_MS,
  ): Promise<unknown> {
    this._assertReady();

    return new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(
          new Error(`LSP request "${method}" timed out after ${timeoutMs}ms`),
        );
      }, timeoutMs);

      this._connection.sendRequest<unknown>(method, params).then(
        (result: unknown) => {
          clearTimeout(timer);
          resolve(result);
        },
        (err: unknown) => {
          clearTimeout(timer);
          reject(err instanceof Error ? err : new Error(String(err)));
        },
      );
    });
  }

  /**
   * Sends a JSON-RPC notification to the language server (fire-and-forget).
   *
   * @param method - LSP notification method name.
   * @param params - Notification parameters.
   */
  public sendNotification(method: string, params: unknown): void {
    if (this._state !== "ready") return;
    // vscode-jsonrpc sendNotification returns a Promise<void>; we intentionally
    // fire-and-forget for LSP notifications.
    void this._connection.sendNotification(method, params);
  }

  /**
   * Whether this client is in the `ready` state and can accept requests.
   */
  public get isReady(): boolean {
    return this._state === "ready";
  }

  /**
   * Whether this client has crashed and cannot be recovered without a respawn.
   */
  public get hasCrashed(): boolean {
    return this._state === "crashed";
  }

  /**
   * Gracefully tears down the LSP connection:
   * 1. Sends LSP `shutdown` request.
   * 2. Sends LSP `exit` notification.
   * 3. Waits up to {@link TEARDOWN_GRACE_MS} for the process to exit.
   * 4. Sends `SIGKILL` if the process is still alive.
   *
   * Safe to call multiple times — subsequent calls are no-ops.
   */
  public async dispose(): Promise<void> {
    if (this._state === "disposing" || this._state === "disposed") return;
    this._state = "disposing";

    try {
      await Promise.race([
        this._connection.sendRequest("shutdown", null),
        new Promise<void>((_, reject) =>
          setTimeout(() => reject(new Error("shutdown timeout")), 3_000),
        ),
      ]);
    } catch {
      /* ignore — process may already be dead */
    }

    try {
      await this._connection.sendNotification("exit", null);
    } catch {
      /* ignore */
    }

    this._connection.dispose();

    // Wait gracefully then SIGKILL
    await new Promise<void>((resolve) => {
      const killTimer = setTimeout(() => {
        try {
          this._process.kill("SIGKILL");
        } catch {
          /* already dead */
        }
        resolve();
      }, TEARDOWN_GRACE_MS);

      this._process.once("exit", () => {
        clearTimeout(killTimer);
        resolve();
      });
    });

    this._state = "disposed";
  }

  // ── Private helpers ────────────────────────────────────────────────────────

  /**
   * Performs the LSP `initialize` / `initialized` handshake.
   * Times out after {@link INITIALIZE_TIMEOUT_MS}.
   */
  private async _initialize(): Promise<void> {
    const rootUri = pathToFileURL(this._workingDirectory).href;

    const initResult = await Promise.race([
      this._connection.sendRequest<unknown>("initialize", {
        processId: process.pid,
        rootUri,
        capabilities: {
          textDocument: {
            hover: { contentFormat: ["plaintext", "markdown"] },
            publishDiagnostics: { relatedInformation: false },
            definition: { linkSupport: false },
            implementation: { linkSupport: false },
            references: {},
            documentSymbol: { hierarchicalDocumentSymbolSupport: false },
          },
          workspace: {
            symbol: {},
          },
        },
        workspaceFolders: [{ uri: rootUri, name: "workspace" }],
      }),
      new Promise<never>((_, reject) =>
        setTimeout(
          () =>
            reject(
              new Error(
                `LSP server "${this._config.command}" did not respond to initialize within ${INITIALIZE_TIMEOUT_MS}ms`,
              ),
            ),
          INITIALIZE_TIMEOUT_MS,
        ),
      ),
    ]);

    // The result is ignored — we only need to know it succeeded.
    void initResult;

    await this._connection.sendNotification("initialized", {});
    this._state = "ready";
  }

  /** Throws if the client is not in `ready` state. */
  private _assertReady(): void {
    if (this._state !== "ready") {
      throw new Error(
        `LSP client is not ready (state: ${this._state}). ` +
          `Await client.ready before sending requests.`,
      );
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Converts raw LSP `Diagnostic` objects from the wire into normalized
 * {@link LspDiagnostic} records with 1-based positions.
 *
 * @param raw - Array of raw diagnostic objects from the LSP server.
 * @returns Normalized diagnostic array sorted by severity ascending.
 */
function normalizeDiagnostics(raw: RawDiagnostic[]): LspDiagnostic[] {
  return raw.map((d) => ({
    severity: isValidSeverity(d.severity) ? d.severity : undefined,
    message: d.message,
    source: d.source ?? undefined,
    code: d.code ?? undefined,
    startLine: (d.range.start.line ?? 0) + 1,
    startCharacter: (d.range.start.character ?? 0) + 1,
  }));
}

/**
 * Type guard to check if a value is a valid LSP diagnostic severity number.
 *
 * @param v - Value to test.
 */
function isValidSeverity(
  v: unknown,
): v is (typeof LspDiagnosticSeverity)[keyof typeof LspDiagnosticSeverity] {
  return v === 1 || v === 2 || v === 3 || v === 4;
}
