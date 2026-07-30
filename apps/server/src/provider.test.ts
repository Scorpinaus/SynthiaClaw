import { readFileSync } from "node:fs";

import { describe, expect, it, vi } from "vitest";

import {
  OpenAICompatibleProvider,
  ProviderError,
  createOpenAIProviderFromEnv,
  type ProviderStreamChunk,
} from "./provider.js";
import { createProviderRuntimeFromEnv } from "./providerRuntime.js";

async function collect(
  stream: AsyncIterable<ProviderStreamChunk>,
): Promise<ProviderStreamChunk[]> {
  const chunks: ProviderStreamChunk[] = [];
  for await (const chunk of stream) chunks.push(chunk);
  return chunks;
}

describe("OpenAICompatibleProvider", () => {
  it("streams OpenAI-compatible SSE deltas across response chunks", async () => {
    const encoder = new TextEncoder();
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(
              encoder.encode(
                'data: {"choices":[{"delta":{"content":"Deter"}}]}\n\n',
              ),
            );
            controller.enqueue(
              encoder.encode(
                'data: {"choices":[{"delta":{"content":"ministic response"}}]}\n\ndata: [DONE]\n\n',
              ),
            );
            controller.close();
          },
        }),
        { headers: { "Content-Type": "text/event-stream" }, status: 200 },
      ),
    );
    const provider = new OpenAICompatibleProvider(
      {
        apiKey: "server-secret",
        baseUrl: "https://models.example.test/v1/",
        model: "example-model",
      },
      fetchMock,
    );

    const controller = new AbortController();
    await expect(
      collect(
        provider.stream(
          [
            { role: "user", content: "Hello" },
            { role: "assistant", content: "Hi" },
          ],
          controller.signal,
        ),
      ),
    ).resolves.toEqual(["Deter", "ministic response"]);

    expect(fetchMock).toHaveBeenCalledWith(
      "https://models.example.test/v1/chat/completions",
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({
          Authorization: "Bearer server-secret",
          "Content-Type": "application/json",
        }),
        signal: controller.signal,
        body: JSON.stringify({
          model: "example-model",
          messages: [
            { role: "user", content: "Hello" },
            { role: "assistant", content: "Hi" },
          ],
          stream: true,
        }),
      }),
    );
  });

  it("stops reading the upstream response when aborted", async () => {
    const encoder = new TextEncoder();
    const fetchMock = vi.fn<typeof fetch>().mockImplementation(
      async (_input, init) =>
        new Response(
          new ReadableStream({
            start(streamController) {
              streamController.enqueue(
                encoder.encode(
                  'data: {"choices":[{"delta":{"content":"Partial"}}]}\n\n',
                ),
              );
              init?.signal?.addEventListener("abort", () => {
                streamController.error(
                  new DOMException("The operation was aborted.", "AbortError"),
                );
              });
            },
          }),
          { headers: { "Content-Type": "text/event-stream" }, status: 200 },
        ),
    );
    const provider = new OpenAICompatibleProvider(
      {
        apiKey: "server-secret",
        baseUrl: "https://models.example.test/v1",
        model: "example-model",
      },
      fetchMock,
    );
    const controller = new AbortController();
    const iterator = provider.stream(
      [{ role: "user", content: "Hello" }],
      controller.signal,
    )[Symbol.asyncIterator]();

    await expect(iterator.next()).resolves.toEqual({
      done: false,
      value: "Partial",
    });
    controller.abort();
    await expect(iterator.next()).rejects.toMatchObject({ name: "AbortError" });
  });

  it("assembles streamed tool calls and sends server tool definitions", async () => {
    const encoder = new TextEncoder();
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(
              encoder.encode(
                'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_time_1","type":"function","function":{"name":"current_time","arguments":"{"}}]}}]}\n\n',
              ),
            );
            controller.enqueue(
              encoder.encode(
                'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"}"}}]},"finish_reason":"tool_calls"}]}\n\ndata: [DONE]\n\n',
              ),
            );
            controller.close();
          },
        }),
        { headers: { "Content-Type": "text/event-stream" }, status: 200 },
      ),
    );
    const provider = new OpenAICompatibleProvider(
      {
        apiKey: "server-secret",
        baseUrl: "https://models.example.test/v1",
        model: "example-model",
      },
      fetchMock,
    );
    const tools = [
      {
        name: "current_time",
        description: "Return the current server time.",
        inputSchema: {
          type: "object" as const,
          properties: {},
          additionalProperties: false,
        },
      },
    ];

    await expect(
      collect(
        provider.stream(
          [{ role: "user", content: "What time is it?" }],
          new AbortController().signal,
          tools,
        ),
      ),
    ).resolves.toEqual([
      {
        type: "tool_call",
        callId: "call_time_1",
        toolName: "current_time",
        arguments: {},
      },
    ]);

    expect(fetchMock).toHaveBeenCalledWith(
      "https://models.example.test/v1/chat/completions",
      expect.objectContaining({
        body: JSON.stringify({
          model: "example-model",
          messages: [{ role: "user", content: "What time is it?" }],
          stream: true,
          tools: [
            {
              type: "function",
              function: {
                name: "current_time",
                description: "Return the current server time.",
                parameters: tools[0]?.inputSchema,
              },
            },
          ],
        }),
      }),
    );
  });

  it("reports missing server configuration without exposing credentials", () => {
    expect(() => createOpenAIProviderFromEnv({})).toThrowError(
      expect.objectContaining<Partial<ProviderError>>({
        code: "PROVIDER_NOT_CONFIGURED",
      }),
    );
  });

  it("turns HTTP and malformed-stream failures into understandable errors", async () => {
    const rejected = new OpenAICompatibleProvider(
      {
        apiKey: "secret",
        baseUrl: "https://models.example.test/v1",
        model: "model",
      },
      vi
        .fn<typeof fetch>()
        .mockResolvedValue(new Response("upstream unavailable", { status: 503 })),
    );
    await expect(
      collect(rejected.stream([{ role: "user", content: "Hello" }])),
    ).rejects.toMatchObject({ code: "PROVIDER_REQUEST_FAILED" });

    const malformed = new OpenAICompatibleProvider(
      {
        apiKey: "secret",
        baseUrl: "https://models.example.test/v1",
        model: "model",
      },
      vi.fn<typeof fetch>().mockResolvedValue(
        new Response('data: {"choices":[]}\n\ndata: [DONE]\n\n', {
          headers: { "Content-Type": "text/event-stream" },
          status: 200,
        }),
      ),
    );
    await expect(
      collect(
        malformed.stream([
          { role: "user", content: "Hello" },
        ]),
      ),
    ).rejects.toMatchObject({ code: "PROVIDER_INVALID_RESPONSE" });
  });
});

