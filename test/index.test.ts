import { afterEach, describe, expect, it, vi } from "vitest";
import type { Env } from "../src/env";
import worker from "../src/index";
import { fakeFetch, json, MemoryKv } from "./fakes";

function env(kv = new MemoryKv()): Env {
  return {
    KV: kv as unknown as KVNamespace,
    SPOTIFY_CLIENT_ID: "id",
    SPOTIFY_CLIENT_SECRET: "secret",
    TELEGRAM_BOT_TOKEN: "bot-token",
    TELEGRAM_WEBHOOK_SECRET: "hook-secret",
    BASE_URL: "https://bot.example",
  };
}

const call = (request: Request, e: Env) => worker.fetch(request as never, e);

afterEach(() => vi.unstubAllGlobals());

describe("POST /telegram", () => {
  it("rejects requests without the webhook secret", async () => {
    const response = await call(new Request("https://bot.example/telegram", { method: "POST", body: "{}" }), env());
    expect(response.status).toBe(403);
  });

  it("accepts requests with the webhook secret", async () => {
    const response = await call(
      new Request("https://bot.example/telegram", {
        method: "POST",
        headers: { "X-Telegram-Bot-Api-Secret-Token": "hook-secret" },
        body: "{}",
      }),
      env(),
    );
    expect(response.status).toBe(200);
  });
});

describe("POST /telegram hardening", () => {
  it("fails closed when the webhook secret is not configured", async () => {
    const e = { ...env(), TELEGRAM_WEBHOOK_SECRET: "" };
    const response = await call(
      new Request("https://bot.example/telegram", { method: "POST", headers: { "X-Telegram-Bot-Api-Secret-Token": "" }, body: "{}" }),
      e,
    );
    expect(response.status).toBe(403);
  });

  it("answers 200 to a malformed body so Telegram does not retry it", async () => {
    const response = await call(
      new Request("https://bot.example/telegram", {
        method: "POST",
        headers: { "X-Telegram-Bot-Api-Secret-Token": "hook-secret" },
        body: "not json",
      }),
      env(),
    );
    expect(response.status).toBe(200);
  });
});

describe("GET /callback", () => {
  it("connects Spotify and notifies the chat that started the login", async () => {
    const kv = new MemoryKv();
    kv.data.set("owner:chat_id", "42");
    kv.data.set("oauth:state:s1", "42");
    const { fetch, requests } = fakeFetch({
      "POST https://accounts.spotify.com/api/token": () => json({ access_token: "a", expires_in: 3600, refresh_token: "r" }),
      "POST https://api.telegram.org/botbot-token/sendMessage": () => json({ ok: true }),
    });
    vi.stubGlobal("fetch", fetch);

    const response = await call(new Request("https://bot.example/callback?code=c1&state=s1"), env(kv));

    expect(response.status).toBe(200);
    expect(kv.data.get("spotify:refresh_token")).toBe("r");
    expect(kv.data.has("oauth:state:s1")).toBe(false);
    expect(requests[0]!.body).toContain("redirect_uri=https%3A%2F%2Fbot.example%2Fcallback");
    expect(JSON.parse(requests[1]!.body)).toEqual({ chat_id: 42, text: "✅ Connected. Tracking your playlists." });
  });

  it("rejects a login started by a chat that is no longer the owner", async () => {
    const kv = new MemoryKv();
    kv.data.set("owner:chat_id", "42");
    kv.data.set("oauth:state:s1", "7");
    vi.stubGlobal("fetch", fakeFetch({}).fetch);

    const response = await call(new Request("https://bot.example/callback?code=c1&state=s1"), env(kv));

    expect(response.status).toBe(403);
    expect(kv.data.has("spotify:refresh_token")).toBe(false);
  });

  it("shows a retry page when the Spotify token exchange fails", async () => {
    const kv = new MemoryKv();
    kv.data.set("owner:chat_id", "42");
    kv.data.set("oauth:state:s1", "42");
    vi.stubGlobal("fetch", fakeFetch({ "POST https://accounts.spotify.com/api/token": () => json({ error: "invalid_grant" }, 400) }).fetch);

    const response = await call(new Request("https://bot.example/callback?code=c1&state=s1"), env(kv));

    expect(response.status).toBe(502);
    expect(await response.text()).toContain("Spotify login failed. Send /start to the bot again.");
    expect(kv.data.has("spotify:refresh_token")).toBe(false);
  });

  it("rejects an unknown or expired state", async () => {
    const response = await call(new Request("https://bot.example/callback?code=c1&state=nope"), env());
    expect(response.status).toBe(400);
  });
});

describe("scheduled", () => {
  it("does nothing until Spotify is connected", async () => {
    const kv = new MemoryKv();
    vi.stubGlobal("fetch", fakeFetch({}).fetch);
    await worker.scheduled({} as ScheduledController, env(kv));
    expect(kv.writes).toBe(0);
  });
});
