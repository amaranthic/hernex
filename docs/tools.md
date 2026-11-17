# Tool Registry & Built-In Tools

Hernex provides a structured tool registry with 9 default built-in tools (for workspace file manipulation, shell command execution, background task management, safe web retrieval, and web search) and an opt-in on-demand Language Server Protocol tool ([`LspTool`](#8-opt-in-semantic-intelligence-lsptool)) for compiler-grade code intelligence.

---

## 1. Implementing Custom Tools

Every tool implements the [`AgentTool`](../src/tools/AgentTool.ts) interface:

```typescript
import { z } from "zod";
import type { AgentTool, ToolExecutionContext } from "@amaranthic/hernex";

export const weatherSchema = z.object({
  city: z.string().describe("City name to fetch weather for"),
});

export class WeatherTool implements AgentTool<
  typeof weatherSchema,
  { temp: number }
> {
  public readonly name = "getWeather";
  public readonly description = "Fetches current temperature for a city.";
  public readonly inputSchema = weatherSchema;

  public async execute(
    params: z.infer<typeof weatherSchema>,
    context: ToolExecutionContext,
  ): Promise<{ temp: number }> {
    context.emitProgress?.(`Querying weather service for ${params.city}...`);
    return { temp: 22 };
  }
}
```

---

## 2. Managing the `ToolRegistry`

Register, override, list, or unregister tools on [`ToolRegistry`](../src/tools/ToolRegistry.ts):

```typescript
import { ToolRegistry } from "@amaranthic/hernex";

const registry = new ToolRegistry({ includeDefaults: true });

registry.register(new WeatherTool());
registry.unregister("glob");

console.log("Registered tools:", registry.list());
```

---

## 3. Filesystem Security & Path Containment

All built-in file tools ([`ReadFileTool`](../src/tools/ReadFileTool.ts), [`WriteFileTool`](../src/tools/WriteFileTool.ts), [`EditFileTool`](../src/tools/EditFileTool.ts), [`GlobTool`](../src/tools/GlobTool.ts), [`GrepTool`](../src/tools/GrepTool.ts)) enforce strict boundary checks:

- Paths are verified to reside strictly within `workingDirectory`.
- Symlink traversal outside the workspace boundary is detected via `lstat` and strictly denied.
- Writes and edits use atomic sibling temporary file replacement (`atomicWriteFile`) to guarantee zero torn writes while preserving POSIX file permissions.
- Concurrent file operations acquire exclusive multi-file locks (`withWorkspaceFileLock`) ordered lexicographically to eliminate race conditions and deadlocks across threads.

### 3.1 File Discovery (`GlobTool`)

- `pattern` (required): Glob pattern to match files against (e.g. `'**/*.ts'`).
- `directoryPath` (optional): Directory to search within. Defaults to the workspace root.

### 3.2 Content Search (`GrepTool`)

- `pattern` (required): Regular expression pattern to search for in file contents.
- `filePath` (optional): Single file to search within. Mutually exclusive with `directoryPath`.
- `directoryPath` (optional): Directory scope to search within. Mutually exclusive with `filePath`. Defaults to workspace root when neither is provided.
- `glob` (optional): Glob pattern to filter files within the directory (e.g. `'*.ts'`).
- `caseInsensitive` (optional): Whether to perform case-insensitive matching.
- `headLimit` (optional, default: 250): Maximum number of match entries to return.

---

## 4. Shell Execution: `BashTool` & `TaskManager`

Hernex includes two complementary process tools:

1. **`BashTool` (`bash`)**: Model-facing command executor with automatic background handoff.
2. **`TaskManagerTool` (`taskManager`)**: Model-facing tool to list, read, send stdin, and stop background tasks.

Both tools share a single process owner: [`TaskManager`](../src/tasks/TaskManager.ts).

> [!WARNING]
> **Bash is NOT a Filesystem Sandbox.**
> Commands executed by `BashTool` run as the current operating system user with full host permissions. While Hernex sanitizes sensitive environment variables (stripping keys matching `KEY`, `SECRET`, `TOKEN`, `PASSWORD`), it does **not** sandbox host filesystem access. Always enforce policy via `onAuthorizeTool`, and inspect or redact command results via `onPostTool`.

### 4.1 Shell Command Execution (`BashTool`)

- `command` (required): Shell string to execute.
- `waitMsBeforeAsync` (optional, default: `10000` ms): How long to wait before handing off to a background task (`0` = immediate background).
- `timeoutMs` (optional): Hard process lifetime; exceeding this stops the process.

### 4.2 Background Task Management (`TaskManagerTool`)

Supports discriminated actions:

- `action: "list"`: Lists active and completed tasks with runtime, status, exit code, and line count.
- `action: "read"`: Line-paged file read of task output logs (`offset`, `limit`).
- `action: "sendInput"`: Sends text to standard input (`input`, optional `newline`).
- `action: "stop"`: Sends `SIGTERM` (escalating to `SIGKILL` after grace period).
- `action: "delete"`: Deletes metadata and logs of terminal tasks.

---

## 5. File Delta Checkpoints

When checkpointing is enabled (`checkpoint: true`), `WriteFileTool` and `EditFileTool` snapshot file changes automatically:

- Pre-mutation state is recorded before writing.
- Post-mutation state is updated after successful writes.
- If an uncommitted external modification creates a conflict, `restoreCheckpoint` rejects the rollback cleanly unless `force: true` is passed.
- On multi-file restore failure, reverse-order compensation restores mutated files to their pre-rollback baseline and throws `HernexCheckpointRestoreError` containing `compensatedPaths` and `unrecoveredPaths`.

---

## 6. Safe Web Retrieval: `WebFetchTool`

[`WebFetchTool`](../src/tools/WebFetchTool.ts) (`webFetch`) retrieves external web pages, converts HTML into clean Markdown via Turndown, and provides optional model-driven targeted extraction using Hernex's `generateText` runtime.

### 6.1 Security & SSRF Protection

All outbound requests pass through [`ssrfGuard`](../src/tools/internal/ssrfGuard.ts) powered by `ipaddr.js`:

- **IP Filtering**: Strictly rejects loopback (`127.0.0.1`, `::1`), private networks (`10.0.0.0/8`, `172.16.0.0/12`, `192.168.0.0/16`), carrier-grade NAT (`100.64.0.0/10`), link-local / IMDS addresses (`169.254.169.254`, `fe80::/10`), and IPv6 unique local (`fc00::/7`).
- **Host Restrictions**: Blocks single-label hostnames (e.g. `corpnas`, `router`), local domain suffixes (`.local`, `.internal`, `.localhost`, `.lan`), cloud metadata hostnames (`metadata.google.internal`, `instance-data`), and embedded basic auth credentials (`https://user:pass@...`).
- **Cross-Host Redirect Halts**: Follows same-host and `www.` redirects up to 5 hops, but immediately halts on cross-host redirects and surfaces a notice so the agent retains full oversight over domain transitions.

### 6.2 Caching & Content Conversion

- **15-Minute Response Cache**: Successful HTTP responses are cached in memory for 15 minutes (`cacheTtlMs: 900,000`). Subsequent queries for the same URL return cached Markdown (`cached: true`) without redundant network latency.
- **HTML to Markdown**: Converts HTML via `TurndownService`, stripping `<script>`, `<style>`, `<noscript>`, `<svg>`, and `<iframe>` elements while preserving headings, bolding, lists, and markdown links.
- **JSON & Text**: Formats `application/json` responses into syntax-highlighted code blocks, and returns plain text as-is.

### 6.3 Parameters & Usage

- `url` (required): Valid HTTP or HTTPS URL to fetch.
- `prompt` (optional): Focused question or instruction to extract specific answers from the webpage content.
  - **Omitted `prompt`**: Returns full page Markdown directly with zero extra token latency.
  - **Provided `prompt`**: Executes a single-turn `generateText` call using the active model, credentials, and abort signal passed from the turn execution context, with up to 5 retry attempts and exponential backoff on transient errors.

---

## 7. High-Reliability Web Search: `WebSearchTool`

[`WebSearchTool`](../src/tools/WebSearchTool.ts) (`webSearch`) performs web searches via a native DuckDuckGo engine with automatic redirect unwrapping, HTML-to-Markdown snippet conversion via Turndown, pagination, time/region filtering, and 15-minute response caching.

### 7.1 Architecture & Failover Strategy

- **Primary Provider**: Issues standard HTTP `GET` requests to `https://html.duckduckgo.com/html/` with realistic desktop/mobile User-Agents, HTTP standard navigation headers, and randomized human-like timing jitter (100–300ms).
- **Automatic Fallback**: If the primary endpoint encounters rate limiting or an anomaly check, the engine seamlessly fails over to `https://lite.duckduckgo.com/lite/` so queries succeed without manual intervention.
- **Zero Headless Browsers**: Operates entirely with lightweight HTTP `fetch`, avoiding the overhead, memory footprint, and bot-challenge vulnerabilities of headless browsers.
- **Direct Link Unwrapping**: DuckDuckGo redirect URLs (`//duckduckgo.com/l/?uddg=...`) are automatically resolved and decoded to provide the agent with direct canonical target URLs.
- **Instant Answers**: Concurrently queries `https://api.duckduckgo.com/` on first-page searches to retrieve Wikipedia abstracts, entity headings, and related topic links.

### 7.2 Parameters & Input Schema

| Parameter        | Type                                            | Default      | Description                                                                  |
| :--------------- | :---------------------------------------------- | :----------- | :--------------------------------------------------------------------------- |
| `query`          | `string`                                        | _(required)_ | Search query terms or question.                                              |
| `limit`          | `number` (1–25)                                 | `10`         | Maximum number of results to return.                                         |
| `offset`         | `number`                                        | `0`          | Pagination offset index (e.g. `0` for page 1, `10` for page 2).              |
| `time`           | `"all" \| "day" \| "week" \| "month" \| "year"` | `"all"`      | Filters results by publication date range.                                   |
| `safeSearch`     | `"strict" \| "moderate" \| "off"`               | `"moderate"` | SafeSearch moderation level.                                                 |
| `region`         | `string`                                        | `undefined`  | Geographic region / language code (e.g. `"us-en"`, `"uk-en"`, `"in-en"`).    |
| `allowedDomains` | `string[]`                                      | `undefined`  | Restricts results strictly to the specified domains (e.g. `["github.com"]`). |
| `blockedDomains` | `string[]`                                      | `undefined`  | Excludes results matching the specified domains.                             |

### 7.3 Output Contract

```typescript
interface WebSearchOutput {
  readonly query: string;
  readonly results: readonly DuckDuckGoSearchResultItem[];
  readonly totalResults: number;
  readonly offset: number;
  readonly nextOffset?: number | undefined;
  readonly hasNextPage: boolean;
  readonly cached: boolean;
  readonly durationMs: number;
  readonly instantAnswer?: DuckDuckGoInstantAnswer | undefined;
  readonly content: string; // Pre-formatted Markdown representation
}
```

### 7.4 Example Usage

```typescript
import { createWebSearchTool } from "@amaranthic/hernex";

const searchTool = createWebSearchTool();

const result = await searchTool.execute(
  {
    query: "typescript 5.8 features",
    time: "month",
    limit: 5,
    allowedDomains: ["devblogs.microsoft.com", "github.com"],
  },
  context,
);

console.log(result.content); // Clean Turndown Markdown output
```

---

## 8. Opt-In Semantic Intelligence (`LspTool`)

[`LspTool`](../src/tools/LspTool.ts) (`lsp`) provides semantic, compiler-grade intelligence (type signatures, definitions, cross-file references, document symbols, and diagnostics) by orchestrating Language Server Protocol (LSP) queries against an in-memory process pool.

> **Note**: `LspTool` is an **opt-in** tool and is **not** included in the default 9-tool suite registered by `new ToolRegistry({ includeDefaults: true })`. Callers must supply an explicit `servers` configuration object. No default servers are hardcoded into Hernex.

### 8.1 Architecture & Process Safety

- **Persistent Process Pool**: `LspTool` instantiates and manages an in-memory `LspProcessPool`. Server binaries are spawned lazily on first query and kept warm across invocations to avoid repeated startup overhead.
- **Wire Protocol**: Communicates using `vscode-jsonrpc` over standard input and output streams.
- **Idle Teardown**: Inactive server processes are automatically shut down after a configurable idle duration (`idleTimeoutMs`, defaulting to 5 minutes) to conserve system memory and CPU.
- **Circuit Breaker**: Detects consecutive crash failures. If a server crashes 3 consecutive times during startup, the circuit breaker opens and refuses further respawns to avoid infinite crash loops.
- **Zero Zombie Processes**: All spawned child process PIDs are registered globally. Handlers on `process.on("exit")`, `SIGINT`, `SIGTERM`, and `beforeExit` guarantee that all language server processes are cleanly terminated when the host process shuts down.
- **Explicit Lifecycle Management**: Call `lspTool.dispose()` to immediately terminate all running server instances.

### 8.2 Supported Operations

| Operation            | Description                                                   | Coordinates Required       |
| :------------------- | :------------------------------------------------------------ | :------------------------- |
| `hover`              | Type signature and documentation at a position                | Line & Character (1-based) |
| `goToDefinition`     | Source location(s) where a symbol is defined                  | Line & Character (1-based) |
| `goToImplementation` | Concrete implementation(s) of an interface or abstract member | Line & Character (1-based) |
| `findReferences`     | All locations referencing a symbol across the workspace       | Line & Character (1-based) |
| `documentSymbol`     | Full symbol outline tree of the target file                   | Omitted / Optional         |
| `workspaceSymbol`    | Search symbols across the workspace via optional `query`      | Omitted / Optional         |
| `diagnostics`        | Language server compiler errors, warnings, and hints          | Omitted / Optional         |

### 8.3 Smart Severity Precedence

Diagnostics results are formatted into clean Markdown with automatic severity hierarchy:

- If **Errors** exist: Up to 5 errors are displayed in full, followed by a collapsed note summarizing any warnings or hints (e.g. `_(also has 3 warnings)_`).
- If only **Warnings** exist: Up to 5 warnings are displayed in full, followed by a collapsed note for hints.
- If clean: Outputs `Clean — 0 errors, 0 warnings.`

### 8.4 Example Usage

```typescript
import { ToolRegistry, LspTool, type LspToolConfig } from "@amaranthic/hernex";

const registry = new ToolRegistry({ includeDefaults: true });

// Register with explicit server configurations:
const lspConfig: LspToolConfig = {
  servers: {
    typescript: {
      command: "typescript-language-server",
      args: ["--stdio"],
      extensions: [".ts", ".tsx", ".js"],
    },
    rust: {
      command: "rust-analyzer",
      extensions: [".rs"],
    },
  },
  idleTimeoutMs: 300_000, // 5 minutes (default)
};

const lspTool = new LspTool(lspConfig);
registry.register(lspTool);

// Clean up when shutting down the agent runtime:
await lspTool.dispose();
```