describe("createProviderRuntimeFromEnv", () => {
  it("selects Codex subscription mode without requiring an API key", async () => {
    const runtime = createProviderRuntimeFromEnv({
      MODEL_PROVIDER: "codex",
      CODEX_COMMAND: "codex-test",
      CODEX_MODEL: "gpt-test",
      CODEX_WORKING_DIRECTORY: "D:\\Project\\SynthiaClaw",
    });

    expect(runtime).toMatchObject({
      mode: "codex-subscription",
      provider: expect.any(Object),
      accountManager: expect.any(Object),
    });
    await runtime.close();
  });
});

describe("production package resolution", () => {
  it("exports compiled shared JavaScript to plain Node", () => {
    const packageJson = JSON.parse(
      readFileSync(
        new URL("../../../packages/shared/package.json", import.meta.url),
        "utf8",
      ),
    ) as {
      exports: {
        ".": {
          default?: string;
          development?: string;
          types?: string;
        };
      };
    };

    expect(packageJson.exports["."]).toMatchObject({
      default: "./dist/index.js",
      development: "./src/index.ts",
      types: "./src/index.ts",
    });

    const sharedTsConfig = JSON.parse(
      readFileSync(
        new URL("../../../packages/shared/tsconfig.json", import.meta.url),
        "utf8",
      ),
    ) as { compilerOptions: { emitDeclarationOnly?: boolean } };
    expect(sharedTsConfig.compilerOptions.emitDeclarationOnly).not.toBe(true);

    const rootPackageJson = JSON.parse(
      readFileSync(new URL("../../../package.json", import.meta.url), "utf8"),
    ) as { scripts: { build: string } };
    expect(rootPackageJson.scripts.build).toMatch(
      /^npm run build --workspace @synthia\/shared/,
    );
  });
});
