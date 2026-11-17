# Changelog

All notable changes to `@amaranthic/hernex` are documented in this file.
The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

---

## [0.8.0] - 2026-11-17

### Summary

Version `0.8.0` revamps the Language Server Protocol (LSP) intelligence subsystem from the ground up. Replaces per-call server spawning with a persistent in-memory process pool (`LspProcessPool`) backed by `vscode-jsonrpc`. `LspTool` acts as a pure orchestrator requiring explicit server configuration, eliminating hardcoded ambient defaults. Delivers kernel-grade process safety (zero zombie processes, signal hooks, idle timeout teardown, and crash circuit breakers) and smart diagnostic severity precedence formatting.

---

### Breaking Changes

- **Explicit Server Configuration Required on `LspTool`**:
  - `new LspTool()` no longer provides ambient built-in servers (`defaultLspConfig` has been removed).
  - Callers must pass an explicit configuration object: `new LspTool({ servers: { typescript: { command: "typescript-language-server", args: ["--stdio"], extensions: [".ts", ".tsx"] } } })`.
- **Removed Legacy Exports**:
  - Removed `defaultLspConfig`, `runLspRequest`, `DEFAULT_LSP_TIMEOUT_MS`, `LspConfig`, and `LspResult` from `@amaranthic/hernex`.
  - Replaced by `LspTool`, `LspProcessPool`, `LspDiagnosticSeverity`, and types `LspToolConfig`, `LspServerConfig`, `LspServersConfig`, `LspOperation`, `LspRequestOptions`, `LspDiagnostic`, `LspDiagnosticSeverityValue`, `LspPoolResult`.
- **Deleted Internal Legacy Runner**:
  - Completely removed the 1,700+ line custom JSON-RPC wire parser at `src/tools/internal/lsp.ts`.

---

### New Features

- **Persistent Process Pool (`src/lsp/LspProcessPool.ts`)**:
  - Persistent server instances keyed by server name and working directory with lazy startup.
  - Automatic idle teardown (default 5 minutes, configurable via `idleTimeoutMs`) to reclaim system resources.
  - Crash circuit breaker with a hard cap of 3 consecutive crashes before opening, preventing runaway process respawns.
  - Battle-hardened process safety: module-level PID registry with hooks on `process.on("exit")`, `SIGINT`, `SIGTERM`, and `beforeExit` to guarantee zero zombie processes.
- **Battle-Tested Wire Protocol (`src/lsp/LspClient.ts`)**:
  - Implemented over standard I/O streams using `vscode-jsonrpc` (`^10.0.0`).
  - Graceful teardown protocol: sends LSP `shutdown` request followed by `exit` notification, a 2-second grace period, and SIGKILL escalation if still active.
  - Immediate spawn error handling to prevent unhandled node event errors when binaries are missing from `PATH`.
- **Smart Diagnostic Severity Precedence (`src/lsp/formatters.ts`)**:
  - Hierarchical output formatting: Errors take precedence over Warnings, which take precedence over Info/Hints.
  - Summarizes lower-priority tiers with count notes (e.g. `_(also has 2 warnings)_`).
  - Output capped at 5 items per category with overflow annotations and clean formatting without emojis.
- **Streamlined Operation Coordinates**:
  - `diagnostics`, `documentSymbol`, and `workspaceSymbol` no longer require dummy `line` or `character` parameters.
  - Only position-sensitive operations (`hover`, `goToDefinition`, `goToImplementation`, `findReferences`) require 1-based `line` and `character`.
  - `workspaceSymbol` supports an optional `query?: string` parameter.

---

## [0.7.1] - 2026-11-16

### Summary

Version `0.7.1` introduces built-in transport and stream resilience settings (`maxRetries` and `streamRetries`) with defaults of `10` and an automatic safety cap of `15`. Enhances error recovery for transient rate limits, gateway disconnects, and mid-stream provider failures without restarting completed steps.

---

### New Features

