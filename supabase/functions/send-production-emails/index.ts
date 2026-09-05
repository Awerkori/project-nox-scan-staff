import { createClient } from "npm:@supabase/supabase-js@2";

type EmailJob = {
  id: string;
  chapter_stage_id: string;
  chapter_id: string;
  availability_version: number;
  recipient_id: string;
  recipient_email: string;
  work_title: string;
  chapter_number: string;
  stage: "CLEAN_REDRAW" | "TRANSLATION" | "TYPESET" | "REVIEW";
  attempts: number;
};

const stageNames: Record<EmailJob["stage"], string> = {
  CLEAN_REDRAW: "Clean / Redraw",
  TRANSLATION: "Tradução",
  TYPESET: "Type",
  REVIEW: "Revisão / QC",
};
const escapeHtml = (value: string) =>
  value.replace(
    /[&<>"']/g,
    (character) =>
      ({
        "&": "&amp;",
        "<": "&lt;",
        ">": "&gt;",
        '"': "&quot;",
        "'": "&#039;",
      })[character]!,
  );

Deno.serve(async (request) => {
  const workerSecret = Deno.env.get("EMAIL_WORKER_SECRET");
  if (
    !workerSecret ||
    request.headers.get("authorization") !== `Bearer ${workerSecret}`
  ) {
    return new Response("Unauthorized", { status: 401 });
  }
  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const secretKeys = Deno.env.get("SUPABASE_SECRET_KEYS");
  const serviceKey = secretKeys
    ? (JSON.parse(secretKeys) as Record<string, string>).default
    : Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  const resendKey = Deno.env.get("RESEND_API_KEY");
  const from = Deno.env.get("RESEND_FROM");
  const appUrl = (
    Deno.env.get("STAFF_APP_URL") ??
    "https://awerkori.github.io/project-nox-scan-staff/"
  ).replace(/\/$/, "");
  if (!supabaseUrl || !serviceKey)
    return Response.json(
      { error: "Missing Supabase server credentials" },
      { status: 500 },
    );

  const admin = createClient(supabaseUrl, serviceKey, {
    auth: { persistSession: false },
  });
  const { data, error } = await admin.rpc("claim_production_email_jobs", {
    p_limit: 25,
  });
  if (error) return Response.json({ error: error.message }, { status: 500 });
  const jobs = (data ?? []) as EmailJob[];
  const results = await Promise.all(
    jobs.map(async (job) => {
      const stageName = stageNames[job.stage];
      const chapterUrl = `${appUrl}/#/chapters/${job.chapter_id}`;
      try {
        const response = await fetch("https://api.resend.com/emails", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${resendKey}`,
            "Idempotency-Key": `nox/${job.chapter_stage_id}/${job.availability_version}/${job.recipient_id}`,
          },
          body: JSON.stringify({
            from,
            to: [job.recipient_email],
            subject: `${job.work_title} #${job.chapter_number} disponível para ${stageName}`,
            html: `<div style="font-family:Arial,sans-serif;background:#100d1b;color:#eee8ff;padding:32px;border-radius:16px"><p style="color:#d9b65f;font-weight:bold">PROJECT NOX SCAN</p><h1 style="font-size:22px">${escapeHtml(job.work_title)} #${escapeHtml(job.chapter_number)}</h1><p>A etapa <strong>${escapeHtml(stageName)}</strong> ficou disponível.</p><a href="${chapterUrl}" style="display:inline-block;background:#8066e8;color:white;text-decoration:none;padding:12px 18px;border-radius:9px">Abrir central da staff</a></div>`,
          }),
        });
        const payload = (await response.json().catch(() => ({}))) as {
          id?: string;
          message?: string;
        };
        if (response.ok) {
          await admin
            .from("production_email_outbox")
            .update({
              status: "SENT",
              sent_at: new Date().toISOString(),
              provider_message_id: payload.id ?? null,
              last_error: null,
              locked_at: null,
            })
            .eq("id", job.id);
          return { id: job.id, sent: true };
        }
        const terminal = job.attempts >= 6;
        await admin
          .from("production_email_outbox")
          .update({
            status: terminal ? "FAILED" : "PENDING",
            next_attempt_at: new Date(
              Date.now() + Math.min(60, 2 ** job.attempts) * 60_000,
            ).toISOString(),
            last_error:
              `${response.status}: ${payload.message ?? "Resend request failed"}`.slice(
                0,
                2000,
              ),
            locked_at: null,
          })
          .eq("id", job.id);
        return { id: job.id, sent: false };
      } catch (error) {
        const terminal = job.attempts >= 6;
        await admin
          .from("production_email_outbox")
          .update({
            status: terminal ? "FAILED" : "PENDING",
            next_attempt_at: new Date(
              Date.now() + Math.min(60, 2 ** job.attempts) * 60_000,
            ).toISOString(),
            last_error: String(error).slice(0, 2000),
            locked_at: null,
          })
          .eq("id", job.id);
        return { id: job.id, sent: false };
      }
    }),
  );
  return Response.json({ processed: results.length, results });
});
