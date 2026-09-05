export type EmailJob = {
  id: string;
  chapter_id: string;
  chapter_stage_id: string;
  recipient_id: string;
  recipient_email: string;
  availability_version: number;
  work_title: string;
  chapter_number: string;
  stage: "CLEAN_REDRAW" | "TRANSLATION" | "TYPESET" | "REVIEW";
  attempts: number;
};
const labels = {
  CLEAN_REDRAW: "Clean / Redraw",
  TRANSLATION: "Tradução",
  TYPESET: "Type",
  REVIEW: "Revisão",
};
const escape = (text: string) =>
  text.replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ]!,
  );
export const isTestSender = (from: string) =>
  /@resend\.dev\s*>?\s*$/i.test(from);

// Operator-only probe: no real chapter/member data and no outbox state changes.
export async function sendConfigurationTest(
  config: { apiKey: string; from: string; appUrl: string },
  send: typeof fetch = fetch,
) {
  if (!isTestSender(config.from))
    throw new Error("O teste exige o remetente resend.dev");
  const response = await send("https://api.resend.com/emails", {
    method: "POST",
    signal: AbortSignal.timeout(12000),
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${config.apiKey}`,
      "Idempotency-Key": "nox/configuration-test/v1",
    },
    body: JSON.stringify({
      from: config.from,
      to: ["delivered@resend.dev"],
      subject: "Project Nox — teste de configuração",
      text: `Teste da integração de e-mail. Não é uma tarefa real.\nAbrir Project Nox: ${config.appUrl}`,
      html: `<h2>PROJECT NOX</h2><p>Teste da integração de e-mail. Não é uma tarefa real.</p><a href="${escape(config.appUrl)}">Abrir Project Nox</a>`,
    }),
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok || !payload.id)
    throw new Error(`${response.status}: ${payload.message || "Resposta inválida do Resend"}`);
  return { accepted: true, simulatedRecipient: true, providerMessageId: String(payload.id) };
}

export async function deliverEmail(
  job: EmailJob,
  config: { apiKey: string; from: string; appUrl: string },
  send: typeof fetch = fetch,
) {
  const link = `${config.appUrl.replace(/\/$/, "")}/#/chapters/${encodeURIComponent(job.chapter_id)}`;
  try {
    const response = await send("https://api.resend.com/emails", {
      method: "POST",
      signal: AbortSignal.timeout(12000),
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${config.apiKey}`,
        "Idempotency-Key": `nox/${job.chapter_stage_id}/${job.availability_version}/${job.recipient_id}`,
      },
      body: JSON.stringify({
        from: config.from,
        to: [job.recipient_email],
        subject: `Novo trabalho disponível — ${job.work_title} #${job.chapter_number}`,
        text: `Novo trabalho disponível\n${job.work_title}\nCapítulo #${job.chapter_number}\n${labels[job.stage]}\nAbrir Project Nox: ${link}`,
        html: `<div style="font-family:Arial,sans-serif;padding:28px;background:#151122;color:#eee"><p style="color:#d9b65f">PROJECT NOX</p><h2>Novo trabalho disponível</h2><p>${escape(job.work_title)} · #${escape(job.chapter_number)}</p><p>${labels[job.stage]}</p><a style="display:inline-block;background:#7858d8;color:white;padding:14px 20px;border-radius:8px;text-decoration:none" href="${escape(link)}">Abrir Project Nox</a></div>`,
      }),
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok || !payload.id)
      throw new Error(
        `${response.status}: ${payload.message || "Resposta inválida do Resend"}`,
      );
    return {
      status: "SENT",
      sent_at: new Date().toISOString(),
      provider_message_id: String(payload.id),
      last_error: null,
      locked_at: null,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : "Falha no envio";
    return {
      status: job.attempts >= 6 ? "FAILED" : "PENDING",
      locked_at: null,
      next_attempt_at: new Date(
        Date.now() + Math.min(60, 2 ** job.attempts) * 60000,
      ).toISOString(),
      last_error: message.slice(0, 2000),
    };
  }
}
