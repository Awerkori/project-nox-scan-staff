import { describe, expect, it, vi } from "vitest";
import { getPart, PART_BYTES, sendPart, TelegramTransferError } from "../workers/telegram-storage/telegram";
const token = "unit-test-token-not-a-secret";
const id = "12345678-1234-1234-1234-123456789abc";
const chat = "-1001234567890";
describe("private Telegram transport", () => {
  it("uploads bounded parts silently with server-selected names and channel", async () => {
    const send = vi.fn().mockResolvedValue(Response.json({ ok: true, result: { message_id: 42, chat: { id: Number(chat) }, document: { file_id: "ref", file_unique_id: "unique", file_size: 4 } } }));
    expect(await sendPart(token, chat, id, 0, new Blob(["test"]), send)).toEqual({ messageId: 42, fileId: "ref", fileUniqueId: "unique", byteSize: 4 });
    const body = send.mock.calls[0][1].body as FormData;
    expect(body.get("chat_id")).toBe(chat);
    expect(body.get("disable_notification")).toBe("true");
    expect((body.get("document") as File).name).toBe(`nox-${id}-0.part`);
  });
  it("rejects oversized parts before touching the provider", async () => {
    const send = vi.fn();
    await expect(sendPart(token, chat, id, 0, new Blob([new Uint8Array(PART_BYTES + 1)]), send)).rejects.toThrow(TelegramTransferError);
    expect(send).not.toHaveBeenCalled();
  });
  it("never exposes a token-bearing upstream error", async () => {
    const send = vi.fn().mockRejectedValue(new Error(`fetch failed https://api.telegram.org/bot${token}/sendDocument`));
    try { await sendPart(token, chat, id, 0, new Blob(["test"]), send); }
    catch (error) {
      expect(error).toBeInstanceOf(TelegramTransferError);
      expect(String(error)).not.toContain(token);
      return;
    }
    throw new Error("Expected rejection");
  });
  it("returns retry guidance without automatically duplicating a document", async () => {
    const send = vi.fn().mockResolvedValue(Response.json({ ok: false, parameters: { retry_after: 8 } }, { status: 429 }));
    await expect(sendPart(token, chat, id, 0, new Blob(["test"]), send)).rejects.toMatchObject({ code: "RATE_LIMIT", retryAfter: 8 });
    expect(send).toHaveBeenCalledTimes(1);
  });
  it("checks the provider's actual size and channel", async () => {
    const send = vi.fn().mockResolvedValue(Response.json({ ok: true, result: { message_id: 42, chat: { id: -1 }, document: { file_id: "ref", file_unique_id: "unique", file_size: 4 } } }));
    await expect(sendPart(token, chat, id, 0, new Blob(["test"]), send)).rejects.toMatchObject({ code: "INVALID_REPLY" });
  });
  it("returns only download bytes and rejects unsafe paths", async () => {
    const send = vi.fn().mockResolvedValueOnce(Response.json({ ok: true, result: { file_path: "documents/file_1.part", file_size: 4 } })).mockResolvedValueOnce(new Response("test", { headers: { "content-length": "4" } }));
    expect(await new Response(await getPart(token, "ref", 4, send)).text()).toBe("test");
    send.mockResolvedValueOnce(Response.json({ ok: true, result: { file_path: "../secret.part", file_size: 4 } }));
    await expect(getPart(token, "ref", 4, send)).rejects.toMatchObject({ code: "INVALID_REPLY" });
    expect(send).toHaveBeenCalledTimes(3);
  });
});
