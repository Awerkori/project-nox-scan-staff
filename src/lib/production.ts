import type { RealtimeChannel } from "@supabase/supabase-js";
import { supabase } from "./supabase";
import type { Stage } from "../types";

export type ArtifactInput = {
  chapterId: string;
  stage: Stage;
  file: File;
  note?: string;
};

function client() {
  if (!supabase) throw new Error("Supabase não foi configurado.");
  return supabase;
}

export async function claimStage(stageId: string) {
  const { data, error } = await client().rpc("claim_stage", {
    p_stage_id: stageId,
  });
  if (error) throw error;
  return data;
}

export async function releaseStage(stageId: string) {
  const { data, error } = await client().rpc("release_stage", {
    p_stage_id: stageId,
  });
  if (error) throw error;
  return data;
}

export async function markNotificationRead(notificationId: string) {
  const { error } = await client()
    .from("notifications")
    .update({ read_at: new Date().toISOString() })
    .eq("id", notificationId);
  if (error) throw error;
}

export async function markAllNotificationsRead() {
  const { error } = await client()
    .from("notifications")
    .update({ read_at: new Date().toISOString() })
    .is("read_at", null);
  if (error) throw error;
}

export async function completeStage(stageId: string, note?: string) {
  const { data, error } = await client().rpc("complete_stage", {
    p_stage_id: stageId,
    p_note: note ?? null,
  });
  if (error) throw error;
  return data;
}

export async function startCatalogProduction(catalogId: string) {
  const { data, error } = await client().rpc("start_catalog_production", {
    p_catalog_id: catalogId,
  });
  if (error) throw error;
  return data as { id: string };
}

export async function markChapterPublished(chapterId: string) {
  const { error } = await client().rpc("mark_chapter_published", {
    p_chapter_id: chapterId,
  });
  if (error) throw error;
}

export async function reviewChapter(
  stageId: string,
  approved: boolean,
  reason?: string,
  returnStage?: Stage,
) {
  const { error } = await client().rpc("review_chapter", {
    p_stage_id: stageId,
    p_approved: approved,
    p_reason: reason ?? null,
    p_return_stage: returnStage ?? null,
  });
  if (error) throw error;
}

export async function addComment(
  chapterId: string,
  body: string,
  stage?: Stage,
) {
  const { data: auth } = await client().auth.getUser();
  if (!auth.user) throw new Error("Sessão expirada.");
  const { error } = await client()
    .from("comments")
    .insert({
      chapter_id: chapterId,
      body,
      stage: stage ?? null,
      author_id: auth.user.id,
    });
  if (error) throw error;
}

export async function uploadArtifact(input: ArtifactInput) {
  const { data: reserved, error: reserveError } = await client().rpc(
    "reserve_artifact_upload",
    {
      p_chapter_id: input.chapterId,
      p_stage: input.stage,
      p_original_name: input.file.name,
      p_mime_type: input.file.type || "application/octet-stream",
      p_byte_size: input.file.size,
      p_note: input.note ?? null,
    },
  );
  if (reserveError) throw reserveError;
  const artifact = reserved as { id: string; provider_key: string };
  const { error: uploadError } = await client()
    .storage.from("scan-artifacts")
    .upload(artifact.provider_key, input.file, {
      upsert: false,
      contentType: input.file.type || undefined,
    });
  if (uploadError) throw uploadError;
  const { data, error } = await client().rpc("finalize_artifact_upload", {
    p_artifact_id: artifact.id,
  });
  if (error) throw error;
  return data;
}

export async function downloadArtifact(provider: string, key: string) {
  if (provider !== "supabase")
    throw new Error("Este provedor ainda não permite download pelo painel.");
  const { data, error } = await client()
    .storage.from("scan-artifacts")
    .createSignedUrl(key, 300, { download: true });
  if (error) throw error;
  const link = document.createElement("a");
  link.href = data.signedUrl;
  link.rel = "noopener";
  link.download = "";
  link.click();
}

export function subscribeToProduction(
  onChange: () => void,
): RealtimeChannel | null {
  if (!supabase) return null;
  return supabase
    .channel("production-updates")
    .on(
      "postgres_changes",
      { event: "*", schema: "public", table: "chapters" },
      onChange,
    )
    .on(
      "postgres_changes",
      { event: "*", schema: "public", table: "work_chapter_catalog" },
      onChange,
    )
    .on(
      "postgres_changes",
      { event: "*", schema: "public", table: "chapter_stages" },
      onChange,
    )
    .on(
      "postgres_changes",
      { event: "*", schema: "public", table: "artifacts" },
      onChange,
    )
    .on(
      "postgres_changes",
      { event: "*", schema: "public", table: "comments" },
      onChange,
    )
    .on(
      "postgres_changes",
      { event: "*", schema: "public", table: "notifications" },
      onChange,
    )
    .on(
      "postgres_changes",
      { event: "*", schema: "public", table: "activity_log" },
      onChange,
    )
    .subscribe();
}
