/**
 * @fileoverview Markdown formatters for LSP operation results.
 *
 * All formatters produce clean, agent-readable Markdown strings.
 * They are pure functions — no I/O, no side effects.
 *
 * **Diagnostic severity precedence rules:**
 * - If errors exist → show up to 5 errors, then append `"(also has X warnings)"` note.
 * - If warnings only → show up to 5 warnings, then append `"(also has X hints)"` note.
 * - If only info/hints → show up to 5 info/hint items.
 * - If clean → `"✅ No issues found (0 errors, 0 warnings)."`.
 *
 * @packageDocumentation
 */

import { relative } from "node:path";
import { fileURLToPath } from "node:url";
import type { LspDiagnostic } from "./types.js";
import { LspDiagnosticSeverity } from "./types.js";

/** Maximum number of items shown per formatter output. */
const MAX_SHOWN = 5;

// ─────────────────────────────────────────────────────────────────────────────
// Diagnostics
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Formats an array of {@link LspDiagnostic} items using smart severity
 * precedence: the highest-priority bucket is shown in full; lower-priority
 * buckets are summarized with a trailing note.
 *
 * @param diagnostics - Raw diagnostics from the LSP server (may be empty).
 * @param filePath - Absolute path to the file (used in item labels).
 * @returns Formatted Markdown string.
 *
 * @example
 * ```typescript
 * const md = formatDiagnostics(diags, "/home/user/project/src/index.ts");
 * // **Diagnostics** — `src/index.ts`
 * // **Error** (2)
 * //   - `14:3` [typescript/2345] Cannot find name 'foo'.
 * //   - `22:1` [typescript/1005] '}' expected.
 * // _(also has 3 warnings)_
 * ```
 */
export function formatDiagnostics(
  diagnostics: LspDiagnostic[],
  filePath: string,
): string {
  const fileName = filePath.split("/").pop() ?? filePath;
  const header = `**Diagnostics** — \`${fileName}\`\n`;

  if (diagnostics.length === 0) {
    return header + "Clean — 0 errors, 0 warnings.";
  }

  const errors = diagnostics.filter(
    (d) =>
      d.severity === LspDiagnosticSeverity.Error || d.severity === undefined,
  );
  const warnings = diagnostics.filter(
    (d) => d.severity === LspDiagnosticSeverity.Warning,
  );
  const infos = diagnostics.filter(
    (d) =>
      d.severity === LspDiagnosticSeverity.Information ||
      d.severity === LspDiagnosticSeverity.Hint,
  );

  const lines: string[] = [header];

  if (errors.length > 0) {
    lines.push(`**Error** (${errors.length})`);
    const shown = errors.slice(0, MAX_SHOWN);
    for (const d of shown) {
      lines.push(`  - ${formatDiagnosticItem(d)}`);
    }
    if (errors.length > MAX_SHOWN) {
      lines.push(`  _…and ${errors.length - MAX_SHOWN} more errors_`);
    }
    const lowerCount = warnings.length + infos.length;
    if (lowerCount > 0) {
      const parts: string[] = [];
      if (warnings.length > 0)
        parts.push(
          `${warnings.length} warning${warnings.length !== 1 ? "s" : ""}`,
        );
      if (infos.length > 0)
        parts.push(`${infos.length} hint${infos.length !== 1 ? "s" : ""}`);
      lines.push(`_(also has ${parts.join(" and ")})_`);
    }
  } else if (warnings.length > 0) {
    lines.push(`**Warning** (${warnings.length})`);
    const shown = warnings.slice(0, MAX_SHOWN);
    for (const d of shown) {
      lines.push(`  - ${formatDiagnosticItem(d)}`);
    }
    if (warnings.length > MAX_SHOWN) {
      lines.push(`  _…and ${warnings.length - MAX_SHOWN} more warnings_`);
    }
    if (infos.length > 0) {
      lines.push(
        `_(also has ${infos.length} hint${infos.length !== 1 ? "s" : ""})_`,
      );
    }
  } else {
    lines.push(`**Info/Hint** (${infos.length})`);
    const shown = infos.slice(0, MAX_SHOWN);
    for (const d of shown) {
      lines.push(`  - ${formatDiagnosticItem(d)}`);
    }
    if (infos.length > MAX_SHOWN) {
      lines.push(`  _…and ${infos.length - MAX_SHOWN} more hints_`);
    }
  }

  return lines.join("\n");
}

