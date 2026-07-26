import { z } from "zod";

const ConfigSchema = z.object({
  nodeEnv: z.string().default("development"),
  port: z.coerce.number().int().default(5000),
  host: z.string().default("0.0.0.0"),
  databaseUrl: z.string().min(1),
  redisUrl: z.string().min(1),
  credentialsEncKey: z.string().min(16),
  maxSessions: z.coerce.number().int().min(1).default(4),
  sessionTimeoutMs: z.coerce.number().int().default(900_000),
  /**
   * A session driven from the UI is closed after this long without any request
   * touching it, which reclaims the slot when the page is closed or abandoned.
   * Sessions owned by a running execution are never reaped this way.
   */
  sessionIdleTimeoutMs: z.coerce.number().int().min(15_000).default(120_000),
  displayRangeStart: z.coerce.number().int().default(100),
  displayRangeEnd: z.coerce.number().int().default(199),
  vncPortRangeStart: z.coerce.number().int().default(15900),
  vncPortRangeEnd: z.coerce.number().int().default(15999),
  rfbPortRangeStart: z.coerce.number().int().default(5900),
  screenWidth: z.coerce.number().int().default(1280),
  screenHeight: z.coerce.number().int().default(800),
  artifactDir: z.string().default("/data/artifacts"),
  /**
   * Execution logs, notifications and artifact files older than this are pruned.
   * Nothing removed them before, so they grew without a ceiling on a device whose
   * storage is an SD card. 0 disables pruning.
   */
  historyRetentionDays: z.coerce.number().int().min(0).default(30),
  uploadFixtureDir: z.string().default("/data/uploads"),
  allowPrivateTargets: z.boolean().default(false),
  allowedTargetHosts: z.array(z.string()).default([]),
  logLevel: z.string().default("info")
});

export type WorkerConfig = z.infer<typeof ConfigSchema>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): WorkerConfig {
  return ConfigSchema.parse({
    nodeEnv: env.NODE_ENV,
    port: env.WORKER_PORT,
    host: env.WORKER_HOST,
    databaseUrl: env.DATABASE_URL,
    redisUrl: env.REDIS_URL,
    credentialsEncKey: env.CREDENTIALS_ENC_KEY,
    maxSessions: env.WORKER_MAX_SESSIONS,
    sessionTimeoutMs: env.BROWSER_SESSION_TIMEOUT_MS,
    sessionIdleTimeoutMs: env.BROWSER_SESSION_IDLE_TIMEOUT_MS,
    displayRangeStart: env.DISPLAY_RANGE_START,
    displayRangeEnd: env.DISPLAY_RANGE_END,
    vncPortRangeStart: env.VNC_PORT_RANGE_START,
    vncPortRangeEnd: env.VNC_PORT_RANGE_END,
    rfbPortRangeStart: env.RFB_PORT_RANGE_START,
    screenWidth: env.SCREEN_WIDTH,
    screenHeight: env.SCREEN_HEIGHT,
    artifactDir: env.ARTIFACT_DIR,
    historyRetentionDays: env.HISTORY_RETENTION_DAYS,
    uploadFixtureDir: env.UPLOAD_FIXTURE_DIR,
    allowPrivateTargets: env.ALLOW_PRIVATE_TARGETS === "true",
    allowedTargetHosts: (env.ALLOWED_TARGET_HOSTS ?? "")
      .split(",")
      .map((h) => h.trim().toLowerCase())
      .filter(Boolean),
    logLevel: env.LOG_LEVEL
  });
}