- **Request & Stream Retries Resilience (`maxRetries` & `streamRetries`)**:
  - Added `maxRetries?: number` to `AgentEngineConfig` and `RunTurnOptions` for transport and initial connection failures (HTTP 429, 500/502/503/504, connection timeouts) with exponential backoff and rate-limit header handling.
  - Added `streamRetries?: number` to `AgentEngineConfig` and `RunTurnOptions` for mid-stream provider errors (`chunk.type === "error"`), recovering only the active step while preserving completed earlier steps and tool outputs.
  - Set default retry counts to `10` (`defaultMaxRetries = 10` and `defaultStreamRetries = 10`).
  - Added safety clamping via `resolveRetryCount` to enforce a hard maximum bound of `15` (`maxAllowedMaxRetries = 15` and `maxAllowedStreamRetries = 15`), preventing runaway retry loops while allowing `0` to disable retries.
  - Exported `defaultMaxRetries`, `maxAllowedMaxRetries`, `defaultStreamRetries`, `maxAllowedStreamRetries`, and `resolveRetryCount` from the primary root entry point.

---

## [0.7.0] - 2026-11-16

### Summary

Version `0.7.0` introduces the on-demand Language Server Protocol (LSP) intelligence subsystem, providing compiler-grade semantic code analysis (`LspTool` and internal engine). Implemented with zero external protocol packages using raw JSON-RPC over stdio framing. Spawns servers on demand and exits cleanly per request with zero ambient background processes. Also exports post-tool execution hook types (`PostToolContext`, `PostToolResult`, `PostToolHook`) from the root entry point.

---

### New Features

- **On-Demand Language Server Protocol Engine (`src/tools/internal/lsp.ts`)**:
  - Implemented the LSP JSON-RPC wire protocol from scratch over standard I/O pipes per LSP specification 3.16/3.17 (`Content-Length: <n>\r\n\r\n<json>`) without third-party dependencies.
  - Chunk-resilient frame accumulator (`createFrameReader`) parsing HTTP-style headers and extracting UTF-8 JSON bodies.
  - On-demand process lifecycle: spawns the matching server binary per call, performs the handshake (`initialize` -> `initialized`), sends `textDocument/didOpen`, executes the operation, and terminates cleanly (`shutdown` -> `exit` -> stdin drain -> SIGKILL grace timeout). Zero ambient background daemons or retained memory.
  - Built-in pre-configured `defaultLspConfig` covering 10 major language ecosystems:
    - TypeScript / JavaScript (`typescript-language-server`)
    - Python (`pyright-langserver`)
    - Rust (`rust-analyzer`)
    - Go (`gopls`)
    - C / C++ (`clangd`)
    - JSON (`vscode-json-language-server`)
    - HTML (`vscode-html-language-server`)
    - CSS / SCSS / LESS (`vscode-css-language-server`)
    - YAML (`yaml-language-server`)
    - Shell (`bash-language-server`)
  - Enforces mandatory `extensions: string[]` on every server config entry.

- **Model-Facing `LspTool` (`src/tools/LspTool.ts`)**:
  - Implements the standard `AgentTool` contract under tool name `"lsp"`.
  - Supports 7 semantic operations: `hover`, `goToDefinition`, `goToImplementation`, `findReferences`, `documentSymbol`, `workspaceSymbol`, and `diagnostics`.
  - 1-based coordinate system (`line` and `character`) matching standard editor conventions, with internal conversion to 0-based wire indices.
  - Formats results into clean, token-efficient Markdown with workspace-relative file paths and source positions.
  - Opt-in design: not auto-registered in default `ToolRegistry` to prevent host environment binary assumptions; callers register it explicitly.

- **Security & Stability Hardening**:
  - Strict workspace containment via `resolvePathWithinWorkspace` preventing directory traversal or symlink escapes.
  - 10MB maximum file size ceiling before server spawn to avoid buffer exhaustion.
  - Pre-flight `PATH` binary verification via `which` to return actionable diagnostic messages if a server binary is not installed.
  - Subprocess spawn error listeners avoiding unhandled `ENOENT` events.
  - Exponential backoff retry loop for transient error code `-32801` (`ContentModified`).

