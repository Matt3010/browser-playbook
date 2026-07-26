import { buildTestWeb } from "./app";

async function main(): Promise<void> {
  const app = await buildTestWeb();
  const port = Number(process.env.TEST_WEB_PORT ?? 3001);
  const host = process.env.TEST_WEB_HOST ?? "0.0.0.0";

  const shutdown = async () => {
    await app.close();
    process.exit(0);
  };
  process.on("SIGTERM", () => void shutdown());
  process.on("SIGINT", () => void shutdown());

  await app.listen({ port, host });
}

main().catch((err) => {
  console.error("Failed to start test-web", err);
  process.exit(1);
});
