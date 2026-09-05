import { describe, expect, it, vi } from "vitest";
import {
  deliverEmail,
  type EmailJob,
} from "../supabase/functions/send-production-emails/worker";
const job: EmailJob = {
  id: "job",
  chapter_id: "chapter",
  chapter_stage_id: "stage",
  recipient_id: "member",
  recipient_email: "member@example.test",
  availability_version: 2,
  work_title: "Distant <Sky>",
  chapter_number: "81",
  stage: "TRANSLATION",
  attempts: 1,
};
const config = {
  apiKey: "test-only",
  from: "staff@example.test",
  appUrl: "https://example.test/staff/",
};
describe("production email delivery", () => {
  it("uses the same idempotency key on retries and links to the chapter", async () => {
    const send = vi
      .fn()
      .mockResolvedValue(
        new Response(JSON.stringify({ id: "mail" }), { status: 200 }),
      );
    expect((await deliverEmail(job, config, send)).status).toBe("SENT");
    send.mockResolvedValue(
      new Response(JSON.stringify({ id: "mail" }), { status: 200 }),
    );
    await deliverEmail({ ...job, attempts: 2 }, config, send);
    expect(send.mock.calls[0][1].headers["Idempotency-Key"]).toBe(
      send.mock.calls[1][1].headers["Idempotency-Key"],
    );
    const body = JSON.parse(send.mock.calls[0][1].body);
    expect(body.html).toContain("Distant &lt;Sky&gt;");
    expect(body.html).toContain(
      "https://example.test/staff/#/chapters/chapter",
    );
    expect(body.to).toEqual([job.recipient_email]);
  });
  it.each([403, 429, 500])(
    "records provider error %s without throwing",
    async (status) => {
      const send = vi
        .fn()
        .mockResolvedValue(
          new Response(JSON.stringify({ message: "diagnostic" }), { status }),
        );
      const result = await deliverEmail(job, config, send);
      expect(result.status).toBe("PENDING");
      expect(result.last_error).toContain(`${status}: diagnostic`);
      expect(Date.parse(result.next_attempt_at!)).toBeGreaterThan(Date.now());
    },
  );
  it("stops retrying after six failures and handles network errors", async () => {
    const send = vi.fn().mockRejectedValue(new Error("Network unavailable"));
    expect(
      (await deliverEmail({ ...job, attempts: 6 }, config, send)).status,
    ).toBe("FAILED");
  });
});