- **Lifecycle Hook Subsystem Exports**:
  - Exported missing post-tool execution hook types from the primary root entry point in `src/index.ts`: `PostToolContext`, `PostToolResult`, and `PostToolHook`.

---

## [0.6.1] - 2026-11-15

### Summary

Version `0.6.1` introduces built-in support for the NVIDIA NIM (NVIDIA Inference Microservices) provider adapter under the canonical identifier `nvidiaNim`.

---

### New Features

- **NVIDIA NIM Provider Adapter (`nvidiaNim`)**:
  - Added built-in `NvidiaNimProviderAdapter` using `@ai-sdk/openai-compatible`.
  - Supports cloud-hosted NVIDIA API catalog (`https://integrate.api.nvidia.com/v1`) and self-hosted microservice endpoints with model specifications formatted as `nvidiaNim/org/model-name` (e.g. `nvidiaNim/meta/llama-3.1-70b-instruct`).
  - Registered in `ProviderRegistry` as the 14th default supported provider.

---

## [0.6.0] - 2026-11-15

### Summary

Version `0.6.0` modernizes and hardens the agent lifecycle hook subsystem. It introduces the native `onPostTool` hook contract for post-execution inspection, result mutation, secret redaction, and model feedback via standardized `<system-reminder>` XML tags. Additionally, it upgrades `onAuthorizeTool` to support input parameter mutation (`updatedParameters`), pipelines multi-layer composition in `composeAgentHooks`, and hardens error boundaries across tool executions.

---

### New Features

- **Native `onPostTool` Hook Contract**:
  - Added `PostToolContext` with `{ toolName, parameters, result, isError, durationMs, workingDirectory }`.
  - Added `PostToolResult` with `{ updatedResult?, additionalContext? }`.
  - Added `PostToolHook` type definition and integrated `onPostTool?: PostToolHook` into `AgentHooks`.
  - Automatically formats `additionalContext` into standardized `<system-reminder>` XML blocks and attaches them to tool results for immediate model self-correction.
  - Guarantees single-source-of-truth invariants: when `updatedResult` is returned, the sanitized output is persisted to `ThreadStore.appendTranscript`, emitted in `toolExecutionFinished` events, and passed to subsequent turn messages.

- **`onAuthorizeTool` Input Parameter Mutation**:
  - Upgraded `PermissionDecision` to optionally return `updatedParameters?: unknown`.
  - Allows pre-tool authorization hooks to sanitize, normalize, or enrich tool parameters prior to execution.

- **Deterministic Multi-Layer Hook Composition**:
  - Enhanced `composeAgentHooks` to pipeline `updatedParameters` across authorization layers and `updatedResult` across post-tool layers.
  - Aggregates multi-layer `additionalContext` entries with double-newlines.
  - Isolated post-tool layer errors so failures in one hook layer do not halt execution of subsequent layers.

### Hardening & Resilience

- **Fault-Isolated Post-Tool Execution**:
  - Wrapped `onPostTool` execution in try/catch blocks within `runTurn.ts`.
  - Hook exceptions are emitted as diagnostic events (`origin: "hook"`, `isFatal: false`) and routed to `onError` without crashing the autonomous agent loop.

---

## [0.5.2] - 2026-11-14

### Summary

Version `0.5.2` ensures compiled distribution bundles (`dist/`) are strictly kept in sync prior to packaging and publishing by introducing an automated `prepublishOnly` lifecycle hook.

---

### Changed

- **Automated Build on Prepublish**:
  - Added `"prepublishOnly": "bun run build"` script to `package.json` to prevent packaging stale `dist/` artifacts.
  - Re-emitted clean, up-to-date TypeScript declarations and distribution outputs in `dist/`.

---

## [0.5.1] - 2026-11-14

### Summary

Version `0.5.1` resolves an issue where Vercel AI SDK leaked raw debug dumps, unformatted stack traces, and HTTP request headers to `stderr` upon model or stream failure. It also decouples `customFetch` options from Bun's global `fetch` type, standardizing custom fetch injection across Node.js and Bun environments.