/**
 * Formats a single diagnostic item as a compact inline string.
 *
 * @param d - Single diagnostic record.
 * @returns Formatted string like `` `14:3` [typescript/2345] Cannot find name 'foo'. ``
 */
function formatDiagnosticItem(d: LspDiagnostic): string {
  const pos = `\`${d.startLine}:${d.startCharacter}\``;
  const tag = formatDiagnosticTag(d);
  return `${pos}${tag} ${d.message}`;
}

/**
 * Formats the `[source/code]` tag portion of a diagnostic item.
 *
 * @param d - Diagnostic record.
 * @returns Tag string like `" [typescript/2345]"` or `""` if no source/code.
 */
function formatDiagnosticTag(d: LspDiagnostic): string {
  const parts: string[] = [];
  if (d.source) parts.push(d.source);
  if (d.code !== undefined) parts.push(String(d.code));
  return parts.length > 0 ? ` [${parts.join("/")}]` : "";
}

// ─────────────────────────────────────────────────────────────────────────────
// Hover
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Formats the raw result of a `textDocument/hover` LSP response.
 *
 * @param result - Raw hover result from the language server (`null` or object).
 * @returns Formatted Markdown string.
 *
 * @example
 * ```typescript
 * const md = formatHover({ contents: { kind: "plaintext", value: "const x: number" } });
 * // **Hover**
 * // ```
 * // const x: number
 * // ```
 * ```
 */
export function formatHover(result: unknown): string {
  if (result === null || result === undefined) {
    return "**Hover**\n_No information available at this position._";
  }

  const r = result as Record<string, unknown>;
  const contents = r["contents"];

  if (!contents) {
    return "**Hover**\n_No information available at this position._";
  }

  let text = "";

  if (typeof contents === "string") {
    text = contents;
  } else if (Array.isArray(contents)) {
    text = (contents as unknown[])
      .map((c) => extractMarkupContent(c))
      .filter(Boolean)
      .join("\n\n");
  } else {
    text = extractMarkupContent(contents);
  }

  if (!text.trim()) {
    return "**Hover**\n_No information available at this position._";
  }

  return `**Hover**\n${text}`;
}

/**
 * Extracts text from a LSP `MarkupContent` or `MarkedString` value.
 *
 * @param content - Raw content value from LSP hover response.
 * @returns Plain or fenced text string.
 */
function extractMarkupContent(content: unknown): string {
  if (typeof content === "string") return content;
  const c = content as Record<string, unknown>;
  if (c["kind"] === "markdown" && typeof c["value"] === "string") {
    return String(c["value"]);
  }
  if (c["kind"] === "plaintext" && typeof c["value"] === "string") {
    return "```\n" + String(c["value"]) + "\n```";
  }
  if (typeof c["value"] === "string") {
    // MarkedString with language
    const lang = typeof c["language"] === "string" ? c["language"] : "";
    return "```" + lang + "\n" + String(c["value"]) + "\n```";
  }
  return "";
}

// ─────────────────────────────────────────────────────────────────────────────
// Location lists (definition / implementation / references)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Formats a list of LSP `Location` or `LocationLink` objects.
 *
 * Used for `goToDefinition`, `goToImplementation`, and `findReferences`.
 *
 * @param result - Raw array of locations (or `null`/single object).
 * @param label - Section label (e.g. `"Definition"`, `"References"`).
 * @param workingDirectory - Workspace root for computing relative paths.
 * @returns Formatted Markdown string with up to {@link MAX_SHOWN} entries.
 *
 * @example
 * ```typescript
 * const md = formatLocations(locations, "References", "/home/user/project");
 * // **References** (3)
 * //   - `src/utils.ts:12:5`
 * //   - `src/index.ts:22:1`
 * //   - `tests/utils.test.ts:8:3`
 * ```
 */
export function formatLocations(
  result: unknown,
  label: string,
  workingDirectory: string,
): string {
  const header = `**${label}**`;

  if (result === null || result === undefined) {
    return `${header}\n_No ${label.toLowerCase()} found._`;
  }

  const items = Array.isArray(result) ? result : [result];
  if (items.length === 0) {
    return `${header}\n_No ${label.toLowerCase()} found._`;
  }

  const lines: string[] = [`${header} (${items.length})`];
  const shown = items.slice(0, MAX_SHOWN);

  for (const item of shown) {
    const loc = extractLocation(item as Record<string, unknown>);
    if (!loc) continue;
    const relPath = safeRelative(workingDirectory, loc.path);
    lines.push(`  - \`${relPath}:${loc.line}:${loc.character}\``);
  }

  if (items.length > MAX_SHOWN) {
    lines.push(`  _…and ${items.length - MAX_SHOWN} more_`);
  }

  return lines.join("\n");
}

