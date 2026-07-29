import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";

import {
  MessageSchema,
  SessionSchema,
  type ErrorDetail,
  type Message,
  type Session,
} from "@synthia/shared";

type DatabaseRow = Record<string, unknown>;

interface StartRunInput {
  requestId: string;
  runId: string;
  sessionId: string;
  text: string;
}

interface StartedRun {
  status: "started";
  runId: string;
  userMessage: Message;
}

interface RunningRun {
  status: "running";
  runId: string;
}

interface CompletedRun {
  status: "completed";
  runId: string;
  assistantMessage: Message;
}

interface FailedRun {
  status: "failed";
  runId: string;
  error: ErrorDetail;
}

export type StartRunResult =
  | StartedRun
  | RunningRun
  | CompletedRun
  | FailedRun;

export class RepositoryError extends Error {
  constructor(
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "RepositoryError";
  }
}

function asString(row: DatabaseRow, key: string): string {
  const value = row[key];
  if (typeof value !== "string") {
    throw new Error(`Database column ${key} was not a string.`);
  }
  return value;
}

function mapSession(row: DatabaseRow): Session {
  return SessionSchema.parse({
    id: asString(row, "id"),
    title: asString(row, "title"),
    createdAt: asString(row, "created_at"),
    updatedAt: asString(row, "updated_at"),
  });
}

function mapMessage(row: DatabaseRow): Message {
  return MessageSchema.parse({
    id: asString(row, "id"),
    sessionId: asString(row, "session_id"),
    role: asString(row, "role"),
    payload: JSON.parse(asString(row, "payload_json")) as unknown,
    createdAt: asString(row, "created_at"),
  });
}

export class ChatRepository {
  private readonly database: DatabaseSync;

  constructor(filename: string) {
    if (filename !== ":memory:") {
      mkdirSync(dirname(filename), { recursive: true });
    }

    this.database = new DatabaseSync(filename);
    this.database.exec("PRAGMA foreign_keys = ON");
    this.database.exec(`
      CREATE TABLE IF NOT EXISTS sessions (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS messages (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
        role TEXT NOT NULL CHECK (role IN ('user', 'assistant')),
        payload_json TEXT NOT NULL,
        request_id TEXT NOT NULL,
        created_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS chat_requests (
        request_id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
        run_id TEXT NOT NULL UNIQUE,
        status TEXT NOT NULL CHECK (status IN ('running', 'completed', 'failed')),
        user_message_id TEXT NOT NULL REFERENCES messages(id),
        assistant_message_id TEXT REFERENCES messages(id),
        error_code TEXT,
        error_message TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS messages_session_created
        ON messages(session_id, created_at);

      CREATE UNIQUE INDEX IF NOT EXISTS one_active_run_per_session
        ON chat_requests(session_id)
        WHERE status = 'running';
    `);

    const now = new Date().toISOString();
    this.database
      .prepare(
        `UPDATE chat_requests
         SET status = 'failed',
             error_code = 'RUN_INTERRUPTED',
             error_message = 'The backend restarted before the run completed.',
             updated_at = ?
         WHERE status = 'running'`,
      )
      .run(now);
  }

  close(): void {
    this.database.close();
  }

  createSession(title = "New conversation"): Session {
    const id = randomUUID();
    const now = new Date().toISOString();
    this.database
      .prepare(
        `INSERT INTO sessions (id, title, created_at, updated_at)
         VALUES (?, ?, ?, ?)`,
      )
      .run(id, title, now, now);
    return SessionSchema.parse({
      id,
      title,
      createdAt: now,
      updatedAt: now,
    });
  }

  listSessions(): Session[] {
    const rows = this.database
      .prepare(
        `SELECT id, title, created_at, updated_at
         FROM sessions
         ORDER BY updated_at DESC, rowid DESC`,
      )
      .all() as DatabaseRow[];
    return rows.map(mapSession);
  }

  getSession(id: string): Session | null {
    const row = this.database
      .prepare(
        `SELECT id, title, created_at, updated_at
         FROM sessions
         WHERE id = ?`,
      )
      .get(id) as DatabaseRow | undefined;
    return row ? mapSession(row) : null;
  }

  listMessages(sessionId: string): Message[] {
    const rows = this.database
      .prepare(
        `SELECT id, session_id, role, payload_json, created_at
         FROM messages
         WHERE session_id = ?
         ORDER BY created_at ASC, rowid ASC`,
      )
      .all(sessionId) as DatabaseRow[];
    return rows.map(mapMessage);
  }

