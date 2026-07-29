import { describe, expect, it } from "vitest";

import { HealthResponseSchema } from "./index.js";

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
