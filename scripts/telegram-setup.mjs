// Registers the Worker as the Telegram webhook and publishes the command menu.
// Reads TELEGRAM_BOT_TOKEN, TELEGRAM_WEBHOOK_SECRET and BASE_URL from the
// environment, falling back to .dev.vars.
import { existsSync, readFileSync } from "node:fs";

const COMMANDS = [
  { command: "resume", description: "Resume a playlist where you left off" },
  { command: "save", description: "Save the current playlist at the exact second" },
  { command: "now", description: "What is playing, at which second, on which device" },
  { command: "untrack", description: "Stop following a playlist" },
  { command: "track", description: "Follow an ignored playlist again" },
];

function loadDevVars(path = ".dev.vars") {
  if (!existsSync(path)) return {};
  return Object.fromEntries(
    readFileSync(path, "utf8")
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line && !line.startsWith("#") && line.includes("="))
      .map((line) => [line.slice(0, line.indexOf("=")), line.slice(line.indexOf("=") + 1)]),
  );
}

const vars = { ...loadDevVars(), ...process.env };
const missing = ["TELEGRAM_BOT_TOKEN", "TELEGRAM_WEBHOOK_SECRET", "BASE_URL"].filter((name) => !vars[name]);
if (missing.length > 0) {
  console.error(`Missing: ${missing.join(", ")} (set them in .dev.vars or the environment)`);
  process.exit(1);
}

async function telegram(method, payload) {
  const response = await fetch(`https://api.telegram.org/bot${vars.TELEGRAM_BOT_TOKEN}/${method}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  const body = await response.json();
  if (!body.ok) throw new Error(`${method} failed: ${body.description}`);
}

const webhookUrl = `${vars.BASE_URL.replace(/\/$/, "")}/telegram`;
await telegram("setWebhook", {
  url: webhookUrl,
  secret_token: vars.TELEGRAM_WEBHOOK_SECRET,
  allowed_updates: ["message", "callback_query"],
});
await telegram("setMyCommands", { commands: COMMANDS });
console.log(`Webhook set to ${webhookUrl} and command menu published.`);
