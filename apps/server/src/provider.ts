import type {
  CodexLoginResponse,
  ProviderMode,
  ProviderStatusResponse,
} from "@synthia/shared";

import type { ProviderToolDefinition } from "./tools.js";

export interface ProviderToolCall {
  callId: string;
  toolName: string;
  arguments: Record<string, unknown>;
}

export interface ProviderMessage {
  role: "user" | "assistant" | "tool";
  content: string;
  toolCallId?: string;
  name?: string;
  toolCalls?: ProviderToolCall[];
}

export type ProviderStreamChunk =
  | string
  | ({ type: "tool_call"; providerManaged?: boolean } & ProviderToolCall)
  | {
      type: "tool_result";
      callId: string;
      toolName: string;
      output: string;
      isError: boolean;
    };

export type ProviderToolExecutor = (
  name: string,
  argumentsValue: unknown,
) => Promise<string>;

export interface ModelProvider {
  stream(
    messages: ProviderMessage[],
    signal: AbortSignal,
    tools?: ProviderToolDefinition[],
    executeTool?: ProviderToolExecutor,
  ): AsyncIterable<ProviderStreamChunk>;
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
    tools: ProviderToolDefinition[] = [],
  ): AsyncIterable<ProviderStreamChunk> {
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
            messages: messages.map(toOpenAIMessage),
            stream: true,
            ...(tools.length > 0
              ? {
                  tools: tools.map((tool) => ({
                    type: "function",
                    function: {
                      name: tool.name,
                      description: tool.description,
                      parameters: tool.inputSchema,
                    },
                  })),
                }
              : {}),
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
    const pendingToolCalls = new Map<
      number,
      { callId: string; toolName: string; argumentsJson: string }
    >();

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
      collectToolCallDeltas(payload, pendingToolCalls);
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

    for (const pending of [...pendingToolCalls.entries()].sort(
      ([left], [right]) => left - right,
    )) {
      const toolCall = pending[1];
      if (!toolCall.callId || !toolCall.toolName) {
        throw new ProviderError(
          "PROVIDER_INVALID_RESPONSE",
          "The model provider returned an incomplete tool call.",
        );
      }
      let argumentsValue: unknown;
      try {
        argumentsValue = JSON.parse(toolCall.argumentsJson || "{}") as unknown;
      } catch {
        throw new ProviderError(
          "PROVIDER_INVALID_RESPONSE",
          "The model provider returned invalid JSON tool arguments.",
        );
      }
      if (
        typeof argumentsValue !== "object" ||
        argumentsValue === null ||
        Array.isArray(argumentsValue)
      ) {
        throw new ProviderError(
          "PROVIDER_INVALID_RESPONSE",
          "The model provider returned non-object tool arguments.",
        );
      }
      yield {
        type: "tool_call",
        callId: toolCall.callId,
        toolName: toolCall.toolName,
        arguments: argumentsValue as Record<string, unknown>,
      };
    }

    if (!emittedText && pendingToolCalls.size === 0) {
      throw new ProviderError(
        "PROVIDER_INVALID_RESPONSE",
        "The model provider stream did not contain assistant text or tool calls.",
      );
    }
  }
}

function toOpenAIMessage(message: ProviderMessage): Record<string, unknown> {
  if (message.role === "tool") {
    return {
      role: "tool",
      tool_call_id: message.toolCallId,
      content: message.content,
    };
  }
  if (message.role === "assistant" && message.toolCalls?.length) {
    return {
      role: "assistant",
      content: message.content || null,
      tool_calls: message.toolCalls.map((toolCall) => ({
        id: toolCall.callId,
        type: "function",
        function: {
          name: toolCall.toolName,
          arguments: JSON.stringify(toolCall.arguments),
        },
      })),
    };
  }
  return { role: message.role, content: message.content };
}

function collectToolCallDeltas(
  body: unknown,
  pending: Map<
    number,
    { callId: string; toolName: string; argumentsJson: string }
  >,
): void {
  const delta = readFirstDelta(body);
  if (!delta || !("tool_calls" in delta) || !Array.isArray(delta.tool_calls)) {
    return;
  }
  for (const rawCall of delta.tool_calls) {
    if (
      typeof rawCall !== "object" ||
      rawCall === null ||
      !("index" in rawCall) ||
      typeof rawCall.index !== "number"
    ) {
      continue;
    }
    const existing = pending.get(rawCall.index) ?? {
      callId: "",
      toolName: "",
      argumentsJson: "",
    };
    if ("id" in rawCall && typeof rawCall.id === "string") {
      existing.callId = rawCall.id;
    }
    if (
      "function" in rawCall &&
      typeof rawCall.function === "object" &&
      rawCall.function !== null
    ) {
      if (
        "name" in rawCall.function &&
        typeof rawCall.function.name === "string"
      ) {
        existing.toolName = rawCall.function.name;
      }
      if (
        "arguments" in rawCall.function &&
        typeof rawCall.function.arguments === "string"
      ) {
        existing.argumentsJson += rawCall.function.arguments;
      }
    }
    pending.set(rawCall.index, existing);
  }
}

function readDeltaContent(body: unknown): string | null {
  const delta = readFirstDelta(body);
  if (
    !delta ||
    !("content" in delta) ||
    typeof delta.content !== "string" ||
    delta.content.length === 0
  ) {
    return null;
  }
  return delta.content;
}

function readFirstDelta(body: unknown): Record<string, unknown> | null {
  if (typeof body !== "object" || body === null || !("choices" in body)) {
    return null;
  }
  const choices = body.choices;
  if (!Array.isArray(choices) || choices.length === 0) return null;
  const first = choices[0];
  if (
    typeof first !== "object" ||
    first === null ||
    !("delta" in first) ||
    typeof first.delta !== "object" ||
    first.delta === null
  ) {
    return null;
  }
  return first.delta as Record<string, unknown>;
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
