import { z } from "zod";

/**
 * Centralized, validated runtime configuration (12-factor).
 *
 * Defaults are deliberately FORKER-SAFE (R15/KTD10): a clone that runs without
 * tuning anything is protected before it sets a single value — low daily spend
 * ceiling, low per-IP cap, rate limiting on, bot check honored when keys exist.
 * Secrets are read from env only and never logged (see obs/telemetry redaction).
 */
const boolish = z
  .string()
  .transform((v) => v.trim().toLowerCase())
  .pipe(z.enum(["1", "0", "true", "false", "yes", "no", "on", "off"]))
  .transform((v) => ["1", "true", "yes", "on"].includes(v));

const ConfigSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  PORT: z.coerce.number().int().positive().default(8080),
  HOST: z.string().default("0.0.0.0"),

  // LLM
  ANTHROPIC_API_KEY: z.string().min(1, "ANTHROPIC_API_KEY is required"),
  LLM_MODEL: z.string().default("claude-sonnet-4-6"),
  // `low` keeps generation fast/cheap for a public tool; the system prompt is
  // detailed enough that higher effort adds latency without much quality gain.
  LLM_EFFORT: z.enum(["low", "medium", "high"]).default("low"),
  // Headroom so a full three-tier design never truncates (truncation → parse
  // failure → retry → multi-minute latency). The conciseness directive in the
  // system prompt keeps actual output well under this.
  LLM_MAX_TOKENS: z.coerce.number().int().positive().default(14000),
  LLM_MAX_INPUT_TOKENS: z.coerce.number().int().positive().default(12000),

  // Per-MTok USD list-price rates used to convert token usage to dollars for the
  // spend ledger + telemetry. Defaults are Sonnet-class on-demand list prices;
  // override when the model or negotiated pricing changes. Approximate by design
  // (the ledger reconciles actuals; the guard stays conservative).
  LLM_PRICE_INPUT_PER_MTOK: z.coerce.number().nonnegative().default(3),
  LLM_PRICE_OUTPUT_PER_MTOK: z.coerce.number().nonnegative().default(15),
  LLM_PRICE_CACHE_WRITE_PER_MTOK: z.coerce.number().nonnegative().default(3.75),
  LLM_PRICE_CACHE_READ_PER_MTOK: z.coerce.number().nonnegative().default(0.3),

  // Region / pricing
  DEFAULT_REGION: z.string().default("us-east-1"),
  PRICING_REFRESH_CRON: z.string().default("0 3 1 * *"),

  // Cost + abuse controls (R11)
  DAILY_SPEND_CEILING_USD: z.coerce.number().positive().default(5),
  PER_IP_DAILY_GENERATIONS: z.coerce.number().int().positive().default(20),
  RATE_LIMIT_MAX: z.coerce.number().int().positive().default(30),
  RATE_LIMIT_WINDOW_MS: z.coerce.number().int().positive().default(60_000),
  RESPONSE_CACHE_TTL_MS: z.coerce.number().int().positive().default(86_400_000),

  // Bot check (Cloudflare Turnstile) — enabled only when secret is set
  TURNSTILE_SECRET: z.string().optional(),
  TURNSTILE_SITE_KEY: z.string().optional(),

  // Optional shared-credential demo access gate — off when unset (KTD8)
  ACCESS_GATE_USER: z.string().optional(),
  ACCESS_GATE_PASS: z.string().optional(),

  // Research-on-miss (KTD4/U6) — off by default; bounded when on
  RESEARCH_ON_MISS: boolish.default("false"),
  RESEARCH_MAX_CALLS_PER_REQUEST: z.coerce.number().int().nonnegative().default(2),

  // Storage
  DB_PATH: z.string().default("./data/stackdraft.db"),

  // Static SPA build directory served by the API
  WEB_DIST: z.string().default("../web/dist"),
});

export type Config = z.infer<typeof ConfigSchema>;

let cached: Config | undefined;

/** Parse + validate process env. Fails fast with a clear message (U1 error path). */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const parsed = ConfigSchema.safeParse(env);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `  - ${i.path.join(".") || "(root)"}: ${i.message}`)
      .join("\n");
    throw new Error(`Invalid configuration:\n${issues}`);
  }
  return parsed.data;
}

export function getConfig(): Config {
  if (!cached) cached = loadConfig();
  return cached;
}

/** Test helper: reset the memoized config. */
export function resetConfigCache(): void {
  cached = undefined;
}
