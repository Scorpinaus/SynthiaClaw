export const REDACTED_VALUE = "[REDACTED]";

const sensitiveKeyPattern =
  /^(?:authorization|cookie|set-cookie|password|api[_-]?key|openai_api_key|ollama_api_key|access[_-]?token|refresh[_-]?token|client[_-]?secret)$/i;

export function redactCredentials(value: string): string {
  return value
    .replace(
      /([a-z][a-z0-9+.-]*:\/\/[^:/\s@]+:)([^@\s/]+)(@)/gi,
      `$1${REDACTED_VALUE}$3`,
    )
    .replace(
      /(\bAuthorization\b\s*[:=]\s*(?:Bearer|Basic)\s+)([^\s,;"']+)/gi,
      `$1${REDACTED_VALUE}`,
    )
    .replace(
      /(\b(?:OPENAI_API_KEY|OLLAMA_API_KEY|api[_-]?key|access[_-]?token|refresh[_-]?token|client[_-]?secret|password)\b\s*["']?\s*[:=]\s*["']?)([^"',;\s}]+)/gi,
      `$1${REDACTED_VALUE}`,
    )
    .replace(/\bsk-[A-Za-z0-9_-]{8,}\b/g, REDACTED_VALUE)
    .replace(
      /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g,
      REDACTED_VALUE,
    );
}

export function sanitizeLogValue(value: unknown): unknown {
  return sanitizeValue(value, new WeakMap<object, unknown>());
}

export function createLoggerOptions() {
  return {
    redact: {
      censor: REDACTED_VALUE,
      paths: [
        "req.headers.authorization",
        "req.headers.cookie",
        'req.headers["x-api-key"]',
        "res.headers.set-cookie",
        "headers.authorization",
        "headers.cookie",
        'headers["x-api-key"]',
        "authorization",
        "cookie",
        "password",
        "apiKey",
        "api_key",
        "OPENAI_API_KEY",
        "OLLAMA_API_KEY",
        "accessToken",
        "access_token",
        "refreshToken",
        "refresh_token",
        "clientSecret",
        "client_secret",
      ],
    },
  };
}

function sanitizeValue(
  value: unknown,
  seen: WeakMap<object, unknown>,
): unknown {
  if (typeof value === "string") return redactCredentials(value);
  if (typeof value !== "object" || value === null) return value;

  const existing = seen.get(value);
  if (existing !== undefined) return existing;

  if (value instanceof Error) {
    const safeError = new Error(redactCredentials(value.message));
    seen.set(value, safeError);
    safeError.name = value.name;
    if (value.stack) safeError.stack = redactCredentials(value.stack);
    for (const [key, nested] of Object.entries(value)) {
      Object.assign(safeError, {
        [key]: sensitiveKeyPattern.test(key)
          ? REDACTED_VALUE
          : sanitizeValue(nested, seen),
      });
    }
    return safeError;
  }

  if (Array.isArray(value)) {
    const safeArray: unknown[] = [];
    seen.set(value, safeArray);
    safeArray.push(...value.map((item) => sanitizeValue(item, seen)));
    return safeArray;
  }

  const safeRecord: Record<string, unknown> = {};
  seen.set(value, safeRecord);
  for (const [key, nested] of Object.entries(value)) {
    safeRecord[key] = sensitiveKeyPattern.test(key)
      ? REDACTED_VALUE
      : sanitizeValue(nested, seen);
  }
  return safeRecord;
}
