import type {
  CodexLoginResponse,
  ProviderMode,
  ProviderStatusResponse,
} from "@synthia/shared";

export interface ProviderMessage {
  role: "user" | "assistant";
  content: string;
}

export interface ModelProvider {
  stream(
    messages: ProviderMessage[],
    signal: AbortSignal,
  ): AsyncIterable<string>;
}

export interface CodexAccountManager {
  getSubscriptionStatus(): Promise<ProviderStatusResponse>;
  startChatGptLogin(): Promise<CodexLoginResponse>;
  logout(): Promise<void>;
}

export interface ProviderRuntime {
  mode: ProviderMode;
  provider: ModelProvider | null;
  accountManager?: CodexAccountManager;
  configurationError?: ProviderError;
  close(): Promise<void>;
}

interface OpenAICompatibleConfig {
  apiKey: string;
  baseUrl: string;
  model: string;
}

export class ProviderError extends Error {
  constructor(
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "ProviderError";
  }
}

export class OpenAICompatibleProvider implements ModelProvider {
  constructor(
    private readonly config: OpenAICompatibleConfig,
    private readonly fetchImplementation: typeof fetch = fetch,
  ) {}

  async *stream(
    messages: ProviderMessage[],
    signal: AbortSignal = new AbortController().signal,
  ): AsyncIterable<string> {
    let response: Response;
    try {
      response = await this.fetchImplementation(
        `${this.config.baseUrl.replace(/\/+$/, "")}/chat/completions`,
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${this.config.apiKey}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            model: this.config.model,
            messages,
            stream: true,
          }),
          signal,
        },
      );
    } catch (error) {
      if (signal.aborted) throw error;
      throw new ProviderError(
        "PROVIDER_REQUEST_FAILED",
        "The model provider could not be reached.",
      );
    }

    if (!response.ok) {
      throw new ProviderError(
        "PROVIDER_REQUEST_FAILED",
        `The model provider returned HTTP ${response.status}.`,
      );
    }

    if (!response.body) {
      throw new ProviderError(
        "PROVIDER_INVALID_RESPONSE",
        "The model provider response did not contain a stream.",
      );
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let emittedText = false;
    let reachedDone = false;

    const readEvent = (block: string): string | null => {
      const data = block
        .split("\n")
        .filter((line) => line.startsWith("data:"))
        .map((line) => line.slice(5).trimStart())
        .join("\n");
      if (!data) return null;
      if (data.trim() === "[DONE]") {
        reachedDone = true;
        return null;
      }

      let payload: unknown;
      try {
        payload = JSON.parse(data) as unknown;
      } catch {
        throw new ProviderError(
          "PROVIDER_INVALID_RESPONSE",
          "The model provider returned an invalid streaming event.",
        );
      }
      return readDeltaContent(payload);
    };

    try {
      while (!reachedDone) {
        const result = await reader.read();
        if (result.done) {
          buffer += decoder.decode();
          break;
        }
        buffer = `${buffer}${decoder.decode(result.value, { stream: true })}`.replaceAll(
          "\r\n",
          "\n",
        );

        let boundary = buffer.indexOf("\n\n");
        while (boundary !== -1) {
          const block = buffer.slice(0, boundary);
          buffer = buffer.slice(boundary + 2);
          const delta = readEvent(block);
          if (delta) {
            emittedText = true;
            yield delta;
          }
          if (reachedDone) break;
          boundary = buffer.indexOf("\n\n");
        }
      }

      if (!reachedDone && buffer.trim()) {
        const delta = readEvent(buffer);
        if (delta) {
          emittedText = true;
          yield delta;
        }
      }
    } finally {
      reader.releaseLock();
    }

    if (!emittedText) {
      throw new ProviderError(
        "PROVIDER_INVALID_RESPONSE",
        "The model provider stream did not contain assistant text.",
      );
    }
  }
}

function readDeltaContent(body: unknown): string | null {
  if (typeof body !== "object" || body === null || !("choices" in body)) {
    return null;
  }
  const choices = body.choices;
  if (!Array.isArray(choices) || choices.length === 0) {
    return null;
  }
  const first = choices[0];
  if (
    typeof first !== "object" ||
    first === null ||
    !("delta" in first) ||
    typeof first.delta !== "object" ||
    first.delta === null ||
    !("content" in first.delta) ||
    typeof first.delta.content !== "string" ||
    first.delta.content.length === 0
  ) {
    return null;
  }
  return first.delta.content;
}

export function createOpenAIProviderFromEnv(
  environment: Record<string, string | undefined> = process.env,
): ModelProvider {
  const apiKey = environment.OPENAI_API_KEY;
  const model = environment.OPENAI_MODEL;
  if (!apiKey || !model) {
    throw new ProviderError(
      "PROVIDER_NOT_CONFIGURED",
      "Set OPENAI_API_KEY and OPENAI_MODEL on the backend to enable chat.",
    );
  }

  return new OpenAICompatibleProvider({
    apiKey,
    baseUrl: environment.OPENAI_BASE_URL ?? "https://api.openai.com/v1",
    model,
  });
}
