import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import type { LanguageModel } from "ai";
import type { ProviderAdapter, HernexCredentials } from "../types.js";

/**
 * Adapter for NVIDIA NIM (NVIDIA Inference Microservices) using `@ai-sdk/openai-compatible`.
 *
 * Supports cloud-hosted NVIDIA API catalog (https://integrate.api.nvidia.com/v1)
 * and self-hosted on-premise NIM container endpoints.
 */
export class NvidiaNimProviderAdapter implements ProviderAdapter {
  readonly providerId = "nvidiaNim";

  createModel(modelId: string, credentials: HernexCredentials): LanguageModel {
    const provider = createOpenAICompatible({
      name: "nvidiaNim",
      apiKey: credentials.apiKey,
      baseURL: credentials.baseUrl,
    });

    return provider(modelId);
  }
}

export const nvidiaNimProviderAdapter = new NvidiaNimProviderAdapter();