---

### Fixed

- **Raw AI SDK Error Leak in Turn Generator**:
  - Explicitly passed an `onError` handler to `streamOptions` in `runTurn` to prevent Vercel AI SDK from falling back to its default `({ error }) => console.error(error)` behavior.
  - Ensures failed turns bubble exclusively through Hernex's structured turn generator `catch` block, rolling back conversation messages, yielding clean `{ type: "error", origin: "engine", ... }` events, and invoking `hooks.onError`.
  - Added unit test coverage verifying that `console.error` is not invoked when model streaming encounters provider errors or connection failures.

- **Standardized `FetchFunction` Type Definition**:
  - Exported standard `FetchFunction` type decoupled from Bun-specific namespace extensions (`fetch.preconnect`).
  - Updated `WebFetchToolOptions`, `WebSearchToolOptions`, and internal DuckDuckGo search options to accept `FetchFunction | typeof fetch`.

---

## [0.5.0] - 2026-11-12

### Summary

Version `0.5.0` introduces the built-in `WebSearchTool` (`webSearch`), expanding Hernex's default tool registry to 9 core tools. It features a native, high-reliability DuckDuckGo search engine with primary standard HTTP GET execution, automatic failover to `lite.duckduckgo.com`, HTML-to-Markdown conversion via Turndown, redirect link unwrapping, instant answer retrieval, multi-filter support (time, region, SafeSearch, domain whitelisting/blacklisting), pagination, and 15-minute response caching.

---

### New Features

- **Built-in `WebSearchTool` (`webSearch`)**:
  - Registered as the 9th default tool in `ToolRegistry`.
  - Performs web searching using a dependency-free native DuckDuckGo engine.
  - Automatically unwraps DuckDuckGo tracking redirects (`//duckduckgo.com/l/?uddg=...`) to provide agents with clean canonical destination URLs.
  - Formats HTML snippets and overall search results into clean Markdown using `TurndownService`.
  - Integrates DuckDuckGo Instant Answer API (`api.duckduckgo.com`) for entity summaries, Wikipedia abstracts, and related topics.

- **High-Reliability Multi-Tier Search Architecture**:
  - **Primary**: Standard navigation HTTP `GET` requests to `https://html.duckduckgo.com/html/` with modern browser User-Agent rotation, web-standard headers, and randomized human-like timing jitter (100–300ms).
  - **Automatic Failover**: Transparently falls back to `https://lite.duckduckgo.com/lite/` if the primary endpoint encounters rate limiting or an anomaly challenge.
  - **Fail-Soft Diagnostics**: Returns structured Markdown error diagnostic summaries rather than crashing the agent turn loop on upstream network errors.

- **Advanced Search Parameters & Filtering**:
  - `time`: Filter by publication date range (`"day"`, `"week"`, `"month"`, `"year"`, `"all"`).
  - `safeSearch`: Moderation level control (`"strict"`, `"moderate"`, `"off"`).
  - `region`: Geographic and language targeting (e.g. `"us-en"`, `"uk-en"`, `"in-en"`).
  - `allowedDomains`: Whitelist domain filtering (e.g. `["github.com"]`).
  - `blockedDomains`: Blacklist domain filtering.
  - `offset` & `limit`: Complete pagination support returning `offset`, `nextOffset`, and `hasNextPage`.

- **In-Memory Response Caching**:
  - Deterministic 15-minute response caching (`cacheTtlMs: 900,000`).
  - Repeated identical queries return cached Markdown (`cached: true`) with zero outbound network calls.

---

## [0.4.0] - 2026-11-12

### Summary

Version `0.4.0` introduces the built-in `WebFetchTool` (`webFetch`), expanding Hernex's default tool registry to 8 core tools. Features include comprehensive Server-Side Request Forgery (SSRF) defense via `ipaddr.js`, automated HTML-to-Markdown conversion using `turndown`, cross-host redirect safety halts, a 15-minute in-memory response cache, and model-driven focused extraction with exponential backoff retries.

