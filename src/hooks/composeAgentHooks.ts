/**
 * @fileoverview Deterministic hook composition implementation for Hernex.
 * @packageDocumentation
 */

import type {
  AgentHooks,
  BeforeTurnContext,
  BeforeTurnResult,
  AfterTurnContext,
  ShouldStopContext,
  StopDecision,
  AuthorizeToolContext,
  PermissionDecision,
  PostToolContext,
  PostToolResult,
  ErrorContext,
} from "./types.js";

/**
 * Composes multiple AgentHooks layers into a single composite AgentHooks object
 * with deterministic execution and aggregation rules.
 *
 * @param layers - Array of AgentHooks configurations ordered from innermost/first to outermost/last.
 * @returns A single composed AgentHooks container.
 */
export function composeAgentHooks(layers: readonly AgentHooks[]): AgentHooks {
  const activeLayers = layers.filter((layer) => Boolean(layer));

  if (activeLayers.length === 0) {
    return {};
  }

  const composed: AgentHooks = {
    onBeforeTurn: activeLayers.some((layer) => layer.onBeforeTurn)
      ? async (
          context: BeforeTurnContext,
        ): Promise<BeforeTurnResult | void> => {
          let currentPrompt = context.userPrompt;
          const instructionsList: string[] = [];

          for (const layer of activeLayers) {
            if (!layer.onBeforeTurn) {
              continue;
            }
            const result = await layer.onBeforeTurn({
              turnIndex: context.turnIndex,
              userPrompt: currentPrompt,
            });

            if (!result) {
              continue;
            }

            if (result.userPrompt !== undefined) {
              currentPrompt = result.userPrompt;
            }

            if (
              result.injectedInstructions &&
              result.injectedInstructions.trim().length > 0
            ) {
              instructionsList.push(result.injectedInstructions.trim());
            }

            if (result.veto) {
              const res: BeforeTurnResult = {
                veto: true,
                ...(result.vetoReason !== undefined
                  ? { vetoReason: result.vetoReason }
                  : {}),
                ...(currentPrompt !== context.userPrompt
                  ? { userPrompt: currentPrompt }
                  : {}),
                ...(instructionsList.length > 0
                  ? { injectedInstructions: instructionsList.join("\n\n") }
                  : {}),
              };
              return res;
            }
          }

          const finalRes: BeforeTurnResult = {
            ...(currentPrompt !== context.userPrompt
              ? { userPrompt: currentPrompt }
              : {}),
            ...(instructionsList.length > 0
              ? { injectedInstructions: instructionsList.join("\n\n") }
              : {}),
          };
          return finalRes;
        }
      : undefined,

    onShouldStop: activeLayers.some((layer) => layer.onShouldStop)
      ? async (context: ShouldStopContext): Promise<StopDecision> => {
          const reminderPrompts: string[] = [];
          let shouldStopAll = true;

          for (const layer of activeLayers) {
            if (!layer.onShouldStop) {
              continue;
            }
            const decision = await layer.onShouldStop(context);
            if (!decision.shouldStop) {
              shouldStopAll = false;
              if (
                decision.reminderPrompt &&
                decision.reminderPrompt.trim().length > 0
              ) {
                reminderPrompts.push(decision.reminderPrompt.trim());
              }
            }
          }

          if (shouldStopAll) {
            return { shouldStop: true };
          }

          return {
            shouldStop: false,
            reminderPrompt: reminderPrompts.join("\n\n"),
          };
        }
      : undefined,

    onAuthorizeTool: activeLayers.some((layer) => layer.onAuthorizeTool)
      ? async (context: AuthorizeToolContext): Promise<PermissionDecision> => {
          let currentParameters = context.parameters;
          let hasModifiedParameters = false;

          for (const layer of activeLayers) {
            if (!layer.onAuthorizeTool) {
              continue;
            }
            try {
              const decision = await layer.onAuthorizeTool({
                toolName: context.toolName,
                parameters: currentParameters,
                workingDirectory: context.workingDirectory,
              });
              if (decision.decision === "deny") {
                return decision;
              }
              if (decision.updatedParameters !== undefined) {
                currentParameters = decision.updatedParameters;
                hasModifiedParameters = true;
              }
            } catch (error) {
              const errorMessage =
                error instanceof Error ? error.message : String(error);
              return {
                decision: "deny",
                reason: `Authorization check failed: ${errorMessage}`,
              };
            }
          }
          return hasModifiedParameters
            ? { decision: "allow", updatedParameters: currentParameters }
            : { decision: "allow" };
        }
      : undefined,

    onPostTool: activeLayers.some((layer) => layer.onPostTool)
      ? async (context: PostToolContext): Promise<PostToolResult | void> => {
          let currentResult = context.result;
          let hasModifiedResult = false;
          const contextList: string[] = [];

          for (const layer of activeLayers) {
            if (!layer.onPostTool) {
              continue;
            }
            try {
              const outcome = await layer.onPostTool({
                toolName: context.toolName,
                parameters: context.parameters,
                result: currentResult,
                isError: context.isError,
                durationMs: context.durationMs,
                workingDirectory: context.workingDirectory,
              });

              if (!outcome) {
                continue;
              }

              if (outcome.updatedResult !== undefined) {
                currentResult = outcome.updatedResult;
                hasModifiedResult = true;
              }

              if (
                outcome.additionalContext &&
                outcome.additionalContext.trim().length > 0
              ) {
                contextList.push(outcome.additionalContext.trim());
              }
            } catch {
              // A failure in a post-tool hook layer is contained and does not abort subsequent layers
            }
          }

          if (!hasModifiedResult && contextList.length === 0) {
            return undefined;
          }

          return {
            ...(hasModifiedResult ? { updatedResult: currentResult } : {}),
            ...(contextList.length > 0
              ? { additionalContext: contextList.join("\n\n") }
              : {}),
          };
        }
      : undefined,

    onAfterTurn: activeLayers.some((layer) => layer.onAfterTurn)
      ? async (context: AfterTurnContext): Promise<void> => {
          const errors: unknown[] = [];
          for (const layer of activeLayers) {
            if (!layer.onAfterTurn) {
              continue;
            }
            try {
              await layer.onAfterTurn(context);
            } catch (error) {
              errors.push(error);
            }
          }
          if (errors.length > 0) {
            // Log/contain errors without replacing turn result
            // AggregateError if supported or recorded
          }
        }
      : undefined,

    onError: activeLayers.some((layer) => layer.onError)
      ? async (context: ErrorContext): Promise<void> => {
          for (const layer of activeLayers) {
            if (!layer.onError) {
              continue;
            }
            try {
              await layer.onError(context);
            } catch {
              // A failure in an error hook is contained and not fed recursively into onError
            }
          }
        }
      : undefined,
  };

  return composed;
}
