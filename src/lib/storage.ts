import { supabase } from "./supabase";

export type TransferProgress = (done: number, total: number) => void;
type ReservedArtifact = { id: string; provider: string; provider_key: string };
type Manifest = { name: string; mime_type: string; byte_size: number; parts: { index: number; byte_size: number; sha256: string }[] };

function client() {
  if (!supabase) throw new Error("Supabase não foi configurado.");
  return supabase;
}

async function configuration() {
  const { data, error } = await client().rpc("artifact_upload_configuration");
  if (error) throw error;
  if (!data?.bridge_url || !/^https:\/\/[a-z0-9.-]+\.workers\.dev$/.test(data.bridge_url))
    throw new Error("O serviço de arquivos ainda não está disponível.");
  return data as { bridge_url: string; part_bytes: number };
}

async function authorization() {
  const { data, error } = await client().auth.getSession();
  if (error || !data.session) throw new Error("Entre novamente para acessar os arquivos.");
  return `Bearer ${data.session.access_token}`;
}

async function transfer(url: string, init: RequestInit): Promise<Response> {
  for (let attempt = 0; ; attempt++) {
    let response: Response;
    try {
      response = await fetch(url, { ...init, signal: AbortSignal.timeout(120000) });
    } catch {
      throw new Error("A conexão foi interrompida. Confira sua internet e tente novamente; os arquivos já concluídos continuam salvos.");
    }
    if (response.status === 429 && attempt < 3) {
      const delay = Math.min(60, Math.max(1, Number(response.headers.get("Retry-After")) || 30));
      await new Promise(resolve => setTimeout(resolve, delay * 1000));
      continue;
    }
    if (!response.ok) {
      const body = await response.json().catch(() => null);
      throw new Error(body?.error || "Não foi possível transferir o arquivo. Tente novamente.");
    }
    return response;
  }
}

async function sha256(bytes: ArrayBuffer) {
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest), b => b.toString(16).padStart(2, "0")).join("");
}

export async function uploadStoredArtifact(artifact: ReservedArtifact, file: File, progress?: TransferProgress) {
  progress?.(0, file.size);
  if (artifact.provider === "supabase") {
    const { error } = await client().storage.from("scan-artifacts").upload(artifact.provider_key, file, {
      upsert: false, contentType: file.type || undefined,
    });
    if (error) throw error;
    progress?.(file.size, file.size);
    return;
  }
  if (artifact.provider !== "telegram") throw new Error("Armazenamento indisponível.");
  const config = await configuration();
  if (config.part_bytes !== 8388608) throw new Error("Atualize a página antes de enviar.");
  for (let offset = 0, index = 0; offset < file.size; offset += config.part_bytes, index++) {
    const chunk = file.slice(offset, offset + config.part_bytes);
    const hash = await sha256(await chunk.arrayBuffer());
    await transfer(`${config.bridge_url}/files/${artifact.id}/parts/${index}`, {
      method: "POST", body: chunk,
      headers: { Authorization: await authorization(), "Content-Type": "application/octet-stream", "X-Part-SHA256": hash },
    });
    progress?.(Math.min(file.size, offset + chunk.size), file.size);
  }
}

function saveUrl(url: string, name = "") {
  const link = document.createElement("a");
  link.href = url; link.download = name; link.rel = "noopener";
  document.body.append(link); link.click(); link.remove();
}

export async function downloadStoredArtifact(provider: string, key: string, progress?: TransferProgress) {
  if (provider === "supabase") {
    const { data, error } = await client().storage.from("scan-artifacts").createSignedUrl(key, 300, { download: true });
    if (error) throw error;
    saveUrl(data.signedUrl);
    return;
  }
  if (provider !== "telegram") throw new Error("Armazenamento indisponível.");
  const config = await configuration();
  const { data, error } = await client().rpc("telegram_download_manifest", { p_provider_key: key });
  if (error) throw error;
  const manifest = data as Manifest;
  const chunks: Blob[] = [];
  let total = 0;
  progress?.(0, manifest.byte_size);
  for (const part of manifest.parts) {
    const response = await transfer(`${config.bridge_url}/files/${key}/parts/${part.index}`, {
      headers: { Authorization: await authorization() },
    });
    const bytes = await response.arrayBuffer();
    if (bytes.byteLength !== part.byte_size || await sha256(bytes) !== part.sha256)
      throw new Error("O download foi interrompido ou está incompleto. Tente baixar novamente.");
    chunks.push(new Blob([bytes])); total += bytes.byteLength;
    progress?.(total, manifest.byte_size);
  }
  if (total !== manifest.byte_size) throw new Error("Arquivo incompleto. Tente baixar novamente.");
  const url = URL.createObjectURL(new Blob(chunks, { type: manifest.mime_type || "application/octet-stream" }));
  saveUrl(url, manifest.name);
  setTimeout(() => URL.revokeObjectURL(url), 60000);
}