---

### New Features

- **Built-in `WebFetchTool` (`webFetch`)**:
  - Registered as the 8th default tool in `ToolRegistry` alongside file and shell tools.
  - Automatically fetches HTTP and HTTPS web resources and converts HTML directly into clean Markdown using `TurndownService`.
  - Formats `application/json` responses into syntax-highlighted code blocks and handles plain text.

- **SSRF Defense Architecture (`ssrfGuard`)**:
  - Validates all destination addresses using `ipaddr.js`.
  - Rejects private IPv4 networks (`10.0.0.0/8`, `172.16.0.0/12`, `192.168.0.0/16`), loopback (`127.0.0.0/8`), link-local / IMDS (`169.254.0.0/16`), carrier-grade NAT (`100.64.0.0/10`), unspecified (`0.0.0.0/8`), multicast, and reserved ranges.
  - Rejects IPv6 loopback (`::1`), link-local (`fe80::/10`), unique local (`fc00::/7`), and IPv4-mapped IPv6 variants (`::ffff:x.x.x.x`).
  - Blocks local host suffixes (`.local`, `.internal`, `.localhost`, `.lan`), single-label internal hosts, cloud metadata endpoints (`metadata.google.internal`, `instance-data`), and embedded basic auth credentials.

- **Cross-Host Redirect Safety**:
  - Follows permitted same-host and `www.` redirects up to 5 hops.
  - Halts cross-host redirects and returns a notice with the target location, preserving agent control and security oversight over unexpected domain jumps.

- **In-Memory Response Caching**:
  - Implements a 15-minute response cache (`cacheTtlMs: 900,000`).
  - Subsequent requests targeting identical URLs within TTL return cached Markdown (`cached: true`) with zero network latency.

- **Model-Driven Targeted Extraction**:
  - Supports optional `prompt` parameter on `webFetch`.
  - If omitted: returns clean page Markdown directly (zero extra token overhead).
  - If provided: runs single-turn extraction via Hernex's `generateText` runtime using the turn's active model and credentials, with up to 5 retry attempts and exponential backoff on transient errors.

---

### Bug Fixes & Resilience Hardening

- **Storage Stale-Lock Recovery Test**:
  - Corrected hardcoded PID `1234` in `tests/storage.test.ts` to use `process.pid`, ensuring the process liveness probe accurately tests timeout behavior against an active lock holder.

---

## [0.3.0] - 2026-11-12

### Summary

Version `0.3.0` represents a comprehensive architectural overhaul, hardening the microkernel agent engine, standardizing conversational persistence terminology, enforcing strict tool schema validation, introducing workspace-wide transactional file locking, upgrading transcript replay to full AI SDK v7 compatibility, and eliminating prototype pollution and serialization bugs.

---

### Migration Guide: Upgrading from `0.1.x`

This section details every breaking change between `0.1.x` and `0.3.0` and provides clear code examples on how to update older code.

#### 1. Package Rebrand: `@amaranthic/harnex` → `@amaranthic/hernex`

The package and repository have been renamed to `@amaranthic/hernex`.

**Before (`0.1.x`):**

```ts
import { AgentEngine, FileThreadStore } from "@amaranthic/harnex";
```

**After (`0.3.0`):**

```ts
import { AgentEngine, FileThreadStore } from "@amaranthic/hernex";
```

Update your `package.json`:

```json
{
  "dependencies": {
    "@amaranthic/hernex": "^0.3.0"
  }
}
```

---

#### 2. Terminology Standardization: `Session` → `Thread`

All persisted conversation state, identifiers, and storage methods now consistently use `thread` and `threadId` instead of `session` or `sessionId`.

**Before (`0.1.x`):**

```ts
const engine = new AgentEngine({
  sessionId: "session-123",
  sessionStore: new FileSessionStore({ storageDirectory: "./data" }),
  // ...
});

const session = await engine.sessionStore.getSession("session-123");
```

**After (`0.3.0`):**

