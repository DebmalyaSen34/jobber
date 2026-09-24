import { createServer } from "node:http";
import { createApp } from "./app.js";
import { loadConfig } from "./config.js";
import { MongoPersistence } from "./database.js";

async function main(): Promise<void> {
  const config = loadConfig();
  const persistence = new MongoPersistence(
    config.mongoUri,
    config.mongoDatabase,
    config.mongoConnectTimeoutMs,
    config.release,
  );

  await persistence.connect();
  const server = createServer(createApp(config, persistence));
  server.listen(config.port, "0.0.0.0", () => {
    console.info(`jobber-api listening on port ${config.port} (${config.release})`);
  });

  let shuttingDown = false;
  const shutdown = async (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.info(`jobber-api received ${signal}; shutting down`);

    const timeout = setTimeout(() => {
      console.error("jobber-api shutdown grace period expired");
      process.exit(1);
    }, config.shutdownGraceMs);
    timeout.unref();

    server.close(async (error) => {
      try {
        await persistence.close();
      } finally {
        clearTimeout(timeout);
        process.exit(error ? 1 : 0);
      }
    });
  };

  process.once("SIGTERM", () => void shutdown("SIGTERM"));
  process.once("SIGINT", () => void shutdown("SIGINT"));
}

main().catch(() => {
  console.error("jobber-api failed to start; check server configuration and persistence availability");
  process.exit(1);
});
