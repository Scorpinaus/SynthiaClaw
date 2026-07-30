import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { ChatRepository, RepositoryError } from "./repository.js";

const repositories: ChatRepository[] = [];
const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const repository of repositories.splice(0)) {
    repository.close();
  }
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { force: true, recursive: true });
  }
});

function openMemoryRepository() {
  const repository = new ChatRepository(":memory:");
  repositories.push(repository);
  return repository;
}

describe("ChatRepository sessions and messages", () => {
  it("creates, orders, and retrieves sessions", () => {
    const repository = openMemoryRepository();
    const first = repository.createSession("First");
    const second = repository.createSession();

    expect(repository.listSessions().map((session) => session.id)).toEqual([
      second.id,
      first.id,
    ]);
    expect(repository.getSession(first.id)).toEqual(first);
    expect(second.title).toBe("New conversation");
  });

  it("persists sessions and JSON message payloads after reopening the database", () => {
    const directory = mkdtempSync(join(tmpdir(), "synthia-repository-"));
    temporaryDirectories.push(directory);
    const filename = join(directory, "chat.sqlite");

    const firstConnection = new ChatRepository(filename);
    const session = firstConnection.createSession("Persistent");
    firstConnection.startRun({
      requestId: "req_persist_1",
      runId: "run_persist_1",
      sessionId: session.id,
      text: "Remember this",
    });
    firstConnection.completeRun("req_persist_1", "Remembered.");
    firstConnection.close();

    const secondConnection = new ChatRepository(filename);
    repositories.push(secondConnection);

    expect(secondConnection.getSession(session.id)?.title).toBe("Persistent");
    expect(secondConnection.listMessages(session.id)).toMatchObject([
      { role: "user", payload: { text: "Remember this" } },
      { role: "assistant", payload: { text: "Remembered." } },
    ]);
  });
});

