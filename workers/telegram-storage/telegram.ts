// Backend only. This module must never be imported by the Vite application.
// Public Bot API limits require each stored part to remain below 20 MB.
export const PART_BYTES = 8 * 1024 * 1024;
export type TelegramDocument = {
  messageId: number;
  fileId: string;
  fileUniqueId: string;
  byteSize: number;
};
type TelegramReply = {
  ok?: boolean;
  result?: {
    message_id?: number;
    chat?: { id?: number };
    document?: { file_id?: string; file_unique_id?: string; file_size?: number };
    file_path?: string;
    file_size?: number;
  };
  parameters?: { retry_after?: number };
};
export class TelegramTransferError extends Error {
  constructor(
    public readonly code: "RATE_LIMIT" | "TRANSFER_FAILED" | "INVALID_REPLY",
    public readonly retryAfter?: number,
  ) {
    // Do not expose upstream URLs, tokens, response bodies or fetch errors.
    super(code === "RATE_LIMIT" ? "Aguarde um momento antes de tentar novamente." : "Não foi possível transferir o arquivo. Tente novamente.");
  }
}
async function request(
  token: string,
  method: string,
  body: BodyInit,
  send: typeof fetch,
  contentType?: string,
) {
  let response: Response;
  try {
    response = await send(`https://api.telegram.org/bot${token}/${method}`, {
      method: "POST",
      body,
      headers: contentType ? { "Content-Type": contentType } : undefined,
      signal: AbortSignal.timeout(90000),
    });
  } catch {
    throw new TelegramTransferError("TRANSFER_FAILED");
  }
  const reply = await response.json().catch(() => ({})) as TelegramReply;
  if (response.status === 429 || reply.parameters?.retry_after)
    throw new TelegramTransferError("RATE_LIMIT", Math.min(3600, Math.max(1, reply.parameters?.retry_after || 30)));
  if (!response.ok || !reply.ok || !reply.result)
    throw new TelegramTransferError("INVALID_REPLY");
  return reply.result;
}

export async function sendPart(
  token: string,
  chatId: string,
  artifactId: string,
  index: number,
  bytes: Blob,
  send: typeof fetch = fetch,
): Promise<TelegramDocument> {
  if (!/^[a-f0-9-]{36}$/i.test(artifactId) || !Number.isSafeInteger(index) || index < 0 || bytes.size <= 0 || bytes.size > PART_BYTES)
    throw new TelegramTransferError("TRANSFER_FAILED");
  const data = new FormData();
  data.set("chat_id", chatId);
  data.set("disable_notification", "true");
  data.set("document", bytes, `nox-${artifactId}-${index}.part`);
  data.set("caption", `Project Nox · ${artifactId} · parte ${index + 1}`);
  const result = await request(token, "sendDocument", data, send);
  const document = result.document;
  if (String(result.chat?.id) !== chatId || !Number.isSafeInteger(result.message_id) || !document?.file_id || !document.file_unique_id || document.file_size !== bytes.size)
    throw new TelegramTransferError("INVALID_REPLY");
  return { messageId: result.message_id!, fileId: document.file_id, fileUniqueId: document.file_unique_id, byteSize: document.file_size };
}

export async function getPart(
  token: string,
  fileId: string,
  expectedSize: number,
  send: typeof fetch = fetch,
) {
  if (!Number.isSafeInteger(expectedSize) || expectedSize <= 0 || expectedSize > PART_BYTES)
    throw new TelegramTransferError("TRANSFER_FAILED");
  const result = await request(token, "getFile", JSON.stringify({ file_id: fileId }), send, "application/json");
  if (!result.file_path || !/^[a-zA-Z0-9_/-]+\.[a-zA-Z0-9]+$/.test(result.file_path) || result.file_path.includes("..") || result.file_size !== expectedSize)
    throw new TelegramTransferError("INVALID_REPLY");
  let response: Response;
  try {
    response = await send(`https://api.telegram.org/file/bot${token}/${result.file_path}`, { signal: AbortSignal.timeout(90000) });
  } catch {
    throw new TelegramTransferError("TRANSFER_FAILED");
  }
  if (!response.ok || !response.body || Number(response.headers.get("content-length")) !== expectedSize)
    throw new TelegramTransferError("INVALID_REPLY");
  // Only forward the byte stream, never the upstream URL or response headers.
  return response.body;
}