/**
 * Extracts a normalized location from a raw LSP `Location` or `LocationLink`.
 *
 * @param raw - Raw location object from LSP wire.
 * @returns Normalized path and 1-based position, or `null` if unreadable.
 */
function extractLocation(
  raw: Record<string, unknown>,
): { path: string; line: number; character: number } | null {
  try {
    // LocationLink uses targetUri/targetRange
    const uri =
      typeof raw["uri"] === "string"
        ? raw["uri"]
        : typeof raw["targetUri"] === "string"
          ? raw["targetUri"]
          : null;

    const range =
      (raw["range"] as Record<string, unknown> | undefined) ??
      (raw["targetSelectionRange"] as Record<string, unknown> | undefined) ??
      (raw["targetRange"] as Record<string, unknown> | undefined);

    if (!uri || !range) return null;

    const start = range["start"] as Record<string, unknown> | undefined;
    if (!start) return null;

    const filePath = uri.startsWith("file://") ? fileURLToPath(uri) : uri;
    return {
      path: filePath,
      line: ((start["line"] as number) ?? 0) + 1,
      character: ((start["character"] as number) ?? 0) + 1,
    };
  } catch {
    return null;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Document symbols
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Formats the raw result of a `textDocument/documentSymbol` LSP response.
 *
 * @param result - Raw symbol array (may be `SymbolInformation[]` or
 *   `DocumentSymbol[]`).
 * @returns Formatted Markdown string with up to {@link MAX_SHOWN} symbols.
 *
 * @example
 * ```typescript
 * const md = formatDocumentSymbols(symbols);
 * // **Document Symbols** (5)
 * //   - `MyClass` (Class) — 10:1
 * //   - `myMethod` (Method) — 15:3
 * ```
 */
export function formatDocumentSymbols(result: unknown): string {
  const header = "**Document Symbols**";

  if (!Array.isArray(result) || result.length === 0) {
    return `${header}\n_No symbols found._`;
  }

  const lines: string[] = [`${header} (${result.length})`];
  const shown = (result as Record<string, unknown>[]).slice(0, MAX_SHOWN);

  for (const sym of shown) {
    const name = typeof sym["name"] === "string" ? sym["name"] : "?";
    const kind = resolveSymbolKind(sym["kind"] as number | undefined);

    // DocumentSymbol has `selectionRange`; SymbolInformation has `location.range`
    const range =
      (sym["selectionRange"] as Record<string, unknown> | undefined) ??
      ((sym["location"] as Record<string, unknown> | undefined)?.["range"] as
        Record<string, unknown> | undefined);

    const start = range?.["start"] as Record<string, unknown> | undefined;
    const lineNum = start ? ((start["line"] as number) ?? 0) + 1 : "?";
    const charNum = start ? ((start["character"] as number) ?? 0) + 1 : "?";

    lines.push(`  - \`${name}\` (${kind}) — ${lineNum}:${charNum}`);
  }

  if (result.length > MAX_SHOWN) {
    lines.push(`  _…and ${result.length - MAX_SHOWN} more symbols_`);
  }

  return lines.join("\n");
}

// ─────────────────────────────────────────────────────────────────────────────
// Workspace symbols
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Formats the raw result of a `workspace/symbol` LSP response.
 *
 * @param result - Raw workspace symbol array.
 * @param workingDirectory - Workspace root for relative path computation.
 * @returns Formatted Markdown string with up to {@link MAX_SHOWN} symbols.
 *
 * @example
 * ```typescript
 * const md = formatWorkspaceSymbols(symbols, "/home/user/project");
 * // **Workspace Symbols** (12)
 * //   - `AgentEngine` (Class) — src/engine/AgentEngine.ts:10:1
 * ```
 */
export function formatWorkspaceSymbols(
  result: unknown,
  workingDirectory: string,
): string {
  const header = "**Workspace Symbols**";

  if (!Array.isArray(result) || result.length === 0) {
    return `${header}\n_No symbols found._`;
  }

  const lines: string[] = [`${header} (${result.length})`];
  const shown = (result as Record<string, unknown>[]).slice(0, MAX_SHOWN);

  for (const sym of shown) {
    const name = typeof sym["name"] === "string" ? sym["name"] : "?";
    const kind = resolveSymbolKind(sym["kind"] as number | undefined);
    const loc = sym["location"] as Record<string, unknown> | undefined;

    if (!loc) {
      lines.push(`  - \`${name}\` (${kind})`);
      continue;
    }

    const uri = typeof loc["uri"] === "string" ? loc["uri"] : null;
    const range = loc["range"] as Record<string, unknown> | undefined;
    const start = range?.["start"] as Record<string, unknown> | undefined;

    const lineNum = start ? ((start["line"] as number) ?? 0) + 1 : "?";
    const charNum = start ? ((start["character"] as number) ?? 0) + 1 : "?";

    if (uri) {
      const filePath = uri.startsWith("file://") ? fileURLToPath(uri) : uri;
      const relPath = safeRelative(workingDirectory, filePath);
      lines.push(
        `  - \`${name}\` (${kind}) — ${relPath}:${lineNum}:${charNum}`,
      );
    } else {
      lines.push(`  - \`${name}\` (${kind}) — ${lineNum}:${charNum}`);
    }
  }

  if (result.length > MAX_SHOWN) {
    lines.push(`  _…and ${result.length - MAX_SHOWN} more_`);
  }

  return lines.join("\n");
}

// ─────────────────────────────────────────────────────────────────────────────
// Shared helpers
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Maps a LSP `SymbolKind` integer to a human-readable label.
 *
 * @param kind - LSP SymbolKind numeric value (1–26).
 * @returns Human-readable kind label, or `"Symbol"` as a fallback.
 */
function resolveSymbolKind(kind: number | undefined): string {
  const map: Record<number, string> = {
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
  return kind !== undefined ? (map[kind] ?? "Symbol") : "Symbol";
}

/**
 * Returns a relative path from `from` to `to`, or `to` itself if the
 * `relative()` call throws or would start with `../..` (outside workspace).
 *
 * @param from - Workspace root (absolute path).
 * @param to - Target file path (absolute).
 * @returns Relative path string.
 */
function safeRelative(from: string, to: string): string {
  try {
    const rel = relative(from, to);
    return rel || to;
  } catch {
    return to;
  }
}