describe("ChatRepository run invariants", () => {
  it("persists an accepted request exactly once and replays its completion", () => {
    const repository = openMemoryRepository();
    const session = repository.createSession("Idempotency");
    const input = {
      requestId: "req_same_1",
      runId: "run_same_1",
      sessionId: session.id,
      text: "Only once",
    };

    expect(repository.startRun(input).status).toBe("started");
    const assistant = repository.completeRun(input.requestId, "One response");
    expect(repository.completeRun(input.requestId, "Ignored duplicate")).toEqual(
      assistant,
    );
    const duplicate = repository.startRun(input);

    expect(duplicate).toMatchObject({
      status: "completed",
      runId: input.runId,
      assistantMessage: assistant,
    });
    expect(repository.listMessages(session.id)).toHaveLength(2);
  });

  it("cancels an active run idempotently without persisting partial assistant text", () => {
    const repository = openMemoryRepository();
    const session = repository.createSession("Cancellation");
    const input = {
      requestId: "req_cancel_1",
      runId: "run_cancel_1",
      sessionId: session.id,
      text: "Stop this",
    };
    repository.startRun(input);

    expect(repository.cancelRun(input.requestId)).toBe(true);
    expect(repository.cancelRun(input.requestId)).toBe(false);
    expect(repository.startRun(input)).toMatchObject({
      status: "failed",
      runId: input.runId,
      error: { code: "RUN_CANCELLED" },
    });
    expect(() =>
      repository.completeRun(input.requestId, "Late provider response"),
    ).toThrowError(
      expect.objectContaining<Partial<RepositoryError>>({
        code: "RUN_NOT_ACTIVE",
      }),
    );
    expect(repository.listMessages(session.id)).toMatchObject([
      { role: "user", payload: { text: "Stop this" } },
    ]);

    expect(
      repository.startRun({
        requestId: "req_after_cancel_1",
        runId: "run_after_cancel_1",
        sessionId: session.id,
        text: "Try again",
      }).status,
    ).toBe("started");
  });

  it("allows at most one active run per session and unlocks after failure", () => {
    const repository = openMemoryRepository();
    const session = repository.createSession("Serial");
    repository.startRun({
      requestId: "req_active_1",
      runId: "run_active_1",
      sessionId: session.id,
      text: "First",
    });

    expect(() =>
      repository.startRun({
        requestId: "req_active_2",
        runId: "run_active_2",
        sessionId: session.id,
        text: "Second",
      }),
    ).toThrowError(
      expect.objectContaining<Partial<RepositoryError>>({ code: "RUN_ACTIVE" }),
    );

    repository.failRun("req_active_1", {
      code: "PROVIDER_FAILED",
      message: "The provider failed.",
    });

    expect(
      repository.startRun({
        requestId: "req_active_2",
        runId: "run_active_2",
        sessionId: session.id,
        text: "Second",
      }).status,
    ).toBe("started");
  });

  it("rejects a request ID reused for a different session", () => {
    const repository = openMemoryRepository();
    const first = repository.createSession("First");
    const second = repository.createSession("Second");
    repository.startRun({
      requestId: "req_global_1",
      runId: "run_global_1",
      sessionId: first.id,
      text: "First session",
    });
    repository.completeRun("req_global_1", "First response");

    expect(() =>
      repository.startRun({
        requestId: "req_global_1",
        runId: "run_global_2",
        sessionId: second.id,
        text: "Second session",
      }),
    ).toThrowError(
      expect.objectContaining<Partial<RepositoryError>>({
        code: "REQUEST_ID_CONFLICT",
      }),
    );
    expect(repository.listMessages(second.id)).toEqual([]);
  });

  it("rejects a request ID reused with different message text", () => {
    const repository = openMemoryRepository();
    const session = repository.createSession("Request conflict");
    repository.startRun({
      requestId: "req_text_conflict_1",
      runId: "run_text_conflict_1",
      sessionId: session.id,
      text: "Original message",
    });
    repository.completeRun("req_text_conflict_1", "Original response");

    expect(() =>
      repository.startRun({
        requestId: "req_text_conflict_1",
        runId: "run_text_conflict_2",
        sessionId: session.id,
        text: "Different message",
      }),
    ).toThrowError(
      expect.objectContaining<Partial<RepositoryError>>({
        code: "REQUEST_ID_CONFLICT",
      }),
    );
    expect(repository.listMessages(session.id)).toMatchObject([
      { role: "user", payload: { text: "Original message" } },
      { role: "assistant", payload: { text: "Original response" } },
    ]);
  });

  it("unlocks an interrupted run when the database is reopened", () => {
    const directory = mkdtempSync(join(tmpdir(), "synthia-restart-"));
    temporaryDirectories.push(directory);
    const filename = join(directory, "chat.sqlite");

    const firstConnection = new ChatRepository(filename);
    const session = firstConnection.createSession("Interrupted");
    firstConnection.startRun({
      requestId: "req_interrupted_1",
      runId: "run_interrupted_1",
      sessionId: session.id,
      text: "Before restart",
    });
    firstConnection.close();

    const secondConnection = new ChatRepository(filename);
    repositories.push(secondConnection);

    expect(
      secondConnection.startRun({
        requestId: "req_after_restart_1",
        runId: "run_after_restart_1",
        sessionId: session.id,
        text: "After restart",
      }).status,
    ).toBe("started");
    expect(secondConnection.listMessages(session.id)).toMatchObject([
      { role: "user", payload: { text: "Before restart" } },
      { role: "user", payload: { text: "After restart" } },
    ]);
  });

  it("rejects runs for missing sessions without persisting messages", () => {
    const repository = openMemoryRepository();

    expect(() =>
      repository.startRun({
        requestId: "req_missing_1",
        runId: "run_missing_1",
        sessionId: "0f37e589-4ac4-4a79-8061-bae31a9c4cf7",
        text: "Hello?",
      }),
    ).toThrowError(
      expect.objectContaining<Partial<RepositoryError>>({
        code: "SESSION_NOT_FOUND",
      }),
    );
  });
});
