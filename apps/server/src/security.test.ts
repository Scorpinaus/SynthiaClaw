import { describe, expect, it } from "vitest";

import {
  REDACTED_VALUE,
  createLoggerOptions,
  redactCredentials,
  sanitizeLogValue,
} from "./security.js";

describe("credential redaction", () => {
  it("redacts common API, OAuth, authorization, and URL credentials", () => {
    const secrets = [
      "sk-live-super-secret",
      "oauth-access-secret",
      "refresh-secret",
      "basic-password",
      "ollama-remote-secret",
    ];
    const unsafe = [
      `Authorization: Bearer ${secrets[0]}`,
      `"access_token":"${secrets[1]}"`,
      `refresh_token=${secrets[2]}`,
      `https://local-user:${secrets[3]}@provider.example/path`,
      `OLLAMA_API_KEY=${secrets[4]}`,
    ].join(" ");

    const safe = redactCredentials(unsafe);

    for (const secret of secrets) expect(safe).not.toContain(secret);
    expect(safe).toContain(REDACTED_VALUE);
  });

  it("sanitizes nested log values and error messages", () => {
    const secret = "sk-nested-secret-value";
    const safe = sanitizeLogValue({
      authorization: `Bearer ${secret}`,
      nested: {
        error: new Error(`OPENAI_API_KEY=${secret}`),
      },
    }) as {
      authorization: string;
      nested: { error: Error };
    };

    expect(JSON.stringify(safe)).not.toContain(secret);
    expect(safe.authorization).toBe(REDACTED_VALUE);
    expect(safe.nested.error.message).toContain(REDACTED_VALUE);
  });

  it("configures structured logger fields for redaction", () => {
    expect(createLoggerOptions()).toMatchObject({
      redact: {
        censor: REDACTED_VALUE,
        paths: expect.arrayContaining([
          "req.headers.authorization",
          "req.headers.cookie",
          "headers.authorization",
          "apiKey",
          "OLLAMA_API_KEY",
          "accessToken",
          "refreshToken",
        ]),
      },
    });
  });
});
