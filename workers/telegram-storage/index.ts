import { getPart, PART_BYTES, sendPart, TelegramTransferError } from "./telegram";
type Env = {
  SUPABASE_URL: string;
  SUPABASE_ANON_KEY: string;
  SUPABASE_SERVICE_ROLE_KEY: string;
  TELEGRAM_BOT_TOKEN: string;
  TELEGRAM_CHAT_ID: string;
  STAFF_ORIGIN: string;
};
class RequestError extends Error {
  constructor(public status: number, message: string) { super(message); }
}
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
async function rpc(env: Env, auth: string, name: string, args: object, privileged = false) {
  const key = privileged ? env.SUPABASE_SERVICE_ROLE_KEY : env.SUPABASE_ANON_KEY;
  const response = await fetch(`${env.SUPABASE_URL}/rest/v1/rpc/${name}`, {
    method: "POST", headers: { apikey: key, Authorization: privileged ? `Bearer ${key}` : auth, "Content-Type": "application/json" },
    body: JSON.stringify(args), signal: AbortSignal.timeout(15000),
  });
  const body = await response.json().catch(() => null);
  if (!response.ok) throw new RequestError(response.status === 401 ? 401 : 403, "A operação não está disponível para sua conta ou para esta etapa.");
  return body;
}
async function boundedBody(request: Request, expected: number) {
  const reader = request.body?.getReader();
  if (!reader) throw new RequestError(400, "Arquivo vazio.");
  const result = new Uint8Array(expected);
  let offset = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    if (offset + value.byteLength > expected) {
      await reader.cancel();
      throw new RequestError(413, "Parte maior que o tamanho reservado.");
    }
    result.set(value, offset); offset += value.byteLength;
  }
  if (offset !== expected) throw new RequestError(400, "O arquivo não terminou de enviar.");
  return result;
}
export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const origin = request.headers.get("Origin");
    const cors = {
      "Access-Control-Allow-Origin": env.STAFF_ORIGIN,
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
      "Access-Control-Allow-Headers": "Authorization, Content-Type, X-Part-SHA256",
      "Access-Control-Expose-Headers": "Retry-After",
      "Vary": "Origin", "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff",
    };
    const json = (value: object, status = 200, extra: Record<string, string> = {}) => Response.json(value, { status, headers: { ...cors, ...extra } });
    try {
      if (origin && origin !== env.STAFF_ORIGIN) return json({ error: "Origem não autorizada." }, 403);
      if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });
      const url = new URL(request.url);
      if (url.pathname === "/health" && request.method === "GET")
        return json({ ready: !!(env.TELEGRAM_BOT_TOKEN && env.SUPABASE_SERVICE_ROLE_KEY && env.SUPABASE_ANON_KEY), partBytes: PART_BYTES });
      const auth = request.headers.get("Authorization") || "";
      if (!auth.startsWith("Bearer ")) return json({ error: "Entre na central para acessar arquivos." }, 401);
      const match = url.pathname.match(/^\/files\/([^/]+)\/parts\/(\d+)$/);
      if (!match || !uuid.test(match[1])) return json({ error: "Arquivo não encontrado." }, 404);
      const [, key, indexText] = match;
      const index = Number(indexText);
      if (!Number.isSafeInteger(index) || index > 127) return json({ error: "Parte inválida." }, 400);
      if (request.method === "POST") {
        const hash = request.headers.get("X-Part-SHA256") || "";
        if (!/^[a-f0-9]{64}$/.test(hash)) throw new RequestError(400, "Verificação do arquivo ausente.");
        const part = await rpc(env, auth, "begin_telegram_artifact_part", { p_artifact_id: key, p_part_index: index, p_sha256: hash });
        if (part.stored) return json({ stored: true });
        let contactedTelegram = false;
        try {
          const bytes = await boundedBody(request, part.byte_size);
          const digest = await crypto.subtle.digest("SHA-256", bytes);
          const actualHash = Array.from(new Uint8Array(digest), b => b.toString(16).padStart(2, "0")).join("");
          if (actualHash !== hash) throw new RequestError(400, "O conteúdo enviado não passou na verificação.");
          contactedTelegram = true;
          const stored = await sendPart(env.TELEGRAM_BOT_TOKEN, env.TELEGRAM_CHAT_ID, key, index, new Blob([bytes]));
          const confirmation = { p_artifact_id: key, p_part_index: index, p_lease_id: part.lease_id,
            p_file_id: stored.fileId, p_message_id: stored.messageId, p_chat_id: env.TELEGRAM_CHAT_ID, p_byte_size: stored.byteSize, p_sha256: actualHash };
          // Retry only the idempotent database acknowledgement, never sendDocument.
          for (let attempt = 0; ; attempt++) {
            try { await rpc(env, auth, "confirm_telegram_artifact_part", confirmation, true); break; }
            catch (error) { if (attempt >= 2) throw error; }
          }
          return json({ stored: true });
        } catch (error) {
          if (!contactedTelegram || (error instanceof TelegramTransferError && error.code === "RATE_LIMIT"))
            await rpc(env, auth, "reset_unsent_telegram_part", { p_artifact_id: key, p_part_index: index, p_lease_id: part.lease_id }, true).catch(() => {});
          throw error;
        }
      }
      if (request.method === "GET") {
        const manifest = await rpc(env, auth, "telegram_download_manifest", { p_provider_key: key });
        const expected = manifest.parts?.find((part: { index: number }) => part.index === index);
        if (!expected) throw new RequestError(404, "Parte não encontrada.");
        const response = await fetch(`${env.SUPABASE_URL}/rest/v1/telegram_artifact_parts?artifact_id=eq.${manifest.artifact_id}&part_index=eq.${index}&state=eq.STORED&select=telegram_file_id,telegram_chat_id`, {
          headers: { apikey: env.SUPABASE_SERVICE_ROLE_KEY, Authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}` }, signal: AbortSignal.timeout(15000),
        });
        const rows = await response.json();
        if (!response.ok || rows.length !== 1 || rows[0].telegram_chat_id !== env.TELEGRAM_CHAT_ID) throw new RequestError(404, "Arquivo indisponível.");
        const body = await getPart(env.TELEGRAM_BOT_TOKEN, rows[0].telegram_file_id, expected.byte_size);
        return new Response(body, { headers: { ...cors, "Content-Type": "application/octet-stream", "Content-Length": String(expected.byte_size) } });
      }
      return json({ error: "Operação não permitida." }, 405);
    } catch (error) {
      if (error instanceof TelegramTransferError && error.code === "RATE_LIMIT")
        return json({ error: error.message }, 429, { "Retry-After": String(error.retryAfter || 30) });
      if (error instanceof RequestError) return json({ error: error.message }, error.status);
      // No error object/stack/URL logging: fetch errors may contain bot-token URLs.
      console.error("Artifact transfer failed", error instanceof TelegramTransferError ? error.code : "INTERNAL");
      return json({ error: "Não foi possível concluir a transferência. O arquivo original permanece seguro." }, 502);
    }
  },
};
