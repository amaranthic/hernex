# Lifecycle Hooks & Authorization

Hernex provides inward interception hooks via [`AgentHooks`](../src/hooks/types.ts). Hooks allow applications to enforce security authorization, sanitize tool inputs, inspect and mutate tool results, inject dynamic `<system-reminder>` context, evaluate task completion, and observe errors.

---

## 1. Defining Hooks

Hooks are configured on `AgentEngineConfig.hooks`:

```typescript
import {
  type AgentHooks,
  type PermissionDecision,
  type PostToolResult,
} from "@amaranthic/hernex";

const hooks: AgentHooks = {
  // Pre-turn modification or veto
  onBeforeTurn: async ({ turnIndex, userPrompt }) => {
    if (userPrompt.includes("forbidden")) {
      return { veto: true, vetoReason: "Policy violation: forbidden keyword" };
    }
    return {
      injectedInstructions: "Be concise and format code snippets in markdown.",
    };
  },

  // Mandatory fail-closed tool authorization and parameter sanitization
  onAuthorizeTool: async ({ toolName, parameters, workingDirectory }) => {
    if (toolName === "bash") {
      // Prompt user or evaluate safety policy
      return { decision: "deny", reason: "Bash execution is restricted." };
    }
    // Optionally sanitize or normalize input parameters before execution
    return {
      decision: "allow",
      updatedParameters: parameters,
    };
  },

  // Post-tool inspection, secret redaction, formatting, and model feedback
  onPostTool: async ({
    toolName,
    parameters,
    result,
    isError,
    durationMs,
    workingDirectory,
  }) => {
    // Automatically redact secrets or format touched files
    if (toolName === "writeFile") {
      return {
        additionalContext: "Linter verified syntax: 0 errors.",
      };
    }
  },

  // Completion decision when model stops proposing tools
  onShouldStop: async ({ turnIndex, finishReason, transcript }) => {
    // Return shouldStop: false with a reminderPrompt to guide the model further
    return { shouldStop: true };
  },

  // Guaranteed post-turn cleanup
  onAfterTurn: async ({ turnIndex, finishReason, totalUsage }) => {
    console.log(`Turn ${turnIndex} finalized with reason "${finishReason}"`);
  },

  // Diagnostic notification
  onError: async ({ error, origin, turnIndex, isFatal }) => {
    console.error(`Diagnostic error [${origin}] in turn ${turnIndex}:`, error);
  },
};
```

---

## 2. Fail-Closed Tool Authorization & Input Mutation

> [!CAUTION]
> **All tools fail closed by default.**
> If `hooks.onAuthorizeTool` is omitted or undefined, the engine denies **all** tool executions.
> If an authorization hook throws an unhandled error, the engine treats it as an immediate denial and emits an error event. Tool execution never proceeds on a thrown error.

Pre-tool hooks can also sanitize, normalize, or enrich tool parameters prior to execution by returning `updatedParameters`:

```typescript
onAuthorizeTool: async ({ toolName, parameters }) => {
  if (toolName === "editFile") {
    const raw = parameters as { path: string };
    return {
      decision: "allow",
      updatedParameters: {
        ...raw,
        path: path.normalize(raw.path),
      },
    };
  }
  return { decision: "allow" };
};
```

---

## 3. Post-Tool Execution & Output Transformation (`onPostTool`)

The `onPostTool` hook executes immediately after a tool finishes running (whether successfully or in an error state), but _before_ the result is committed to the conversation transcript or sent to the model.

```typescript
export interface PostToolContext {
  readonly toolName: string;
  readonly parameters: unknown;
  readonly result: unknown;
  readonly isError: boolean;
  readonly durationMs: number;
  readonly workingDirectory: string;
}
```

### 3.1 Result Mutation (`updatedResult`)

Hooks can replace or sanitize the output returned by a tool (e.g. redacting API keys, truncating giant outputs, or pretty-printing JSON). The mutated result is the single source of truth persisted in `ThreadStore` and sent to the LLM:

```typescript
onPostTool: async ({ result }) => {
  const sanitized = redactSensitiveTokens(result);
  return { updatedResult: sanitized };
};
```

### 3.2 Feedback & Context Injection (`additionalContext`)

Hooks can inject high-priority feedback (such as linter warnings, compiler errors, or test results) directly into the agent's turn. Hernex automatically wraps `additionalContext` in standardized `<system-reminder>` XML tags, matching frontier agent conventions:

```typescript
onPostTool: async ({ toolName, isError }) => {
  if (toolName === "bash" && !isError) {
    return {
      additionalContext: "Git branch is currently 'main'. Commit with care.",
    };
  }
};
```

When received by the model, the message is delivered alongside the tool output:

```xml
[Tool Output]

<system-reminder>
PostTool:bash hook additional context:
Git branch is currently 'main'. Commit with care.
</system-reminder>
```

### 3.3 Fault Isolation

Errors thrown inside `onPostTool` are contained. They are emitted as diagnostic events with `origin: "hook"` and routed to `onError` with `isFatal: false`. An unexpected failure in a formatting or linting hook will never crash the autonomous turn loop.

---

## 4. Composing Multiple Hook Layers

When multiple modules or plugins provide hooks, combine them deterministically with [`composeAgentHooks`](../src/hooks/composeAgentHooks.ts):

```typescript
import { composeAgentHooks, type AgentHooks } from "@amaranthic/hernex";

const securityLayer: AgentHooks = {
  onAuthorizeTool: async ({ toolName, parameters }) => {
    if (toolName === "bash") {
      return { decision: "deny", reason: "Disabled by security policy" };
    }
    return { decision: "allow" };
  },
};

const linterLayer: AgentHooks = {
  onPostTool: async ({ toolName }) => {
    if (toolName === "writeFile") {
      return { additionalContext: "Running typecheck: OK" };
    }
  },
};

const loggingLayer: AgentHooks = {
  onBeforeTurn: async ({ userPrompt }) => {
    console.log("Observing prompt:", userPrompt);
  },
  onAfterTurn: async ({ finishReason }) => {
    console.log("Turn finished:", finishReason);
  },
};

const composedHooks = composeAgentHooks([
  securityLayer,
  linterLayer,
  loggingLayer,
]);
```

### Composition Ordering Semantics

1. **`onBeforeTurn`**: Executed in array order. Each hook receives the updated effective prompt. Non-empty injected instructions concatenate with `\n\n`. Any veto immediately short-circuits subsequent hooks and aborts the turn.
2. **`onAuthorizeTool`**: Executed sequentially. Every layer must return `{ decision: "allow" }`. A single deny or thrown error denies execution. Any `updatedParameters` returned are pipelined so subsequent layers inspect the sanitized arguments.
3. **`onPostTool`**: Executed sequentially. `updatedResult` mutations are pipelined across layers. All `additionalContext` strings are collected and joined with `\n\n`. Unhandled layer exceptions are contained without interrupting remaining layers.
4. **`onShouldStop`**: All layers must return `shouldStop: true` to stop. If any layer returns `shouldStop: false`, execution continues, concatenating reminder prompts in layer order.
5. **`onAfterTurn`**: Every layer runs inside the `finally` block even if a prior layer fails.
6. **`onError`**: Called at most once per layer. Failures within an error hook do not trigger recursive error dispatch.
