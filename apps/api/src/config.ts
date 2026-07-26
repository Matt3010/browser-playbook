import { z } from "zod";

const ConfigSchema = z.object({
  nodeEnv: z.string().default("development"),
  port: z.coerce.number().int().default(4000),
  host: z.string().default("0.0.0.0"),
  databaseUrl: z.string().min(1),
  redisUrl: z.string().min(1),
  jwtSecret: z.string().min(8),
  credentialsEncKey: z.string().min(16),
  sessionTokenTtlSeconds: z.coerce.number().int().default(1800),
  workerUrl: z.string().min(1),
  browserSessionTimeoutMs: z.coerce.number().int().default(900_000),
  allowPrivateTargets: z.boolean().default(false),
  allowedTargetHosts: z.array(z.string()).default([]),
  rateLimitMax: z.coerce.number().int().default(300),
  registerRateLimitMax: z.coerce.number().int().default(10),
  loginRateLimitMax: z.coerce.number().int().default(20),
  logLevel: z.string().default("info")
});

export type Config = z.infer<typeof ConfigSchema>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  return ConfigSchema.parse({
    nodeEnv: env.NODE_ENV,
    port: env.API_PORT,
    host: env.API_HOST,
    databaseUrl: env.DATABASE_URL,
    redisUrl: env.REDIS_URL,
    jwtSecret: env.JWT_SECRET,
    credentialsEncKey: env.CREDENTIALS_ENC_KEY,
    sessionTokenTtlSeconds: env.SESSION_TOKEN_TTL_SECONDS,
    workerUrl: env.WORKER_URL ?? "http://worker:5000",
    browserSessionTimeoutMs: env.BROWSER_SESSION_TIMEOUT_MS,
    allowPrivateTargets: env.ALLOW_PRIVATE_TARGETS === "true",
    allowedTargetHosts: (env.ALLOWED_TARGET_HOSTS ?? "")
      .split(",")
      .map((h) => h.trim().toLowerCase())
      .filter(Boolean),
    rateLimitMax: env.RATE_LIMIT_MAX,
    registerRateLimitMax: env.REGISTER_RATE_LIMIT_MAX,
    loginRateLimitMax: env.LOGIN_RATE_LIMIT_MAX,
    logLevel: env.LOG_LEVEL
  });
}
