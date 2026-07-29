import { readFileSync } from "node:fs";

import { describe, expect, it, vi } from "vitest";

import {
  OpenAICompatibleProvider,
  ProviderError,
  createOpenAIProviderFromEnv,
} from "./provider.js";
import { createProviderRuntimeFromEnv } from "./providerRuntime.js";

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