  startRun(input: StartRunInput): StartRunResult {
    return this.transaction(() => {
      const existing = this.getRequest(input.requestId);
      if (existing) {
        const existingUserMessage = this.getMessage(
          asString(existing, "user_message_id"),
        );
        if (
          asString(existing, "session_id") !== input.sessionId ||
          existingUserMessage.payload.text !== input.text
        ) {
          throw new RepositoryError(
            "REQUEST_ID_CONFLICT",
            "This request identifier belongs to a different chat request.",
          );
        }
        return this.mapExistingRun(existing);
      }

      if (!this.getSession(input.sessionId)) {
        throw new RepositoryError(
          "SESSION_NOT_FOUND",
          "The requested session was not found.",
        );
      }

      const active = this.database
        .prepare(
          `SELECT request_id
           FROM chat_requests
           WHERE session_id = ? AND status = 'running'`,
        )
        .get(input.sessionId);
      if (active) {
        throw new RepositoryError(
          "RUN_ACTIVE",
          "This session already has an active run.",
        );
      }

      const now = new Date().toISOString();
      const userMessage = MessageSchema.parse({
        id: randomUUID(),
        sessionId: input.sessionId,
        role: "user",
        payload: { text: input.text },
        createdAt: now,
      });

      this.database
        .prepare(
          `INSERT INTO messages
             (id, session_id, role, payload_json, request_id, created_at)
           VALUES (?, ?, 'user', ?, ?, ?)`,
        )
        .run(
          userMessage.id,
          userMessage.sessionId,
          JSON.stringify(userMessage.payload),
          input.requestId,
          userMessage.createdAt,
        );
      this.database
        .prepare(
          `INSERT INTO chat_requests
             (request_id, session_id, run_id, status, user_message_id,
              created_at, updated_at)
           VALUES (?, ?, ?, 'running', ?, ?, ?)`,
        )
        .run(
          input.requestId,
          input.sessionId,
          input.runId,
          userMessage.id,
          now,
          now,
        );
      this.touchSession(input.sessionId, now);

      return { status: "started", runId: input.runId, userMessage };
    });
  }

  completeRun(requestId: string, text: string): Message {
    return this.transaction(() => {
      const request = this.getRequest(requestId);
      if (!request) {
        throw new RepositoryError("RUN_NOT_FOUND", "The run was not found.");
      }

      if (asString(request, "status") === "completed") {
        return this.getAssistantMessage(request);
      }
      if (asString(request, "status") !== "running") {
        throw new RepositoryError(
          "RUN_NOT_ACTIVE",
          "The run is no longer active.",
        );
      }

      const now = new Date().toISOString();
      const message = MessageSchema.parse({
        id: randomUUID(),
        sessionId: asString(request, "session_id"),
        role: "assistant",
        payload: { text },
        createdAt: now,
      });

      this.database
        .prepare(
          `INSERT INTO messages
             (id, session_id, role, payload_json, request_id, created_at)
           VALUES (?, ?, 'assistant', ?, ?, ?)`,
        )
        .run(
          message.id,
          message.sessionId,
          JSON.stringify(message.payload),
          requestId,
          message.createdAt,
        );
      this.database
        .prepare(
          `UPDATE chat_requests
           SET status = 'completed', assistant_message_id = ?, updated_at = ?
           WHERE request_id = ? AND status = 'running'`,
        )
        .run(message.id, now, requestId);
      this.touchSession(message.sessionId, now);
      return message;
    });
  }

  failRun(requestId: string, error: ErrorDetail): void {
    const now = new Date().toISOString();
    this.database
      .prepare(
        `UPDATE chat_requests
         SET status = 'failed',
             error_code = ?,
             error_message = ?,
             updated_at = ?
         WHERE request_id = ? AND status = 'running'`,
      )
      .run(error.code, error.message, now, requestId);
  }

  private transaction<T>(operation: () => T): T {
    this.database.exec("BEGIN IMMEDIATE");
    try {
      const result = operation();
      this.database.exec("COMMIT");
      return result;
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
  }

  private touchSession(sessionId: string, timestamp: string): void {
    this.database
      .prepare("UPDATE sessions SET updated_at = ? WHERE id = ?")
      .run(timestamp, sessionId);
  }

  private getRequest(requestId: string): DatabaseRow | undefined {
    return this.database
      .prepare(
        `SELECT request_id, session_id, run_id, status, user_message_id,
                assistant_message_id, error_code, error_message
         FROM chat_requests
         WHERE request_id = ?`,
      )
      .get(requestId) as DatabaseRow | undefined;
  }

  private mapExistingRun(row: DatabaseRow): StartRunResult {
    const status = asString(row, "status");
    const runId = asString(row, "run_id");
    if (status === "completed") {
      return {
        status,
        runId,
        assistantMessage: this.getAssistantMessage(row),
      };
    }
    if (status === "failed") {
      return {
        status,
        runId,
        error: {
          code: asString(row, "error_code"),
          message: asString(row, "error_message"),
        },
      };
    }
    return { status: "running", runId };
  }

  private getAssistantMessage(request: DatabaseRow): Message {
    const message = this.getMessage(
      asString(request, "assistant_message_id"),
    );
    if (message.role !== "assistant") {
      throw new Error("A completed run referenced a non-assistant message.");
    }
    return message;
  }

  private getMessage(messageId: string): Message {
    const row = this.database
      .prepare(
        `SELECT id, session_id, role, payload_json, created_at
         FROM messages
         WHERE id = ?`,
      )
      .get(messageId) as DatabaseRow | undefined;
    if (!row) {
      throw new Error("A chat request referenced a missing message.");
    }
    return mapMessage(row);
  }
}
