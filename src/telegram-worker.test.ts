import { afterEach, describe, expect, it, vi } from "vitest";
import worker from "../workers/telegram-storage/index";
const env = { SUPABASE_URL: "https://database.test", SUPABASE_ANON_KEY: "public-key", SUPABASE_SERVICE_ROLE_KEY: "private-service", TELEGRAM_BOT_TOKEN: "private-bot", TELEGRAM_CHAT_ID: "-100123", STAFF_ORIGIN: "https://staff.test" };
const path = "https://bridge.test/files/12345678-1234-1234-1234-123456789abc/parts/0";
const hash = "9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08";
const req = (body = "test") => new Request(path, { method: "POST", body, headers: { Authorization: "Bearer member", "X-Part-SHA256": hash } });
afterEach(() => vi.unstubAllGlobals());
describe("authenticated artifact bridge", () => {
  it("denies unauthenticated requests without any upstream call", async () => {
    const send = vi.fn(); vi.stubGlobal("fetch", send);
    expect((await worker.fetch(new Request(path), env)).status).toBe(401);
    expect(send).not.toHaveBeenCalled();
  });
  it("rejects foreign browser origins", async () => {
    const send = vi.fn(); vi.stubGlobal("fetch", send);
    expect((await worker.fetch(new Request(path, { headers: { Origin: "https://attacker.test", Authorization: "Bearer member" } }), env)).status).toBe(403);
    expect(send).not.toHaveBeenCalled();
  });
  it("asks the database with the member's token, never elevated privileges", async () => {
    const send = vi.fn().mockResolvedValue(Response.json({ error: "permission denied" }, { status: 403 })); vi.stubGlobal("fetch", send);
    const response = await worker.fetch(req(), env);
    expect(response.status).toBe(403);
    expect(send).toHaveBeenCalledTimes(1);
    expect(send.mock.calls[0][1].headers.Authorization).toBe("Bearer member");
    expect(send.mock.calls[0][1].headers.apikey).toBe("public-key");
  });
  it("does not upload again after an acknowledged part", async () => {
    const send = vi.fn().mockResolvedValue(Response.json({ stored: true })); vi.stubGlobal("fetch", send);
    expect((await worker.fetch(req(), env)).status).toBe(200);
    expect(send).toHaveBeenCalledTimes(1);
  });
  it("rejects oversized content and resets only the unsent reservation", async () => {
    const send = vi.fn().mockResolvedValueOnce(Response.json({ stored: false, byte_size: 4, lease_id: "lease" })).mockResolvedValueOnce(Response.json(null)); vi.stubGlobal("fetch", send);
    expect((await worker.fetch(req("oversized"), env)).status).toBe(413);
    expect(send).toHaveBeenCalledTimes(2);
    expect(send.mock.calls[1][0]).toContain("reset_unsent_telegram_part");
  });
  it("requires the actual hash and never sends a corrupt part", async () => {
    const send = vi.fn().mockResolvedValueOnce(Response.json({ stored: false, byte_size: 4, lease_id: "lease" })).mockResolvedValueOnce(Response.json(null)); vi.stubGlobal("fetch", send);
    expect((await worker.fetch(req("nope"), env)).status).toBe(400);
    expect(send).toHaveBeenCalledTimes(2);
    expect(send.mock.calls[1][0]).toContain("reset_unsent_telegram_part");
  });
  it("never leaks private keys in error replies", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error(`failed ${env.TELEGRAM_BOT_TOKEN}`)));
    const logger = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const response = await worker.fetch(req(), env);
      expect(response.status).toBe(502);
      const text = await response.text();
      expect(text).not.toContain(env.TELEGRAM_BOT_TOKEN);
      expect(text).not.toContain(env.SUPABASE_SERVICE_ROLE_KEY);
      expect(JSON.stringify(logger.mock.calls)).not.toContain(env.TELEGRAM_BOT_TOKEN);
    } finally { logger.mockRestore(); }
  });
});
