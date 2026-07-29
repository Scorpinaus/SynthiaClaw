import { describe, expect, it } from "vitest";

import {
  CodexAppServerClient,
  CodexSubscriptionProvider,
  type CodexTransport,
  type JsonRpcMessage,
} from "./codexProvider.js";

class FakeCodexTransport implements CodexTransport {
  readonly sent: JsonRpcMessage[] = [];
  private receiveMessage: ((message: JsonRpcMessage) => void) | null = null;
  private receiveExit: ((error: Error) => void) | null = null;

  constructor(
    private readonly respond: (
      message: JsonRpcMessage,
      transport: FakeCodexTransport,
    ) => void,
  ) {}

  async start(
    onMessage: (message: JsonRpcMessage) => void,
    onExit: (error: Error) => void,
  ): Promise<void> {
    this.receiveMessage = onMessage;
    this.receiveExit = onExit;
  }

  send(message: JsonRpcMessage): void {
    this.sent.push(message);
    queueMicrotask(() => this.respond(message, this));
  }

  emit(message: JsonRpcMessage): void {
    this.receiveMessage?.(message);
  }

  exit(message = "Codex stopped"): void {
    this.receiveExit?.(new Error(message));
  }

  async close(): Promise<void> {}
}

function respondToInitialization(
  message: JsonRpcMessage,
  transport: FakeCodexTransport,
): boolean {
  if (message.method === "initialize" && "id" in message) {
    transport.emit({
      id: message.id,
      result: {
        userAgent: "codex-test",
        platformFamily: "windows",
        platformOs: "windows",
      },
    });
    return true;
  }
  return message.method === "initialized";
}

describe("CodexAppServerClient", () => {
  it("reads ChatGPT subscription status without returning credentials", async () => {
    const transport = new FakeCodexTransport((message, fake) => {
      if (respondToInitialization(message, fake)) return;
      if (message.method === "account/read" && "id" in message) {
        fake.emit({
          id: message.id,
          result: {
            account: {
              type: "chatgpt",
              email: "person@example.com",
              planType: "plus",
            },
            requiresOpenaiAuth: true,
          },
        });
      }
    });
    const client = new CodexAppServerClient(transport);

    await expect(client.getSubscriptionStatus()).resolves.toEqual({
      mode: "codex-subscription",
      ready: true,
      account: {
        email: "person@example.com",
        planType: "plus",
      },
    });

    expect(transport.sent).toContainEqual({
      method: "account/read",
      id: expect.any(Number),
      params: { refreshToken: false },
    });
  });

  it("starts the managed ChatGPT OAuth browser flow", async () => {
    const transport = new FakeCodexTransport((message, fake) => {
      if (respondToInitialization(message, fake)) return;
      if (message.method === "account/login/start" && "id" in message) {
        fake.emit({
          id: message.id,
          result: {
            type: "chatgpt",
            loginId: "019c1234-5678-7abc-8def-0123456789ab",
            authUrl: "https://auth.openai.com/oauth/authorize?state=opaque",
          },
        });
      }
    });
    const client = new CodexAppServerClient(transport);

    await expect(client.startChatGptLogin()).resolves.toEqual({
      loginId: "019c1234-5678-7abc-8def-0123456789ab",
      authUrl: "https://auth.openai.com/oauth/authorize?state=opaque",
    });
    expect(transport.sent).toContainEqual({
      method: "account/login/start",
      id: expect.any(Number),
      params: {
        type: "chatgpt",
        useHostedLoginSuccessPage: true,
        appBrand: "chatgpt",
      },
    });
  });

  it("rejects pending requests when the app-server exits", async () => {
    const transport = new FakeCodexTransport((message, fake) => {
      if (respondToInitialization(message, fake)) return;
      if (message.method === "account/read") {
        fake.exit("Codex app-server exited unexpectedly.");
      }
    });
    const client = new CodexAppServerClient(transport);

    await expect(client.getSubscriptionStatus()).rejects.toThrow(
      "Codex app-server exited unexpectedly.",
    );
  });
});

