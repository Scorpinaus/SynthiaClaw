import { describe, expect, it } from "vitest";

import {
  AssistantCompletedEventSchema,
  ChatSendEventSchema,
  CodexLoginResponseSchema,
  CreateSessionRequestSchema,
  ErrorResponseSchema,
  HealthResponseSchema,
  MessageSchema,
  ProviderStatusResponseSchema,
  RunFailedEventSchema,
  RunStartedEventSchema,
  SessionSchema,
} from "./index.js";

describe("HealthResponseSchema", () => {
  it("accepts the backend health contract", () => {
    const result = HealthResponseSchema.safeParse({
      status: "ok",
      service: "synthia-server",
      timestamp: "2026-07-29T12:00:00.000Z",
    });

    expect(result.success).toBe(true);
  });

  it("rejects an invalid status and timestamp", () => {
    const result = HealthResponseSchema.safeParse({
      status: "healthy",
      service: "synthia-server",
      timestamp: "today",
    });

    expect(result.success).toBe(false);
  });
});

const sessionId = "0f37e589-4ac4-4a79-8061-bae31a9c4cf7";
const messageId = "b27c89d9-05ca-4ec3-8f61-2c74879c784b";

describe("session and message contracts", () => {
  it("accepts persisted session and message resources", () => {
    expect(
      SessionSchema.parse({
        id: sessionId,
        title: "First conversation",
        createdAt: "2026-07-29T12:00:00.000Z",
        updatedAt: "2026-07-29T12:01:00.000Z",
      }),
    ).toMatchObject({ id: sessionId });

    expect(
      MessageSchema.parse({
        id: messageId,
        sessionId,
        role: "assistant",
        payload: { text: "Hello back." },
        createdAt: "2026-07-29T12:01:00.000Z",
      }),
    ).toMatchObject({ role: "assistant", payload: { text: "Hello back." } });
  });

  it("trims create-session titles and rejects unknown resource fields", () => {
    expect(CreateSessionRequestSchema.parse({ title: "  Project chat  " })).toEqual({
      title: "Project chat",
    });
    expect(
      SessionSchema.safeParse({
        id: sessionId,
        title: "Chat",
        createdAt: "2026-07-29T12:00:00.000Z",
        updatedAt: "2026-07-29T12:00:00.000Z",
        secret: true,
      }).success,
    ).toBe(false);
  });

  it("represents structured API errors", () => {
    expect(
      ErrorResponseSchema.parse({
        error: { code: "SESSION_NOT_FOUND", message: "Session was not found." },
      }),
    ).toEqual({
      error: { code: "SESSION_NOT_FOUND", message: "Session was not found." },
    });
  });
});

describe("model provider contracts", () => {
  it("represents a connected ChatGPT subscription without exposing tokens", () => {
    expect(
      ProviderStatusResponseSchema.parse({
        mode: "codex-subscription",
        ready: true,
        account: {
          email: "person@example.com",
          planType: "plus",
        },
      }),
    ).toEqual({
      mode: "codex-subscription",
      ready: true,
      account: {
        email: "person@example.com",
        planType: "plus",
      },
    });

    expect(
      ProviderStatusResponseSchema.safeParse({
        mode: "codex-subscription",
        ready: true,
        account: null,
        accessToken: "must-not-cross-the-api-boundary",
      }).success,
    ).toBe(false);
  });

  it("validates the managed OAuth browser-flow response", () => {
    expect(
      CodexLoginResponseSchema.parse({
        loginId: "019c1234-5678-7abc-8def-0123456789ab",
        authUrl: "https://auth.openai.com/oauth/authorize?state=opaque",
      }),
    ).toMatchObject({
      loginId: "019c1234-5678-7abc-8def-0123456789ab",
    });
  });
});

describe("WebSocket contracts", () => {
  it("validates the complete chat lifecycle", () => {
    const request = ChatSendEventSchema.parse({
      type: "chat.send",
      requestId: "req_browser_1",
      sessionId,
      text: "Hello",
    });

    const started = RunStartedEventSchema.parse({
      type: "run.started",
      requestId: request.requestId,
      runId: "run_server_1",
      sessionId,
    });

    expect(
      AssistantCompletedEventSchema.parse({
        type: "assistant.completed",
        requestId: request.requestId,
        runId: started.runId,
        sessionId,
        message: {
          id: messageId,
          sessionId,
          role: "assistant",
          payload: { text: "Hello back." },
          createdAt: "2026-07-29T12:01:00.000Z",
        },
      }),
    ).toMatchObject({ type: "assistant.completed" });

    expect(
      RunFailedEventSchema.parse({
        type: "run.failed",
        requestId: request.requestId,
        runId: started.runId,
        sessionId,
        error: { code: "PROVIDER_UNAVAILABLE", message: "Provider unavailable." },
      }),
    ).toMatchObject({ type: "run.failed" });
  });

  it("rejects malformed inbound and outbound events", () => {
    expect(
      ChatSendEventSchema.safeParse({
        type: "chat.send",
        requestId: "wrong-prefix",
        sessionId,
        text: "",
      }).success,
    ).toBe(false);
    expect(
      RunStartedEventSchema.safeParse({
        type: "run.started",
        requestId: "req_1",
        runId: "wrong-prefix",
        sessionId: "not-a-uuid",
      }).success,
    ).toBe(false);
  });
});
