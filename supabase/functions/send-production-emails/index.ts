import { createClient } from "npm:@supabase/supabase-js@2";
import { deliverEmail, type EmailJob } from "./worker.ts";

Deno.serve(async (request) => {
  const workerSecret = Deno.env.get("EMAIL_WORKER_SECRET");
  if (
    !workerSecret ||
    request.headers.get("authorization") !== `Bearer ${workerSecret}`
  )
    return new Response("Unauthorized", { status: 401 });
  try {
    const keys = JSON.parse(Deno.env.get("SUPABASE_SECRET_KEYS") || "{}");
    const url = Deno.env.get("SUPABASE_URL");
    const key = keys.default || Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
    if (!url || !key)
      throw new Error("Credenciais do Supabase indisponíveis na função");
    const admin = createClient(url, key, {
      auth: { persistSession: false, autoRefreshToken: false },
    });
    const config = {
      apiKey: Deno.env.get("RESEND_API_KEY") || "",
      from: Deno.env.get("RESEND_FROM") || "",
      appUrl:
        Deno.env.get("STAFF_APP_URL") ||
        "https://awerkori.github.io/project-nox-scan-staff/",
    };
    const body = await request.json().catch(() => ({}));
    if (body.diagnose === true) {
      if (!config.apiKey)
        return Response.json({
          apiKeyConfigured: false,
          fromConfigured: !!config.from,
        });
      const response = await fetch("https://api.resend.com/domains", {
        headers: { Authorization: `Bearer ${config.apiKey}` },
        signal: AbortSignal.timeout(10000),
      });
      const result = await response.json().catch(() => ({}));
      return Response.json({
        apiKeyConfigured: true,
        fromConfigured: !!config.from,
        providerStatus: response.status,
        domains: result.data?.map(
          (domain: { name: string; status: string }) => ({
            name: domain.name,
            status: domain.status,
          }),
        ),
        error: result.message,
      });
    }
    if (!config.apiKey || !config.from) {
      const message =
        "Configure RESEND_API_KEY e RESEND_FROM nos secrets da função";
      const { error } = await admin
        .from("production_email_outbox")
        .update({ last_error: message })
        .eq("status", "PENDING");
      if (error) throw error;
      console.error(message);
      return Response.json({ error: message }, { status: 503 });
    }
    const { data, error } = await admin.rpc("claim_production_email_jobs", {
      p_limit: 5,
    });
    if (error) throw error;
    let sent = 0;
    for (const job of (data || []) as EmailJob[]) {
      const result = await deliverEmail(job, config);
      const { error: saveError } = await admin
        .from("production_email_outbox")
        .update(result)
        .eq("id", job.id)
        .eq("status", "PROCESSING")
        .eq("attempts", job.attempts);
      if (saveError)
        console.error("Falha ao registrar entrega", job.id, saveError.message);
      if (result.status === "SENT" && !saveError) sent++;
      if (result.last_error)
        console.error("Falha de e-mail", job.id, result.last_error);
      await new Promise((resolve) => setTimeout(resolve, 600));
    }
    return Response.json({ processed: data?.length || 0, sent });
  } catch (error) {
    console.error(
      "Worker de e-mail",
      error instanceof Error ? error.message : "Erro inesperado",
    );
    return Response.json(
      { error: "Falha no worker; consulte os logs da função" },
      { status: 500 },
    );
  }
});