describe("CodexSubscriptionProvider", () => {
  it("runs an ephemeral agent turn with persisted chat history", async () => {
    const transport = new FakeCodexTransport((message, fake) => {
      if (respondToInitialization(message, fake)) return;
      if (!("id" in message)) return;

      if (message.method === "account/read") {
        fake.emit({
          id: message.id,
          result: {
            account: {
              type: "chatgpt",
              email: "person@example.com",
              planType: "pro",
            },
            requiresOpenaiAuth: true,
          },
        });
      } else if (message.method === "thread/start") {
        fake.emit({
          id: message.id,
          result: { thread: { id: "thr_synthia_1" } },
        });
      } else if (message.method === "thread/inject_items") {
        fake.emit({ id: message.id, result: {} });
      } else if (message.method === "turn/start") {
        fake.emit({
          id: message.id,
          result: {
            turn: {
              id: "turn_synthia_1",
              status: "inProgress",
              items: [],
            },
          },
        });
        fake.emit({
          method: "item/completed",
          params: {
            threadId: "thr_synthia_1",
            turnId: "turn_synthia_1",
            item: {
              type: "agentMessage",
              id: "item_answer_1",
              text: "Subscription-backed response",
              phase: "final_answer",
            },
          },
        });
        fake.emit({
          method: "turn/completed",
          params: {
            threadId: "thr_synthia_1",
            turn: {
              id: "turn_synthia_1",
              status: "completed",
              items: [],
            },
          },
        });
      }
    });
    const client = new CodexAppServerClient(transport);
    const provider = new CodexSubscriptionProvider(client, {
      cwd: "D:\\Project\\SynthiaClaw",
      model: "gpt-test",
    });

    await expect(
      provider.complete([
        { role: "user", content: "Earlier question" },
        { role: "assistant", content: "Earlier answer" },
        { role: "user", content: "Current question" },
      ]),
    ).resolves.toBe("Subscription-backed response");

    expect(transport.sent).toContainEqual({
      method: "thread/start",
      id: expect.any(Number),
      params: expect.objectContaining({
        approvalPolicy: "never",
        cwd: "D:\\Project\\SynthiaClaw",
        ephemeral: true,
        model: "gpt-test",
        sandbox: "read-only",
      }),
    });
    expect(transport.sent).toContainEqual({
      method: "thread/inject_items",
      id: expect.any(Number),
      params: {
        threadId: "thr_synthia_1",
        items: [
          {
            type: "message",
            role: "user",
            content: [{ type: "input_text", text: "Earlier question" }],
          },
          {
            type: "message",
            role: "assistant",
            content: [{ type: "output_text", text: "Earlier answer" }],
          },
        ],
      },
    });
    expect(transport.sent).toContainEqual({
      method: "turn/start",
      id: expect.any(Number),
      params: {
        threadId: "thr_synthia_1",
        input: [{ type: "text", text: "Current question" }],
      },
    });
  });

  it("requires ChatGPT OAuth rather than silently using API-key billing", async () => {
    const transport = new FakeCodexTransport((message, fake) => {
      if (respondToInitialization(message, fake)) return;
      if (message.method === "account/read" && "id" in message) {
        fake.emit({
          id: message.id,
          result: {
            account: { type: "apiKey" },
            requiresOpenaiAuth: true,
          },
        });
      }
    });
    const provider = new CodexSubscriptionProvider(
      new CodexAppServerClient(transport),
      { cwd: "D:\\Project\\SynthiaClaw" },
    );

    await expect(
      provider.complete([{ role: "user", content: "Hello" }]),
    ).rejects.toMatchObject({ code: "CODEX_NOT_AUTHENTICATED" });
    expect(
      transport.sent.some((message) => message.method === "thread/start"),
    ).toBe(false);
  });

  it("fails an active turn when the Codex app-server exits", async () => {
    const transport = new FakeCodexTransport((message, fake) => {
      if (respondToInitialization(message, fake)) return;
      if (!("id" in message)) return;
      if (message.method === "account/read") {
        fake.emit({
          id: message.id,
          result: {
            account: {
              type: "chatgpt",
              email: "person@example.com",
              planType: "plus",
            },
            requiresOpenaiAuth: true,
          },
        });
      } else if (message.method === "thread/start") {
        fake.emit({
          id: message.id,
          result: { thread: { id: "thr_interrupted" } },
        });
      } else if (message.method === "turn/start") {
        fake.emit({
          id: message.id,
          result: {
            turn: {
              id: "turn_interrupted",
              status: "inProgress",
              items: [],
            },
          },
        });
        fake.exit("Codex exited during the turn.");
      }
    });
    const provider = new CodexSubscriptionProvider(
      new CodexAppServerClient(transport),
      { cwd: "D:\\Project\\SynthiaClaw" },
    );

    const outcome = await Promise.race([
      provider
        .complete([{ role: "user", content: "Hello" }])
        .then(() => "resolved")
        .catch((error: unknown) => error),
      new Promise((resolve) => setTimeout(() => resolve("timed-out"), 100)),
    ]);

    expect(outcome).toBeInstanceOf(Error);
    expect(outcome).toMatchObject({
      message: "Codex exited during the turn.",
    });
  });
});
