export interface ProviderMessage {
  role: "user" | "assistant";
  content: string;
}

export interface ModelProvider {
  complete(messages: ProviderMessage[]): Promise<string>;
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

  async complete(messages: ProviderMessage[]): Promise<string> {
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
            stream: false,
          }),
        },
      );
    } catch {
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

    let body: unknown;
    try {
      body = await response.json();
    } catch {
      throw new ProviderError(
        "PROVIDER_INVALID_RESPONSE",
        "The model provider returned invalid JSON.",
      );
    }

    const content = readCompletionContent(body);
    if (!content) {
      throw new ProviderError(
        "PROVIDER_INVALID_RESPONSE",
        "The model provider response did not contain assistant text.",
      );
    }
    return content;
  }
}

function readCompletionContent(body: unknown): string | null {
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
    !("message" in first) ||
    typeof first.message !== "object" ||
    first.message === null ||
    !("content" in first.message) ||
    typeof first.message.content !== "string" ||
    first.message.content.length === 0
  ) {
    return null;
  }
  return first.message.content;
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