```ts
const engine = new AgentEngine({
  threadId: "thread-123",
  threadStore: new FileThreadStore({ storageDirectory: "./data" }),
  // ...
});

const thread = await engine.threadStore.getThread("thread-123");
```

**Key API Renames:**

| Older API (`0.1.x`)                         | New API (`0.3.0`)                         |
| :------------------------------------------ | :---------------------------------------- |
| `config.sessionId`                          | `config.threadId`                         |
| `config.sessionStore`                       | `config.threadStore`                      |
| `engine.sessionId`                          | `engine.threadId`                         |
| `engine.sessionStore`                       | `engine.threadStore`                      |
| `FileSessionStore`                          | `FileThreadStore`                         |
| `SessionStore` (interface)                  | `ThreadStore` (interface)                 |
| `SessionRecord` / `SessionMetadata`         | `ThreadRecord` / `ThreadMetadata`         |
| `CreateSessionInput` / `UpdateSessionInput` | `CreateThreadInput` / `UpdateThreadInput` |

---

#### 3. Tool Input Schemas: `GlobTool` and `GrepTool`

Tool parameter schemas have been aligned with standard filesystem semantics and made strictly unambiguous.

##### A. `GlobTool`

- Renamed the ambiguous `path` parameter to `directoryPath`.

**Before (`0.1.x`):**

```ts
await globTool.execute({
  pattern: "**/*.ts",
  path: "./src", // Ambiguous
});
```

**After (`0.3.0`):**

```ts
await globTool.execute({
  pattern: "**/*.ts",
  directoryPath: "./src", // Required, unambiguous directory target
});
```

##### B. `GrepTool`

- Replaced ambiguous `path` with mutually exclusive `filePath` and `directoryPath`.

**Before (`0.1.x`):**

```ts
await grepTool.execute({
  pattern: "export function",
  path: "./src/index.ts", // or path: "./src"
});
```

**After (`0.3.0`):**

```ts
// For targeted single-file search:
await grepTool.execute({
  pattern: "export function",
  filePath: "./src/index.ts",
});

// For recursive directory search:
await grepTool.execute({
  pattern: "export function",
  directoryPath: "./src",
});
```

> [!NOTE]
> Passing both `filePath` and `directoryPath` or neither will fail validation with a descriptive Zod error.

---

#### 4. Turn Indexing: 1-Based Numbering Contract

Turn indexing across `ToolExecutionContext`, checkpoints, and engine hooks now strictly enforces a 1-based convention (`1, 2, 3, ...`). Turn index `0` is invalid.

**Before (`0.1.x`):**

```ts
// Turn counter started at 0 or serialized undefined as 0
context.turnIndex; // Could be 0
```

**After (`0.3.0`):**

```ts
// Turn counter starts at 1
context.turnIndex; // Always >= 1
// Optional turnIndex on checkpoints serializes as undefined when omitted, never 0
```

---

#### 5. Checkpoint Restore Error Handling: `HernexCheckpointRestoreError`

When restoring checkpoints containing multiple files, if a failure occurs halfway through, Hernex now automatically applies reverse-order rollback compensation to restore already-committed files to their prior state, and throws a typed `HernexCheckpointRestoreError`.

**Before (`0.1.x`):**

```ts
try {
  await checkpointStore.restoreCheckpoint("cp-1");
} catch (error) {
  // Generic error; unknown which files were mutated on disk
}
```

**After (`0.3.0`):**

```ts
import { HernexCheckpointRestoreError } from "@amaranthic/hernex";

try {
  await checkpointStore.restoreCheckpoint("cp-1");
} catch (error) {
  if (error instanceof HernexCheckpointRestoreError) {
    console.error("Checkpoint restore failed:", error.checkpointId);
    console.error("Compensated files:", error.compensatedPaths);
    console.error(
      "Unrecovered files requiring manual check:",
      error.unrecoveredPaths,
    );
    console.error("Rollback succeeded cleanly:", error.isCompensated);
  }
}
```

---

#### 6. AI SDK v7 Tool Replay & Transcript Projection

