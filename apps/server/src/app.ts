import { randomUUID } from "node:crypto";
import { resolve } from "node:path";

import websocket from "@fastify/websocket";
import {
  ChatSendEventSchema,
  CreateSessionRequestSchema,
  ErrorResponseSchema,
  HealthResponseSchema,
  MessageListResponseSchema,
  RunFailedEventSchema,
  RunStartedEventSchema,
  AssistantCompletedEventSchema,
  ServerWebSocketEventSchema,
  SessionListResponseSchema,
  SessionParamsSchema,
  SessionResponseSchema,
  type ServerWebSocketEvent,
} from "@synthia/shared";
import Fastify, { type FastifyServerOptions } from "fastify";

import {
  ProviderError,
  createOpenAIProviderFromEnv,
  type ModelProvider,
} from "./provider.js";
import { ChatRepository, RepositoryError } from "./repository.js";

interface AppDependencies {
  databasePath?: string;
  provider?: ModelProvider;
  repository?: ChatRepository;
}

export function buildApp(
  options: FastifyServerOptions = {},
  dependencies: AppDependencies = {},
) {
  const app = Fastify(options);
  app.register(websocket);
  const repository =
    dependencies.repository ??
    new ChatRepository(
      dependencies.databasePath ??
        process.env.DATABASE_PATH ??
        resolve("data", "synthia.sqlite"),
    );
  let provider: ModelProvider | null = dependencies.provider ?? null;
  let providerConfigurationError: ProviderError | null = null;
  if (!provider) {
    try {
      provider = createOpenAIProviderFromEnv();
    } catch (error) {
      providerConfigurationError =
        error instanceof ProviderError
          ? error
          : new ProviderError(
              "PROVIDER_NOT_CONFIGURED",
              "The model provider is not configured.",
            );
    }
  }

  const errorBody = (code: string, message: string) =>
    ErrorResponseSchema.parse({ error: { code, message } });

  app.addHook("onClose", () => {
    repository.close();
  });

  app.get("/api/health", async () =>
    HealthResponseSchema.parse({
      status: "ok",
      service: "synthia-server",
      timestamp: new Date().toISOString(),
    }),
  );

  app.get("/api/sessions", async () =>
    SessionListResponseSchema.parse({
      sessions: repository.listSessions(),
    }),
  );

  app.post("/api/sessions", async (request, reply) => {
    const parsed = CreateSessionRequestSchema.safeParse(request.body ?? {});
    if (!parsed.success) {
      return reply
        .code(400)
        .send(
          errorBody(
            "VALIDATION_ERROR",
            "The session request body is invalid.",
          ),
        );
    }

    const session = repository.createSession(parsed.data.title);
    return reply
      .code(201)
      .header("Location", `/api/sessions/${session.id}`)
      .send(SessionResponseSchema.parse({ session }));
  });

  app.get("/api/sessions/:id", async (request, reply) => {
    const parsed = SessionParamsSchema.safeParse(request.params);
    if (!parsed.success) {
      return reply
        .code(400)
        .send(
          errorBody("VALIDATION_ERROR", "The session identifier is invalid."),
        );
    }

    const session = repository.getSession(parsed.data.id);
    if (!session) {
      return reply
        .code(404)
        .send(
          errorBody("SESSION_NOT_FOUND", "The requested session was not found."),
        );
    }

    return SessionResponseSchema.parse({ session });
  });

  app.get("/api/sessions/:id/messages", async (request, reply) => {
    const parsed = SessionParamsSchema.safeParse(request.params);
    if (!parsed.success) {
      return reply
        .code(400)
        .send(
          errorBody("VALIDATION_ERROR", "The session identifier is invalid."),
        );
    }

    if (!repository.getSession(parsed.data.id)) {
      return reply
        .code(404)
        .send(
          errorBody("SESSION_NOT_FOUND", "The requested session was not found."),
        );
    }

    return MessageListResponseSchema.parse({
      messages: repository.listMessages(parsed.data.id),
    });
  });

  app.register(async (chatApp) => {
    chatApp.get("/api/chat", { websocket: true }, (socket) => {
    const send = (event: ServerWebSocketEvent) => {
      socket.send(JSON.stringify(ServerWebSocketEventSchema.parse(event)));
    };

    socket.on("message", async (rawData: { toString(): string }) => {
      let input: unknown;
      try {
        input = JSON.parse(rawData.toString()) as unknown;
      } catch {
        input = null;
      }

      const runId = `run_${randomUUID().replaceAll("-", "")}`;
      const parsed = ChatSendEventSchema.safeParse(input);
      if (!parsed.success) {
        const fallback = getFailureIdentifiers(input);
        send(
          RunFailedEventSchema.parse({
            type: "run.failed",
            requestId: fallback.requestId,
            runId,
            sessionId: fallback.sessionId,
            error: {
              code: "VALIDATION_ERROR",
              message: "The WebSocket message is invalid.",
            },
          }),
        );
        return;
      }

      const event = parsed.data;
      let start;
      try {
        start = repository.startRun({
          requestId: event.requestId,
          runId,
          sessionId: event.sessionId,
          text: event.text,
        });
      } catch (error) {
        const detail =
          error instanceof RepositoryError
            ? { code: error.code, message: error.message }
            : {
                code: "PERSISTENCE_ERROR",
                message: "The chat request could not be persisted.",
              };
        send(
          RunFailedEventSchema.parse({
            type: "run.failed",
            requestId: event.requestId,
            runId,
            sessionId: event.sessionId,
            error: detail,
          }),
        );
        return;
      }

      send(
        RunStartedEventSchema.parse({
          type: "run.started",
          requestId: event.requestId,
          runId: start.runId,
          sessionId: event.sessionId,
        }),
      );

      if (start.status === "completed") {
        send(
          AssistantCompletedEventSchema.parse({
            type: "assistant.completed",
            requestId: event.requestId,
            runId: start.runId,
            sessionId: event.sessionId,
            message: start.assistantMessage,
          }),
        );
        return;
      }
      if (start.status === "failed") {
        send(
          RunFailedEventSchema.parse({
            type: "run.failed",
            requestId: event.requestId,
            runId: start.runId,
            sessionId: event.sessionId,
            error: start.error,
          }),
        );
        return;
      }
      if (start.status === "running") {
        send(
          RunFailedEventSchema.parse({
            type: "run.failed",
            requestId: event.requestId,
            runId: start.runId,
            sessionId: event.sessionId,
            error: {
              code: "REQUEST_IN_PROGRESS",
              message: "This request is already running.",
            },
          }),
        );
        return;
      }

      try {
        if (!provider) {
          throw (
            providerConfigurationError ??
            new ProviderError(
              "PROVIDER_NOT_CONFIGURED",
              "The model provider is not configured.",
            )
          );
        }
        const responseText = await provider.complete(
          repository.listMessages(event.sessionId).map((message) => ({
            role: message.role,
            content: message.payload.text,
          })),
        );
        const message = repository.completeRun(event.requestId, responseText);
        send(
          AssistantCompletedEventSchema.parse({
            type: "assistant.completed",
            requestId: event.requestId,
            runId: start.runId,
            sessionId: event.sessionId,
            message,
          }),
        );
      } catch (error) {
        const detail =
          error instanceof ProviderError
            ? { code: error.code, message: error.message }
            : {
                code: "PROVIDER_FAILED",
                message: "The model provider could not complete the request.",
              };
        repository.failRun(event.requestId, detail);
        send(
          RunFailedEventSchema.parse({
            type: "run.failed",
            requestId: event.requestId,
            runId: start.runId,
            sessionId: event.sessionId,
            error: detail,
          }),
        );
      }
      });
    });
  });

  return app;
}

function getFailureIdentifiers(input: unknown): {
  requestId: string;
  sessionId: string;
} {
  const record =
    typeof input === "object" && input !== null
      ? (input as Record<string, unknown>)
      : {};
  const requestId =
    typeof record.requestId === "string" &&
    /^req_[A-Za-z0-9_-]+$/.test(record.requestId)
      ? record.requestId
      : `req_invalid_${randomUUID().replaceAll("-", "")}`;
  const sessionIdResult = SessionParamsSchema.safeParse({
    id: record.sessionId,
  });
  return {
    requestId,
    sessionId: sessionIdResult.success
      ? sessionIdResult.data.id
      : randomUUID(),
  };
}
