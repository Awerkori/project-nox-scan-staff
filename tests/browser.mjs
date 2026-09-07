// Real React + real PostgreSQL/RLS/RPCs. Only the Supabase HTTP envelope,
// OAuth session and blob transport are replaced locally. No production writes.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir } from "node:fs/promises";
import { chromium, expect } from "@playwright/test";
import { as, sql, pool, users, workId, stage, start, finish } from "./database.mjs";

const server = spawn(
  "npm",
  ["run", "dev", "--", "--host", "127.0.0.1", "--port", "4173", "--strictPort"],
  {
    env: {
      ...process.env,
      VITE_SUPABASE_URL: "http://nox.test",
      VITE_SUPABASE_ANON_KEY: "local-public-test-key",
    },
    stdio: "pipe",
    detached: true,
  },
);
server.stderr.on("data", (b) => console.error(String(b)));
const base = "http://127.0.0.1:4173/project-nox-scan-staff/";
for (let i = 0; i < 60; i++) {
  try {
    if ((await fetch(base)).ok) break;
  } catch {
    /* Starting Vite. */
  }
  await new Promise((r) => setTimeout(r, 200));
}
const browser = await chromium.launch({ headless: true });
let currentPage;
await mkdir("test-results", { recursive: true });
const errors = [];
const tables = new Set([
  "staff_members",
  "user_roles",
  "staff_invites",
  "works",
  "work_chapter_catalog",
  "chapters",
  "chapter_stages",
  "artifacts",
  "stage_completions",
  "activity_log",
  "notifications",
  "comments",
  "profiles",
  "production_email_settings",
  "production_email_outbox",
]);
const ident = (s) => {
  assert.match(s, /^[a-z_][a-z_0-9]*$/);
  return `"${s}"`;
};
const relations = {
  staff_members:
    ", 'user_roles',coalesce((select jsonb_agg(jsonb_build_object('role_code',r.role_code,'roles',jsonb_build_object('code',r.role_code))) from user_roles r where r.user_id=t.user_id),'[]')",
  chapters:
    ", 'work',(select to_jsonb(w) from works w where w.id=t.work_id), 'chapter_stages',coalesce((select jsonb_agg(to_jsonb(s)||jsonb_build_object('assignee',(select to_jsonb(p) from profiles p where p.id=s.assigned_to)) order by s.stage) from chapter_stages s where s.chapter_id=t.id),'[]')",
  chapter_stages:
    ", 'assignee',(select to_jsonb(p) from profiles p where p.id=t.assigned_to)",
  work_chapter_catalog:
    ", 'production',coalesce((select jsonb_agg(jsonb_build_object('id',c.id,'cancelled_at',c.cancelled_at,'published_at',c.published_at)) from chapters c where c.catalog_id=t.id),'[]')",
  stage_completions:
    ", 'user',(select to_jsonb(p) from profiles p where p.id=t.user_id)",
  artifacts:
    ", 'uploader',(select to_jsonb(p) from profiles p where p.id=t.uploaded_by)",
  works:
    ", 'catalog',coalesce((select jsonb_agg(jsonb_build_object('status',c.status)) from work_chapter_catalog c where c.work_id=t.id),'[]')",
  comments:
    ", 'author',(select to_jsonb(p) from profiles p where p.id=t.author_id)",
  activity_log:
    ", 'actor',(select to_jsonb(p) from profiles p where p.id=t.actor_id)",
};
function where(params, args) {
  const conditions = [];
  for (const [key, value] of params) {
    if (["select", "order", "limit", "offset"].includes(key)) continue;
    const col = `t.${ident(key)}`;
    if (value === "is.null") conditions.push(`${col} is null`);
    else if (value === "not.is.null") conditions.push(`${col} is not null`);
    else if (value.startsWith("in.(")) {
      const values = value.slice(4, -1).split(",");
      conditions.push(
        `${col} in (${values
          .map((v) => {
            args.push(v);
            return "$" + args.length;
          })
          .join(",")})`,
      );
    } else {
      assert.ok(value.startsWith("eq."));
      args.push(value.slice(3));
      conditions.push(`${col}=$${args.length}`);
    }
  }
  return conditions.length ? " where " + conditions.join(" and ") : "";
}
let downloads = 0;
async function session(name, route = "/") {
  const uid = users[name],
    context = await browser.newContext({
      viewport: { width: 1440, height: 960 },
    });
  const user = {
    id: uid,
    email: `${name}@example.test`,
    aud: "authenticated",
    role: "authenticated",
    app_metadata: { provider: "github" },
    user_metadata: { user_name: name },
  };
  const exp = Math.floor(Date.now() / 1000) + 3600;
  const token = [
    "eyJhbGciOiJIUzI1NiJ9",
    Buffer.from(
      JSON.stringify({ sub: uid, exp, role: "authenticated" }),
    ).toString("base64url"),
    "test",
  ].join(".");
  await context.addInitScript(
    ({ token, exp, user }) =>
      localStorage.setItem(
        "sb-nox-auth-token",
        JSON.stringify({
          access_token: token,
          refresh_token: "fixture-refresh",
          expires_at: exp,
          expires_in: 3600,
          token_type: "bearer",
          user,
        }),
      ),
    { token, exp, user },
  );
  await context.routeWebSocket("**/realtime/**", () => {});
  await context.route("http://nox.test/**", async (route) => {
    const req = route.request(),
      url = new URL(req.url()),
      path = url.pathname,
      method = req.method();
    const json = (body, status = 200, headers = {}) =>
      route.fulfill({
        status,
        contentType: "application/json",
        body: JSON.stringify(body),
        headers,
      });
    try {
      if (path === "/auth/v1/user") return json(user);
      if (path === "/auth/v1/logout") return json({});
      if (path.startsWith("/storage/v1/object/sign/")) {
        downloads++;
        return json({
          signedURL: "/object/download/local-test.txt?token=short-lived",
        });
      }
      if (path.startsWith("/storage/v1/object/download/"))
        return route.fulfill({
          body: "chapter material",
          headers: {
            "content-disposition": 'attachment; filename="chapter.txt"',
          },
        });
      if (path.startsWith("/storage/v1/object/")) {
        // Supabase uploads a raw Blob when passed a browser File.
        const objectPath = path.slice("/storage/v1/object/".length),
          slash = objectPath.indexOf("/");
        const size = Number(req.headers()["x-test-file-size"] || 3);
        const reserved = await as(
          uid,
          "select byte_size from artifacts where provider_key=$1",
          [objectPath.slice(slash + 1)],
        );
        await as(
          uid,
          "insert into storage.objects(bucket_id,name,metadata) values($1,$2,$3)",
          [
            objectPath.slice(0, slash),
            objectPath.slice(slash + 1),
            { size: reserved.rows[0]?.byte_size || size },
          ],
        );
        return json({ Key: objectPath });
      }
      if (path.startsWith("/rest/v1/rpc/")) {
        const fn = ident(path.split("/").at(-1)),
          body = req.postDataJSON() || {},
          args = Object.values(body);
        const named = Object.keys(body)
          .map((key, i) => `${ident(key)}=>$${i + 1}`)
          .join(",");
        const result = await as(
          uid,
          `select to_jsonb(public.${fn}(${named})) result`,
          args,
        );
        return json(
          path.endsWith("/add_catalog_chapter_range")
            ? result.rows.map((row) => row.result)
            : (result.rows[0]?.result ?? null),
        );
      }
      const table = path.split("/").at(-1);
      assert.ok(tables.has(table), path);
      const args = [],
        filter = where(url.searchParams, args);
      if (method === "PATCH") {
        const body = req.postDataJSON(),
          set = Object.entries(body)
            .map(([key, value]) => {
              args.push(value);
              return `${ident(key)}=$${args.length}`;
            })
            .join(",");
        await as(uid, `update ${ident(table)} t set ${set}${filter}`, args);
        return json(null);
      }
      if (method === "DELETE") {
        await as(uid, `delete from ${ident(table)} t${filter}`, args);
        return json(null);
      }
      if (method === "POST") {
        const body = req.postDataJSON();
        assert.ok(!Array.isArray(body));
        const result = await as(
          uid,
          `insert into ${ident(table)}(${Object.keys(body).map(ident)}) values(${Object.values(body).map((v, i) => "$" + (i + 1))}) returning *`,
          Object.values(body),
        );
        return json(
          req.headers().accept?.includes("object")
            ? result.rows[0]
            : result.rows,
        );
      }
      const order = url.searchParams.get("order");
      const sorting = order
        ? " order by " +
          order
            .split(",")
            .map((o) => {
              const [col, dir] = o.split(".");
              return `t.${ident(col)} ${dir === "desc" ? "desc" : "asc"}`;
            })
            .join(",")
        : "";
      const limit = Number(url.searchParams.get("limit") || 1000),
        offset = Number(url.searchParams.get("offset") || 0);
      const extras = relations[table]
        ? `||jsonb_build_object(${relations[table].slice(2)})`
        : "";
      const result = await as(
        uid,
        `select to_jsonb(t)${extras} data from ${ident(table)} t${filter}${sorting} limit ${limit} offset ${offset}`,
        args,
      );
      if (method === "HEAD")
        return route.fulfill({
          status: 200,
          headers: {
            "content-range": `0-${result.rowCount - 1}/${result.rowCount}`,
            "access-control-expose-headers": "content-range",
          },
        });
      const data = result.rows.map((r) => r.data);
      return json(
        req.headers().accept?.includes("object") ? data[0] || null : data,
      );
    } catch (error) {
      console.error("API", method, path, error.message);
      return json({ message: error.message, code: error.code || "TEST" }, 400);
    }
  });
  const page = await context.newPage();
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("dialog", (dialog) => dialog.accept());
  await page.goto(base + "#" + route);
  return { page, context };
}
async function go(page, path) {
  currentPage = page;
  await page.goto(base + "#" + path);
  await page.reload({ waitUntil: "domcontentloaded" });
  await expect(page.locator(".page")).toBeVisible();
}
async function uploadAndFinish(page, label) {
  console.log(`Browser: enviar e concluir ${label}`);
  const chooser = page.waitForEvent("filechooser");
  await page.getByRole("button", { name: "Fazer upload", exact: true }).click();
  await (
    await chooser
  ).setFiles({
    name: "chapter.txt",
    mimeType: "text/plain",
    buffer: Buffer.from("raw"),
  });
  await expect(
    page.getByRole("button", { name: /Arquivo enviado/ }),
  ).toBeVisible();
  await expect(page.locator(".complete-action.action-ready")).toBeEnabled();
  await screenshot(page, `complete-${label.toLowerCase()}-ready`);
  await page
    .getByRole("button", { name: new RegExp(`Concluir ${label}`) })
    .click();
  await expect(page.locator(".mine-section .work-card-action")).toHaveCount(0);
}
async function screenshot(page, name) {
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.screenshot({ path: `test-results/${name}.png`, fullPage: true });
  assert.ok(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
    `${name}: horizontal overflow`,
  );
}
try {
  const sessions = {};
  for (const [name, path, visible] of [
    ["raw", "/raw", ["Raw"]],
    ["clean", "/clean-redraw", ["Clean"]],
    ["translator", "/translation", ["Tradução"]],
    ["type", "/typeset", ["Type"]],
    ["review", "/review", ["Revisão"]],
    ["multi", "/raw", ["Raw", "Type"]],
    [
      "admin",
      "/ready",
      ["Raw", "Clean", "Tradução", "Type", "Revisão", "Pra upar", "Upados"],
    ],
  ]) {
    const s = await session(name, path);
    sessions[name] = s;
    await expect(s.page.locator(".page-heading h2")).toBeVisible();
    for (const channel of [
      "Raw",
      "Clean",
      "Tradução",
      "Type",
      "Revisão",
      "Pra upar",
      "Upados",
    ])
      await expect(
        s.page
          .locator(".sidebar")
          .getByRole("link", { name: new RegExp(channel + "$") }),
      ).toHaveCount(visible.includes(channel) ? 1 : 0);
  }
  const raw = sessions.raw.page,
    clean = sessions.clean.page,
    translation = sessions.translator.page,
    type = sessions.type.page,
    review = sessions.review.page,
    admin = sessions.admin.page;
  await go(raw, "/review");
  await expect(
    raw.getByText("Este canal exige um cargo correspondente."),
  ).toBeVisible();
  await go(raw, "/raw");
  await raw.locator(".raw-picker select").nth(1).selectOption({ label: "#81" });
  await raw.getByRole("button", { name: "Pegar este capítulo" }).click();
  await expect(raw.locator(".mine-section")).toContainText("Distant Sky #81");
  await screenshot(raw, "raw-desktop");
  await uploadAndFinish(raw, "RAW");
  const chapter = (
    await sql("select * from chapters where work_id=$1 and number='81'", [
      workId,
    ])
  ).rows[0];
  await go(clean, "/notifications");
  const cleanNotice = clean.locator(".notification").filter({ hasText: "Clean / Redraw disponível" });
  await expect(cleanNotice).toHaveCount(1);
  await cleanNotice.getByRole("button", { name: "Abrir capítulo" }).click();
  await expect(clean).toHaveURL(new RegExp(`/chapters/${chapter.id}$`));
  await go(clean, "/notifications");
  await expect(clean.locator(".notification.unread")).toHaveCount(0);
  await go(admin, "/admin/settings");
  await expect(admin.getByText("E-mail opcional", { exact: true })).toBeVisible();
  await expect(admin.getByText("Diagnóstico de e-mails", { exact: true })).toHaveCount(0);
  await screenshot(admin, "settings-email-disabled-desktop");
  for (const [page, path] of [
    [clean, "/clean-redraw"],
    [translation, "/translation"],
  ]) {
    await go(page, path);
    await page
      .getByRole("button", { name: "Pegar capítulo", exact: true })
      .click();
    await expect(
      page.getByRole("button", { name: /Baixar RAW/ }),
    ).toBeVisible();
    await page.getByRole("button", { name: /Baixar RAW/ }).click();
  }
  await screenshot(clean, "clean-desktop");
  await screenshot(translation, "translation-desktop");
  await uploadAndFinish(clean, "Clean");
  await go(type, "/typeset");
  await expect(
    type.getByRole("button", { name: "Pegar capítulo", exact: true }),
  ).toHaveCount(0);
  await uploadAndFinish(translation, "Tradução");
  await go(type, "/typeset");
  async function finishType() {
    await go(type, "/typeset");
    await type
      .getByRole("button", { name: "Pegar capítulo", exact: true })
      .click();
    await expect(
      type.getByRole("button", { name: /Baixar Clean/ }),
    ).toBeVisible();
    await expect(
      type.getByRole("button", { name: /Baixar Tradução/ }),
    ).toBeVisible();
    await expect(type.locator(".vertical-credits")).toContainText("raw");
    await expect(type.locator(".vertical-credits")).toContainText("translator");
    await screenshot(type, "type-desktop");
    await uploadAndFinish(type, "Type");
  }
  await finishType();
  for (const target of ["TYPESET", "TRANSLATION", "CLEAN_REDRAW"]) {
    await go(review, "/review");
    await review
      .getByRole("button", { name: "Pegar capítulo", exact: true })
      .click();
    await review.getByRole("link", { name: /Revisar e decidir/ }).click();
    await review
      .getByRole("button", { name: /Baixar Type para revisar/ })
      .click();
    await review.getByText("Solicitar correção", { exact: true }).click();
    await review.getByLabel("Voltar para").selectOption(target);
    await review
      .getByLabel("O que precisa ser corrigido?")
      .fill("Corrigir página 2");
    await review
      .getByRole("button", { name: "Devolver para correção" })
      .click();
    await expect(
      review.getByRole("button", { name: "Aprovar capítulo" }),
    ).toHaveCount(0);
    if (target !== "TYPESET") {
      const [page, path, label] =
        target === "TRANSLATION"
          ? [translation, "/translation", "Tradução"]
          : [clean, "/clean-redraw", "Clean"];
      await go(page, path);
      await page
        .getByRole("button", { name: "Pegar capítulo", exact: true })
        .click();
      await expect(page.locator(".mine-section")).toContainText(
        "Corrigir página 2",
      );
      await uploadAndFinish(page, label);
    }
    await finishType();
  }
  await go(review, "/review");
  await review
    .getByRole("button", { name: "Pegar capítulo", exact: true })
    .click();
  await screenshot(review, "review-desktop");
  await review.getByRole("link", { name: /Revisar e decidir/ }).click();
  await expect(
    review.getByRole("button", { name: "Aprovar capítulo" }),
  ).toBeVisible();
  await screenshot(review, "chapter-desktop");
  await review.getByRole("button", { name: "Aprovar capítulo" }).click();
  await expect(
    review.getByText("Pronto pra upar", { exact: true }),
  ).toBeVisible();
  await go(admin, "/ready");
  await expect(
    admin.getByRole("button", { name: "Baixar arquivo final" }),
  ).toBeEnabled();
  await screenshot(admin, "ready-desktop");
  await admin.getByRole("button", { name: "Marcar como upado" }).click();
  await expect(admin.locator(".publication-card")).toHaveCount(0);
  await go(admin, "/published");
  await expect(admin.locator(".publication-card")).toContainText("#81");
  await screenshot(admin, "published-desktop");
  await go(admin, `/works/${workId}`);
  await expect(admin.getByLabel("Título", { exact: true })).toHaveValue(
    "Distant Sky",
  );
  await expect(admin.getByLabel("Outros nomes")).toHaveValue("Céu distante");
  await expect(admin.getByLabel("Sinopse")).toHaveValue(
    "Uma cidade em silêncio.",
  );
  await screenshot(admin, "catalog-desktop");
  await expect(admin.locator(".catalog-row strong").first()).toHaveText("#117");
  await admin.getByLabel("Selecionar capítulo 117", { exact: true }).check();
  await admin.getByLabel("Ordenação dos capítulos").selectOption("asc");
  await expect(admin.locator(".catalog-row strong").first()).toHaveText("#1");
  await expect(admin.locator(".bulk-bar")).toContainText("1 selecionado");
  await admin.getByRole("button", { name: "Cancelar seleção" }).click();
  await admin.getByLabel("Título", { exact: true }).fill("Distant Sky — teste");
  await admin.getByRole("button", { name: "Salvar informações" }).click();
  await expect(admin.getByRole("status")).toContainText("salvas");
  await admin.reload();
  await expect(admin.locator(".catalog-row strong").first()).toHaveText("#117");
  await admin.getByLabel("Ordenação dos capítulos").selectOption("asc");
  await expect(admin.getByLabel("Título", { exact: true })).toHaveValue(
    "Distant Sky — teste",
  );
  await admin.getByLabel("Número do capítulo").fill("118");
  await admin.getByRole("button", { name: "Adicionar", exact: true }).click();
  await expect(admin.getByRole("status")).toContainText("1 capítulo");
  await admin
    .getByRole("button", { name: "Vários capítulos", exact: true })
    .click();
  await admin.getByLabel("Primeiro").fill("119");
  await admin.getByLabel("Último").fill("121");
  await admin.getByRole("button", { name: "Adicionar", exact: true }).click();
  await expect(admin.getByRole("status")).toContainText("3 capítulo");
  await admin.getByLabel("Selecionar capítulo 1", { exact: true }).check();
  await admin.getByLabel("Selecionar capítulo 2", { exact: true }).check();
  await admin
    .getByRole("button", { name: "Marcar concluídos", exact: true })
    .click();
  await expect(
    admin.locator(".catalog-row").filter({
      has: admin.getByLabel("Selecionar capítulo 1", { exact: true }),
    }),
  ).toContainText("Concluído");
  await admin.getByRole("button", { name: "Concluído", exact: true }).click();
  const protectedRow = admin.locator(".catalog-row").filter({
    has: admin.getByLabel("Selecionar capítulo 81", { exact: true }),
  });
  await protectedRow.getByRole("button", { name: /Opções administrativas/ }).click();
  await expect(
    protectedRow.getByRole("button", { name: "Excluir capítulo", exact: true }),
  ).toBeEnabled();
  await protectedRow.getByRole("button", { name: "Excluir capítulo", exact: true }).click();
  await expect(admin.getByRole("dialog").getByRole("button", { name: "Excluir capítulo" })).toBeDisabled();
  await admin.getByRole("dialog").getByRole("button", { name: "Cancelar", exact: true }).click();
  const inboxChapter = await start(79);
  await finish(inboxChapter, "RAW", users.raw);
  for (const path of ["/", "/works", "/notifications"]) {
    await go(admin, path);
    await screenshot(
      admin,
      path === "/" ? "home-desktop" : `${path.slice(1)}-desktop`,
    );
  }
  await admin.getByRole("button", { name: "Marcar todas como lidas" }).click();
  await expect(admin.locator(".notification.unread")).toHaveCount(0);
  assert.equal((await as(users.admin, "select * from notifications where read_at is null")).rowCount, 0);
  assert.equal((await sql("select * from production_email_outbox")).rowCount, 0);
  assert.equal((await sql("select * from email_worker_diagnostics")).rowCount, 0);
  for (const [width, height, label] of [
    [2560, 1440, "1440p"],
    [1920, 1080, "1080p"],
    [1280, 720, "notebook"],
    [820, 1180, "tablet"],
    [390, 844, "mobile"],
  ]) {
    await admin.setViewportSize({ width, height });
    for (const path of [
      "/raw",
      "/clean-redraw",
      "/translation",
      "/typeset",
      "/review",
      "/ready",
      "/published",
      `/chapters/${chapter.id}`,
      `/works/${workId}`,
    ]) {
      await go(admin, path);
      await expect(admin.locator(".page-heading")).toBeVisible();
      await screenshot(admin, `${label}-${path.split("/")[1]}`);
    }
    if (label === "mobile") {
      await admin
        .getByRole("button", { name: "☰ Menu · Project Nox" })
        .click();
      await expect(
        admin.getByRole("link", { name: "Type", exact: true }),
      ).toBeVisible();
      await admin.getByRole("link", { name: "Type", exact: true }).click();
      await expect(admin.locator(".sidebar")).toBeHidden();
    }
  }
  assert.ok(downloads >= 5);
  await admin.setViewportSize({ width: 1440, height: 960 });
  const returned = await start(82);
  await go(admin, `/chapters/${returned.id}`);
  await admin.locator(".chapter-administration > summary").click();
  const rawStage = await stage(returned, "RAW");
  await admin.getByLabel("Etapa para atribuir").selectOption(rawStage.id);
  await admin.getByLabel("Novo responsável").selectOption(users.raw2);
  await admin.getByRole("button", { name: "Salvar responsável" }).click();
  await admin.getByRole("dialog").getByRole("button", { name: "Confirmar alteração" }).click();
  await expect(admin.getByText("Responsável atualizado.", { exact: true })).toBeVisible();
  assert.equal((await stage(returned, "RAW")).assigned_to, users.raw2);
  await admin.getByLabel("Etapa para atribuir").selectOption(rawStage.id);
  await admin.getByLabel("Novo responsável").selectOption("");
  await admin.getByRole("button", { name: "Salvar responsável" }).click();
  await admin.getByRole("dialog").getByRole("button", { name: "Confirmar alteração" }).click();
  await expect(admin.getByText("Tarefa devolvida à fila.", { exact: true })).toBeVisible();
  assert.equal((await stage(returned, "RAW")).status, "AVAILABLE");
  await go(raw, "/raw");
  await raw
    .getByRole("button", { name: "Pegar capítulo", exact: true })
    .click();
  await expect(raw.locator(".mine-section")).toContainText("#82");
  await raw.getByRole("button", { name: "↩ Devolver à fila", exact: true }).click();
  await raw.getByRole("dialog").getByRole("button", { name: "Cancelar", exact: true }).click();
  assert.equal((await stage(returned, "RAW")).status, "IN_PROGRESS");
  await raw.getByRole("button", { name: "↩ Devolver à fila", exact: true }).click();
  await raw.getByRole("dialog").getByRole("button", { name: "Devolver", exact: true }).click();
  await expect(raw.locator(".work-card-action")).toHaveCount(0);
  await go(admin, `/chapters/${returned.id}`);
  await admin.locator(".chapter-administration > summary").click();
  await screenshot(admin, "admin-chapter-desktop");
  await admin.getByRole("button", { name: "Cancelar produção", exact: true }).click();
  await admin.getByRole("dialog").getByRole("button", { name: "Cancelar produção", exact: true }).click();
  await expect(admin.locator(".chapter-state")).toHaveText("Produção cancelada");
  assert.equal((await sql("select status from work_chapter_catalog where id=$1", [returned.catalog_id])).rows[0].status, "TODO");
  await go(admin, `/works/${workId}`);
  await admin.getByRole("button", { name: "A fazer", exact: true }).click();
  await go(admin, "/published");
  const publishedCard = admin.locator(".publication-card").filter({ hasText: "#81" });
  await publishedCard.getByRole("button", { name: /Opções administrativas/ }).click();
  await expect(admin.locator(".context-panel:popover-open")).toHaveCSS("background-color", "rgb(27, 20, 38)");
  await expect(admin.locator(".context-panel:popover-open")).toHaveCSS("position", "fixed");
  await expect.poll(async () => (await admin.locator(".context-panel:popover-open").boundingBox())?.x).toBeGreaterThan(800);
  await admin.screenshot({ path: "test-results/published-solid-menu.png", fullPage: true });
  await publishedCard.getByRole("button", { name: "Despublicar", exact: true }).click();
  await admin.getByRole("dialog").getByRole("button", { name: "Despublicar", exact: true }).click();
  await expect(publishedCard).toHaveCount(0);
  await go(admin, `/chapters/${chapter.id}`);
  await admin.locator(".chapter-administration > summary").click();
  await admin.getByLabel("Etapa para reabrir").selectOption((await stage(chapter, "TYPESET")).id);
  await admin.getByLabel("Motivo da reabertura").fill("Corrigir créditos na página final");
  await admin.getByRole("button", { name: "Reabrir etapa", exact: true }).click();
  await admin.getByRole("dialog").getByRole("button", { name: "Reabrir etapa", exact: true }).click();
  await expect(admin.getByText("Etapa reaberta. O andamento foi atualizado.")).toBeVisible();
  assert.equal((await stage(chapter, "TYPESET")).status, "AVAILABLE");
  await go(admin, `/chapters/${returned.id}`);
  await admin.locator(".chapter-administration > summary").click();
  await admin.getByRole("button", { name: "Excluir capítulo", exact: true }).click();
  await admin.getByLabel("Confirmação da exclusão").fill("Distant Sky — teste #82");
  await admin.getByRole("dialog").getByRole("button", { name: "Excluir capítulo", exact: true }).click();
  await expect(admin).toHaveURL(/\/works$/);
  assert.equal((await sql("select * from chapters where id=$1", [returned.id])).rowCount, 0);
  await go(admin, "/admin/members");
  await expect(admin.getByRole("heading", { name: "Membros da staff" })).toBeVisible();
  await screenshot(admin, "members-desktop");
  const typeMember = admin.locator(".member-card").filter({ hasText: "@type" });
  await typeMember.locator("summary").click();
  await typeMember.getByLabel("Tradutor", { exact: true }).check();
  await expect(typeMember.locator(".member-role-badges")).toContainText("Tradutor");
  await typeMember.getByRole("button", { name: "Desativar", exact: true }).click();
  await admin.getByRole("dialog").getByRole("button", { name: "Desativar", exact: true }).click();
  await expect(typeMember).toContainText("Desativado");
  await typeMember.getByRole("button", { name: "Reativar", exact: true }).click();
  await expect(typeMember).toContainText("Ativo");
  await admin.getByLabel("GitHub do convidado").fill("new-member");
  await admin.locator(".invite-form").getByLabel("Raw Provider", { exact: true }).check();
  await admin.getByRole("button", { name: "Criar convite", exact: true }).click();
  await expect(admin.getByText("@new-member", { exact: true })).toBeVisible();
  await admin.getByRole("button", { name: "Cancelar convite", exact: true }).click();
  await admin.getByRole("dialog").getByRole("button", { name: "Cancelar convite", exact: true }).click();
  await expect(admin.getByText("@new-member", { exact: true })).toHaveCount(0);
  assert.equal((await stage(chapter, "READY")).status, "WAITING");
  await go(admin, "/");
  await expect(admin.locator(".home-progress")).not.toHaveCount(0);
  await expect(admin.locator(".brand-icon")).toBeVisible();
  await expect(admin.locator(".brand h1")).toHaveCSS("color", "rgb(188, 146, 237)");
  await admin.emulateMedia({ reducedMotion: "reduce" });
  assert.equal(await admin.evaluate(() => window.getComputedStyle(document.querySelector(".cosmic-background i")).animationName), "none");
  await admin.emulateMedia({ reducedMotion: "no-preference" });
  assert.equal(await admin.evaluate(() => window.getComputedStyle(document.querySelector(".cosmic-background i")).animationName), "nox-starlight");
  const frames = await admin.evaluate(() => new Promise(resolve => { const stamps=[]; const frame=t=>{ stamps.push(t); if(stamps.length<90) window.requestAnimationFrame(frame); else resolve(1000*(stamps.length-1)/(t-stamps[0])); }; window.requestAnimationFrame(frame); }));
  console.log(`Animation benchmark: ${frames.toFixed(1)} FPS (headless browser; twelve tiny CSS points, no application animation loop).`);
  await screenshot(admin, "home-current-stages");
  await go(admin, "/works");
  const workCard = admin.locator(".work-card").filter({ hasText: "Distant Sky — teste" });
  await workCard.getByRole("button", { name: /Administrar obra/ }).click();
  await workCard.getByRole("button", { name: "Arquivar obra" }).click();
  await admin.getByRole("dialog").getByRole("button", { name: "Arquivar obra" }).click();
  await expect(workCard).toContainText("Pausada");
  await workCard.getByRole("button", { name: /Administrar obra/ }).click();
  await workCard.getByRole("button", { name: "Excluir obra", exact: true }).click();
  await expect(admin.getByRole("dialog").getByRole("button", { name: "Excluir obra" })).toBeDisabled();
  await admin.getByLabel("Confirmação da exclusão").fill("Distant Sky — teste");
  await admin.getByRole("dialog").getByRole("button", { name: "Excluir obra" }).click();
  await expect(workCard).toHaveCount(0);
  assert.equal((await sql("select * from works where id=$1", [workId])).rowCount, 0);
  assert.deepEqual(errors, []);
  console.log(
    "PASS: Browser production cycle, all three QC returns, publication, roles/manual URL, saved catalog fields, downloads, desktop/notebook/mobile. OAuth/blob envelope is local; database permissions and transitions are real.",
  );
} catch (error) {
  if (currentPage) {
    await currentPage.screenshot({
      path: "test-results/failure.png",
      fullPage: true,
    });
    console.error(await currentPage.locator("main").innerText());
  }
  throw error;
} finally {
  await browser.close();
  process.kill(-server.pid, "SIGTERM");
  await pool.end();
}
