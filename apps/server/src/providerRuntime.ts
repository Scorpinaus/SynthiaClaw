import { resolve } from "node:path";

import {
  CodexAppServerClient,
  CodexSubscriptionProvider,
  StdioCodexTransport,
} from "./codexProvider.js";
import {
  ProviderError,
  createOpenAIProviderFromEnv,
  type ProviderRuntime,
} from "./provider.js";

export function createProviderRuntimeFromEnv(
  environment: Record<string, string | undefined> = process.env,
): ProviderRuntime {
  const selected = environment.MODEL_PROVIDER?.trim().toLowerCase() ?? "openai";

  if (selected === "codex") {
    const cwd = resolve(environment.CODEX_WORKING_DIRECTORY ?? process.cwd());
    const client = new CodexAppServerClient(
      new StdioCodexTransport({
        command: environment.CODEX_COMMAND || "codex",
        cwd,
      }),
    );
    return {
      mode: "codex-subscription",
      provider: new CodexSubscriptionProvider(client, {
        cwd,
        ...(environment.CODEX_MODEL
          ? { model: environment.CODEX_MODEL }
          : {}),
      }),
      accountManager: client,
      close: () => client.close(),
    };
  }

  if (selected !== "openai") {
    throw new ProviderError(
      "PROVIDER_NOT_CONFIGURED",
      'MODEL_PROVIDER must be either "openai" or "codex".',
    );
  }

  try {
    return {
      mode: "openai-api",
      provider: createOpenAIProviderFromEnv(environment),
      close: async () => {},
    };
  } catch (error) {
    const configurationError =
      error instanceof ProviderError
        ? error
        : new ProviderError(
            "PROVIDER_NOT_CONFIGURED",
            "The model provider is not configured.",
          );
    return {
      mode: "openai-api",
      provider: null,
      configurationError,
      close: async () => {},
    };
  }
}