`FileThreadStore.getMessages(threadId)` now fully projects persisted transcripts into valid AI SDK v7 model messages.

- **Assistant Tool Calls & Tool Results**: In AI SDK v7, model tool calls in `role: "assistant"` messages require corresponding `role: "tool"` messages containing tool results. Hernex reconstructs these messages losslessly from persisted `toolResult` entries.
- **Residue Filtering**: Incompleted turns from crashes, hook vetoes, or failed model calls are automatically filtered out during replay, ensuring clean message histories without prompt corruption.
- **Transcript Versioning**: Transcripts written with version `1` (or unversioned) are automatically and lazily upgraded to `CURRENT_TRANSCRIPT_VERSION` (version `2`) upon read.

---

### New Features

- **Workspace Transactional File Locking (`withWorkspaceFileLock`)**:
  - Exclusive multi-file mutation locking for concurrent tools and threads (`src/storage/workspaceLock.ts`).
  - Locks are keyed outside the workspace in `<homeDirectory>/locks/workspaces/<workspaceHash>/<targetHash>.lock`.
  - Multi-file operations acquire locks in deterministic lexicographical order to prevent deadlocks and lock inversion.
  - Automatically integrated into `WriteFileTool`, `EditFileTool`, and `FileCheckpointStore.restoreCheckpoint`.

- **POSIX Permission Preservation (`atomicWriteFile`)**:
  - `atomicWriteFile` inspects regular file permissions (`stats.mode & 0o7777`) via `lstat` prior to replacement and restores them on the newly written file.
  - Supports explicit `{ mode: 0o755 }` overrides.

- **Stale Lock Recovery & CAS Arbitration (`withFileLock`)**:
  - Detects abandoned locks from terminated or crashed processes using local OS process liveness probes (`process.kill(pid, 0)` checking for `ESRCH`).
  - Supports configurable `staleMs` expiration for long-hanging processes or network-mounted filesystems.
  - Employs atomic staging and rename arbitration to guarantee live lock holders are never displaced during concurrent recovery.

- **Lossless Acyclic Graph Serialization (`valueCodec`)**:
  - Replaced global traversal sets with an active recursion ancestry stack.
  - Supports valid directed acyclic graphs (DAGs), diamond structures, and shared sibling object references without false circular reference errors.
  - Maintains strict cycle detection rejecting true circular references fail-closed.

- **Process Tree Abort Management (`BashTool`)**:
  - When a foreground bash execution is interrupted via `abortSignal`, `BashTool` issues `taskManager.stopTask(taskId)` and awaits terminal state escalation (`SIGTERM` followed by `SIGKILL`), ensuring background process trees are never orphaned.

---

### Bug Fixes & Resilience Hardening

- **Task Log Persistence Containment**: Protected child stream `data` handlers against disk write failures (e.g. disk full, read-only filesystem). Prevents host process crashes, drains stdout/stderr pipes to prevent buffer stalls, and surfaces `persistenceError` on task metadata.
- **Prototype Pollution Prevention (`valueCodec`)**: Properties are decoded using `Object.defineProperty` instead of direct assignment, safely preserving own `__proto__` properties without altering prototype chains.
- **Null-Prototype Dictionaries**: Added `isNullPrototype: true` support in `EncodedValue`, ensuring `Object.create(null)` objects round-trip without acquiring standard `Object.prototype`.
- **EditFileTool Regex Special Replacements**: Replaced regex string substitution with literal replacer functions, preventing `$1`, `$&`, and `$\`` from corrupting edited source code.
- **Strict Symlink Traversal Protection**: Hardened `pathGuard` to disallow symbolic links pointing outside the workspace across all filesystem and shell tools.
- **Idempotent Turn Finalization**: Protected `runTurn` to guarantee exactly one `turnFinished` event is persisted and emitted even if errors occur in `onError` hooks or transcript serialization.

---

### Publication Details

- Package: `@amaranthic/hernex`
- License: MIT
- Node.js Requirement: `>= 22.0.0`
