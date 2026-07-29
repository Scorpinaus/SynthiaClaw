import { HealthResponseSchema } from "@synthia/shared";
import { afterAll, describe, expect, it } from "vitest";

import { buildApp } from "./app.js";

const app = buildApp({ logger: false });

afterAll(async () => {
  await app.close();
});

describe("GET /api/health", () => {
  it("returns a schema-valid health response", async () => {
    const response = await app.inject({
      method: "GET",
      url: "/api/health",
    });

    expect(response.statusCode).toBe(200);

    const body = HealthResponseSchema.parse(response.json());
    expect(body.status).toBe("ok");
    expect(body.service).toBe("synthia-server");
  });

  it("uses a JSON content type", async () => {
    const response = await app.inject({
      method: "GET",
      url: "/api/health",
    });

    expect(response.headers["content-type"]).toContain("application/json");
  });
});
