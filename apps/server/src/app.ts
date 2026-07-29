import { HealthResponseSchema } from "@synthia/shared";
import Fastify, { type FastifyServerOptions } from "fastify";

export function buildApp(options: FastifyServerOptions = {}) {
  const app = Fastify(options);

  app.get("/api/health", async () =>
    HealthResponseSchema.parse({
      status: "ok",
      service: "synthia-server",
      timestamp: new Date().toISOString(),
    }),
  );

  return app;
}
