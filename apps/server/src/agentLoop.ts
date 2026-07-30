import {
  ProviderError,
  type ModelProvider,
  type ProviderMessage,
  type ProviderToolCall,
} from "./provider.js";
import { ToolError, type ToolRegistry } from "./tools.js";

export interface AgentLoopOptions {
  provider: ModelProvider;
  messages: ProviderMessage[];
  tools: ToolRegistry;
  signal: AbortSignal;
  maxIterations: number;
  onDelta(delta: string): void;
  onToolCall(call: ProviderToolCall): void;
  onToolResult(
    call: ProviderToolCall,
    output: string,
    isError: boolean,
  ): void;
}

export async function runAgentLoop(
  options: AgentLoopOptions,
): Promise<string> {
  const messages = [...options.messages];
  let responseText = "";

  for (let iteration = 0; iteration < options.maxIterations; iteration += 1) {
    options.signal.throwIfAborted();
    let iterationText = "";
    const toolCalls: ProviderToolCall[] = [];
    const managedToolCalls = new Map<string, ProviderToolCall>();

    for await (const chunk of options.provider.stream(
      messages,
      options.signal,
      options.tools.definitions,
      async (name, argumentsValue) =>
        JSON.stringify(await options.tools.execute(name, argumentsValue)),
    )) {
      options.signal.throwIfAborted();
      if (typeof chunk === "string") {
        if (!chunk) continue;
        responseText += chunk;
        iterationText += chunk;
        if (responseText.length > 100_000) {
          throw new ProviderError(
            "PROVIDER_INVALID_RESPONSE",
            "The model provider response exceeded the message limit.",
          );
        }
        options.onDelta(chunk);
      } else if (chunk.type === "tool_call") {
        const call = {
          callId: chunk.callId,
          toolName: chunk.toolName,
          arguments: chunk.arguments,
        };
        if (chunk.providerManaged) {
          managedToolCalls.set(call.callId, call);
          options.onToolCall(call);
        } else {
          toolCalls.push(call);
        }
      } else {
        const call = managedToolCalls.get(chunk.callId) ?? {
          callId: chunk.callId,
          toolName: chunk.toolName,
          arguments: {},
        };
        options.onToolResult(call, chunk.output, chunk.isError);
      }
    }

    if (toolCalls.length === 0) {
      if (!responseText) {
        throw new ProviderError(
          "PROVIDER_INVALID_RESPONSE",
          "The model provider returned no assistant text.",
        );
      }
      return responseText;
    }

    messages.push({
      role: "assistant",
      content: iterationText,
      toolCalls,
    });
    for (const call of toolCalls) {
      options.signal.throwIfAborted();
      options.onToolCall(call);
      let output: string;
      let isError = false;
      try {
        output = JSON.stringify(
          await options.tools.execute(call.toolName, call.arguments),
        );
      } catch (error) {
        isError = true;
        const detail =
          error instanceof ToolError
            ? { code: error.code, message: error.message }
            : {
                code: "TOOL_EXECUTION_FAILED",
                message: "The server tool could not be executed.",
              };
        output = JSON.stringify({ error: detail });
      }
      options.onToolResult(call, output, isError);
      messages.push({
        role: "tool",
        content: output,
        toolCallId: call.callId,
        name: call.toolName,
      });
    }
  }

  throw new ProviderError(
    "AGENT_ITERATION_LIMIT",
    `The agent exceeded its limit of ${options.maxIterations} model iterations.`,
  );
}
