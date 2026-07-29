import { describe, expect, it, vi } from "vitest";

import {
  OpenAICompatibleProvider,
  ProviderError,
  createOpenAIProviderFromEnv,
} from "./provider.js";

describe("OpenAICompatibleProvider", () => {
  it("sends an OpenAI-compatible non-streaming completion request", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(
        JSON.stringify({
          choices: [{ message: { content: "Deterministic response" } }],
        }),
        { headers: { "Content-Type": "application/json" }, status: 200 },
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

    await expect(
      provider.complete([
        { role: "user", content: "Hello" },
        { role: "assistant", content: "Hi" },
      ]),
    ).resolves.toBe("Deterministic response");

    expect(fetchMock).toHaveBeenCalledWith(
      "https://models.example.test/v1/chat/completions",
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({
          Authorization: "Bearer server-secret",
          "Content-Type": "application/json",
        }),
        body: JSON.stringify({
          model: "example-model",
          messages: [
            { role: "user", content: "Hello" },
            { role: "assistant", content: "Hi" },
          ],
          stream: false,
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

  it("turns HTTP and malformed-response failures into understandable errors", async () => {
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
    await expect(rejected.complete([{ role: "user", content: "Hello" }])).rejects
      .toMatchObject({ code: "PROVIDER_REQUEST_FAILED" });

    const malformed = new OpenAICompatibleProvider(
      {
        apiKey: "secret",
        baseUrl: "https://models.example.test/v1",
        model: "model",
      },
      vi
        .fn<typeof fetch>()
        .mockResolvedValue(
          new Response(JSON.stringify({ choices: [] }), { status: 200 }),
        ),
    );
    await expect(malformed.complete([{ role: "user", content: "Hello" }])).rejects
      .toMatchObject({ code: "PROVIDER_INVALID_RESPONSE" });
  });
});
