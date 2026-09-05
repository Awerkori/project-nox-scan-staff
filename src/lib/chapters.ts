import { supabase } from "./supabase";

const fields =
  "id,number,title,work:works(id,title),chapter_stages(id,chapter_id,stage,status,assigned_to,assigned_at,completed_at,rejection_reason,assignee:profiles!chapter_stages_assigned_to_fkey(display_name,github_login,avatar_url))";
// Rolling deployment: keep existing queues operational until the forward-only
// publication migration is applied. Never pretend that publication succeeded.
export async function fetchChapters(
  options: { id?: string; published?: boolean; page?: number } = {},
) {
  if (!supabase) throw new Error("Conexão indisponível.");
  const client = supabase;
  const query = (publication: boolean) => {
    let request = client
      .from("chapters")
      .select(fields + (publication ? ",published_at" : ""));
    if (options.id) return request.eq("id", options.id);
    if (publication)
      request = options.published
        ? request.not("published_at", "is", null)
        : request.is("published_at", null);
    return options.published
      ? request
          .order("published_at", { ascending: false })
          .range((options.page || 0) * 30, (options.page || 0) * 30 + 29)
      : request.order("created_at", { ascending: false });
  };
  const result = await query(true);
  if (
    result.error?.code === "42703" &&
    result.error.message.includes("published_at")
  ) {
    if (options.published)
      return { data: [], error: null, publicationAvailable: false };
    return { ...(await query(false)), publicationAvailable: false };
  }
  return { ...result, publicationAvailable: true };
}
