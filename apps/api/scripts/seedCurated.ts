/**
 * Seed the curated example gallery (admin, offline).
 *
 * Runs a handful of showcase prompts through the SAME pipeline /api/generate uses
 * (generateArchitecture → deterministic estimateCosts) and stores each result as a
 * curated run. We call the pipeline directly rather than the HTTP route so seeding
 * bypasses the public friction chain (per-IP daily cap, Turnstile) and the clarify
 * gate — this is a trusted admin task, not a visitor request.
 *
 * COST: each prompt is a real model generation (~$0.10, ~90s on Sonnet). This spends
 * outside the $5/day request ceiling by design; keep the demo list short.
 *
 * Run:  pnpm --filter @stackdraft/api exec node --env-file=../../.env --import tsx scripts/seedCurated.ts
 * Idempotent: re-running replaces each run's content by id but KEEPS accumulated votes.
 */
import { getConfig } from "../src/config.js";
import { buildAppContext } from "../src/app/context.js";
import { generateArchitecture } from "../src/pipeline/generate.js";
import { estimateCosts, parseTrafficVolume } from "../src/pipeline/cost.js";

interface Demo {
  title: string;
  description: string;
  /** Intake answers in the UI's "<label>: <choice>" format (skips the clarify round). */
  answers: string[];
}

const DEMOS: Demo[] = [
  {
    title: "Photo-sharing app",
    description:
      "A photo-sharing app: users upload images, each processed asynchronously " +
      "(thumbnails, content moderation), and others see a feed. Uploads are bursty.",
    answers: [
      "Expected traffic: Hundreds–thousands a day",
      "Downtime tolerance: Important",
      "Data sensitivity: No",
    ],
  },
  {
    title: "URL shortener",
    description:
      "A URL shortener: a public API to create short links and a high-volume redirect " +
      "endpoint that looks up the target and 302s. Reads vastly outnumber writes.",
    answers: [
      "Expected traffic: Millions a day",
      "Downtime tolerance: Mission-critical",
      "Data sensitivity: No",
    ],
  },
  {
    title: "Realtime chat backend",
    description:
      "A realtime chat backend: persistent websocket connections, message fan-out to " +
      "rooms, message history persisted, and presence tracking.",
    answers: [
      "Expected traffic: Hundreds–thousands a day",
      "Downtime tolerance: Mission-critical",
      "Data sensitivity: No",
    ],
  },
  {
    title: "E-commerce checkout API",
    description:
      "An e-commerce checkout API: cart, order placement, payment via a third-party " +
      "processor, inventory decrement, and order-confirmation emails. Spiky at sale times.",
    answers: [
      "Expected traffic: Hundreds–thousands a day",
      "Downtime tolerance: Mission-critical",
      "Data sensitivity: Regulated (HIPAA/PCI/etc.)",
    ],
  },
];

function slug(title: string): string {
  return title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

async function main(): Promise<void> {
  const config = getConfig();
  const ctx = buildAppContext(config);

  console.log(`Seeding ${DEMOS.length} curated runs with ${config.LLM_MODEL} (${config.DEFAULT_REGION})…`);
  for (const demo of DEMOS) {
    const id = slug(demo.title);
    process.stdout.write(`  • ${demo.title} (${id})… `);
    try {
      const generated = await generateArchitecture({
        provider: ctx.provider,
        memory: ctx.stores.memory,
        description: demo.description,
        answers: demo.answers,
        opts: { maxTokens: config.LLM_MAX_TOKENS, effort: config.LLM_EFFORT },
      });
      const estimated = estimateCosts(
        generated.result,
        ctx.stores.pricing,
        config.DEFAULT_REGION,
        parseTrafficVolume(demo.answers),
      );
      ctx.stores.curated.upsert({
        id,
        title: demo.title,
        prompt: demo.description,
        body: JSON.stringify(estimated),
      });
      console.log(`ok (recommends ${estimated.recommendedTier})`);
    } catch (err) {
      console.log(`FAILED`);
      console.error(err);
    }
  }

  ctx.db?.close();
  console.log("Done.");
}

void main();
