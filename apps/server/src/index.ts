import { buildApp } from "./app.js";
import { readServerConfig } from "./config.js";
import { createLoggerOptions, sanitizeLogValue } from "./security.js";

const { host, port, frontendOrigin } = readServerConfig();
const app = buildApp(
  { logger: createLoggerOptions() },
  { frontendOrigin },
);

const shutdown = async () => {
  await app.close();
  process.exit(0);
};

process.once("SIGINT", shutdown);
process.once("SIGTERM", shutdown);

try {
  await app.listen({ host, port });
} catch (error) {
  app.log.error(
    { err: sanitizeLogValue(error) },
    "The server could not start.",
  );
  process.exit(1);
}
