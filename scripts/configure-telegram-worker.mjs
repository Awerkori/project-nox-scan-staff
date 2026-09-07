// Operator-only: credentials stay in memory and are sent to Wrangler through stdin.
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

try {
  const raw = JSON.parse(execFileSync("npx", ["--yes", "supabase", "projects", "api-keys", "--project-ref", "pgumtergvtbeepzpgvkv", "--output", "json"], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }));
  const keys = Array.isArray(raw) ? raw : raw.api_keys;
  const bot = readFileSync(process.env.NOX_TELEGRAM_TOKEN_FILE || "/tmp/nox-staff-telegram-bot-token.secret", "utf8").trim();
  const secrets = {
    TELEGRAM_BOT_TOKEN: bot,
    SUPABASE_ANON_KEY: keys?.find(k => k.name === "anon")?.api_key,
    SUPABASE_SERVICE_ROLE_KEY: keys?.find(k => k.name === "service_role")?.api_key,
  };
  if (!/^\d+:[\w-]+$/.test(bot) || Object.values(secrets).some(v => !v || v.includes("***"))) throw new Error("Credentials unavailable");
  execFileSync("npx", ["--yes", "wrangler", "secret", "bulk", "--config", "workers/telegram-storage/wrangler.jsonc"], {
    input: JSON.stringify(secrets), encoding: "utf8", stdio: ["pipe", "pipe", "pipe"],
  });
  console.log("Worker secrets configured; no credential values logged.");
} catch {
  console.error("Secret configuration failed. No credential values logged.");
  process.exitCode = 1;
}
