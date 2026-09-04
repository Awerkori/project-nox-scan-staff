import { useEffect, useState } from "react";
import {
  Link,
  NavLink,
  Outlet,
  Route,
  Routes,
  useNavigate,
  useParams,
} from "react-router-dom";
import {
  addComment,
  claimStage,
  completeStage,
  downloadArtifact,
  markAllNotificationsRead,
  markNotificationRead,
  releaseStage,
  reviewChapter,
  startCatalogProduction,
  uploadArtifact,
} from "./lib/production";
import { supabase } from "./lib/supabase";
import { stageLabel, stageRole } from "./workflow";
import type {
  Artifact,
  Chapter,
  ChapterStage,
  Role,
  StaffMember,
  Stage,
} from "./types";

export type PanelProps = {
  member: StaffMember;
  chapters: Chapter[];
  notifications: number;
  toast: string;
  refresh: () => void;
  logout: () => void;
};
type Entry = { chapter: Chapter; stage: ChapterStage };
const groups = [
  [
    "HOMEPAGE",
    [
      ["🏠", "Início", "/"],
      ["📚", "Obras", "/works"],
      ["🔔", "Notificações", "/notifications"],
    ],
  ],
  [
    "PRODUÇÃO",
    [
      ["📥", "Raw", "/raw"],
      ["🎨", "Clean", "/clean-redraw"],
      ["🌐", "Tradução", "/translation"],
      ["✒️", "Type", "/typeset"],
      ["🔎", "Revisão", "/review"],
      ["✅", "Prontos pra upar", "/ready"],
    ],
  ],
] as const;

const routeRole: Record<string, Role> = {
  raw: "RAW_PROVIDER",
  "clean-redraw": "CLEAN_REDRAW",
  translation: "TRANSLATOR",
  typeset: "TYPESETTER",
  review: "REVIEWER_QC",
};
const allowed = (member: StaffMember, role: Role) =>
  role === "ADMIN"
    ? member.is_admin
    : member.is_admin || member.roles.includes(role);

export function PanelRoutes(props: PanelProps) {
  return (
    <Routes>
      <Route element={<Shell {...props} />}>
        <Route index element={<Home {...props} />} />
        <Route
          path="raw"
          element={
            <RoleGate {...props} role="RAW_PROVIDER">
              <RawQueue {...props} />
            </RoleGate>
          }
        />
        <Route
          path="clean-redraw"
          element={
            <RoleGate {...props} role="CLEAN_REDRAW">
              <Queue {...props} stage="CLEAN_REDRAW" />
            </RoleGate>
          }
        />
        <Route
          path="translation"
          element={
            <RoleGate {...props} role="TRANSLATOR">
              <Queue {...props} stage="TRANSLATION" />
            </RoleGate>
          }
        />
        <Route
          path="typeset"
          element={
            <RoleGate {...props} role="TYPESETTER">
              <Queue {...props} stage="TYPESET" />
            </RoleGate>
          }
        />
        <Route
          path="review"
          element={
            <RoleGate {...props} role="REVIEWER_QC">
              <Queue {...props} stage="REVIEW" />
            </RoleGate>
          }
        />
        <Route
          path="ready"
          element={
            <RoleGate {...props} role="ADMIN">
              <Ready {...props} />
            </RoleGate>
          }
        />
        <Route path="works" element={<Works {...props} />} />
        <Route path="works/:id" element={<Work {...props} />} />
        <Route path="chapters/:id" element={<Chapter {...props} />} />
        <Route path="notifications" element={<Notifications {...props} />} />
        {props.member.is_admin && (
          <>
            <Route path="admin/members" element={<Members />} />
            <Route path="admin/settings" element={<Settings />} />
          </>
        )}
        <Route path="*" element={<NotFound />} />
      </Route>
    </Routes>
  );
}

function Shell({ member, notifications, toast, logout }: PanelProps) {
  const navigate = useNavigate();
  return (
    <div className="app">
      <aside>
        <div className="brand">
          <b>N</b>
          <h1>
            Project Nox <small>Scan Staff</small>
          </h1>
        </div>
        <nav>
          {groups.map(([title, links]) => (
            <section key={title}>
              <p>{title}</p>
              {links
                .filter(
                  ([, , to]) =>
                    title !== "PRODUÇÃO" ||
                    member.is_admin ||
                    allowed(member, routeRole[to.slice(1)]),
                )
                .map(([icon, label, to]) => (
                  <NavLink key={to} to={to}>
                    <span>{icon}</span>
                    <em>{label}</em>
                  </NavLink>
                ))}
            </section>
          ))}
          {member.is_admin && (
            <section>
              <p>ADMIN</p>
              <NavLink to="/admin/members">
                <span>👥</span>
                <em>Membros</em>
              </NavLink>
              <NavLink to="/admin/settings">
                <span>⚙️</span>
                <em>Configurações</em>
              </NavLink>
            </section>
          )}
        </nav>
        <div className="profile">
          <strong>{member.display_name || member.github_login}</strong>
          <span>@{member.github_login}</span>
          <button onClick={logout}>Sair</button>
        </div>
      </aside>
      <main>
        <header>
          <div>
            <p className="eyebrow">CENTRAL DE PRODUÇÃO</p>
            <h2>Project Nox Scan</h2>
          </div>
          <button
            className="bell"
            onClick={() => navigate("/notifications")}
            aria-label="Abrir notificações"
          >
            🔔{notifications ? <b>{notifications}</b> : null}
          </button>
        </header>
        {toast ? <div className="toast">{toast}</div> : null}
        <Outlet />
      </main>
    </div>
  );
}

function RoleGate({
  member,
  role,
  children,
}: Pick<PanelProps, "member"> & { role: Role; children: React.ReactNode }) {
  return allowed(member, role) ? (
    children
  ) : (
    <section className="page">
      <h2>Acesso restrito</h2>
      <Empty text="Este canal exige um cargo correspondente." />
    </section>
  );
}

function Home(props: PanelProps) {
  const mine = entries(props.chapters).filter(
    (x) =>
      x.stage.assigned_to === props.member.user_id &&
      x.stage.status === "IN_PROGRESS",
  );
  const available = entries(props.chapters).filter(
    (x) =>
      x.stage.status === "AVAILABLE" &&
      x.stage.stage !== "RAW" &&
      (props.member.is_admin ||
        props.member.roles.includes(
          stageRole[x.stage.stage as keyof typeof stageRole] as Role,
        )),
  );
  return (
    <section className="page">
      <div className="page-heading">
        <p className="eyebrow">VISÃO GERAL</p>
        <h2>Olá, {props.member.display_name || props.member.github_login}</h2>
        <p>O que precisa da sua atenção agora.</p>
      </div>
      <section className="dashboard-grid">
        <Panel title="Minhas tarefas">
          {mine.length ? (
            mine.map((x) => <Task key={x.stage.id} {...x} {...props} />)
          ) : (
            <Empty text="Você está em dia. Nenhuma tarefa atribuída." />
          )}
        </Panel>
        <Panel title="Filas de produção">
          {available.length ? (
            available.map((x) => <Task key={x.stage.id} {...x} {...props} />)
          ) : (
            <Empty text="Não há tarefas disponíveis para seus cargos." />
          )}
        </Panel>
        <Panel title="Capítulos em andamento">
          {props.chapters.length ? (
            props.chapters.map((chapter) => (
              <Link
                className="chapter"
                key={chapter.id}
                to={`/chapters/${chapter.id}`}
              >
                <strong>
                  {chapter.work?.title} #{chapter.number}
                </strong>
                <span>Ver capítulo →</span>
              </Link>
            ))
          ) : (
            <Empty text="Nenhum capítulo entrou em produção." />
          )}
        </Panel>
      </section>
    </section>
  );
}
function RawQueue(props: PanelProps) {
  const navigate = useNavigate();
  const [works, setWorks] = useState<{ id: string; title: string }[]>([]);
  const [workId, setWorkId] = useState("");
  const [catalog, setCatalog] = useState<{ id: string; number: number }[]>([]);
  const [catalogId, setCatalogId] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => {
    void supabase
      ?.from("works")
      .select("id,title")
      .eq("status", "ACTIVE")
      .order("title")
      .then(({ data }) => {
        setWorks(data ?? []);
        setWorkId(data?.[0]?.id ?? "");
      });
  }, []);
  useEffect(() => {
    if (!workId) return;
    void supabase
      ?.from("work_chapter_catalog")
      .select("id,number")
      .eq("work_id", workId)
      .eq("status", "TODO")
      .order("number")
      .limit(500)
      .then(({ data, error }) => {
        setCatalog(data ?? []);
        setCatalogId(data?.[0]?.id ?? "");
        setError(error?.message ?? "");
      });
  }, [workId]);
  const start = async () => {
    if (!catalogId || busy) return;
    setBusy(true);
    setError("");
    try {
      const chapter = await startCatalogProduction(catalogId);
      props.refresh();
      navigate(`/chapters/${chapter.id}`);
    } catch (cause) {
      setError(messageOf(cause));
    } finally {
      setBusy(false);
    }
  };
  const active = entries(props.chapters).filter(
    (x) => x.stage.stage === "RAW" && x.stage.status === "IN_PROGRESS",
  );
  return (
    <section className="page">
      <div className="page-heading">
        <p className="eyebrow">Raw Provider · iniciar produção</p>
        <h2>Raw</h2>
        <p>
          Escolha um capítulo disponível no catálogo. Seu usuário será
          registrado automaticamente.
        </p>
      </div>
      <Panel title="Pegar novo RAW">
        <div className="form-row">
          <label>
            Obra
            <select value={workId} onChange={(e) => setWorkId(e.target.value)}>
              {works.map((work) => (
                <option value={work.id} key={work.id}>
                  {work.title}
                </option>
              ))}
            </select>
          </label>
          <label>
            Capítulo
            <select
              value={catalogId}
              onChange={(e) => setCatalogId(e.target.value)}
              disabled={!catalog.length}
            >
              {catalog.length ? (
                catalog.map((item) => (
                  <option value={item.id} key={item.id}>
                    #{item.number}
                  </option>
                ))
              ) : (
                <option>Nenhum disponível</option>
              )}
            </select>
          </label>
          <button
            className="primary"
            disabled={!catalogId || busy}
            onClick={() => void start()}
          >
            {busy ? "Assumindo…" : "Pegar RAW"}
          </button>
        </div>
        {error && <small className="error">{error}</small>}
      </Panel>
      <Panel title="Em andamento">
        {active.length ? (
          active.map((x) => <Task key={x.stage.id} {...x} {...props} />)
        ) : (
          <Empty text="Nenhum RAW em andamento." />
        )}
      </Panel>
    </section>
  );
}
function Queue({ stage: queueStage, ...props }: PanelProps & { stage: Stage }) {
  const list = entries(props.chapters).filter(
    (x) =>
      x.stage.stage === queueStage &&
      (queueStage === "READY"
        ? x.stage.status === "COMPLETED"
        : x.stage.status !== "WAITING"),
  );
  return (
    <section className="page">
      <h2>
        {queueStage === "READY" ? "Prontos pra upar" : stageLabel[queueStage]}
      </h2>
      <Panel title="Disponíveis e em andamento">
        {list.length ? (
          list.map(({ chapter, stage }) => (
            <Task
              key={stage.id}
              chapter={chapter}
              stage={stage}
              member={props.member}
              refresh={props.refresh}
            />
          ))
        ) : (
          <Empty text="Nenhum capítulo nesta fila." />
        )}
      </Panel>
    </section>
  );
}
function Ready({ chapters }: PanelProps) {
  const ready = chapters.filter((chapter) =>
    chapter.chapter_stages.some(
      (stage) => stage.stage === "READY" && stage.status === "COMPLETED",
    ),
  );
  const [files, setFiles] = useState<Artifact[]>([]);
  const ids = ready.map((chapter) => chapter.id);
  useEffect(() => {
    if (!ids.length) {
      setFiles([]);
      return;
    }
    void supabase
      ?.from("artifacts")
      .select(
        "id,chapter_id,stage,provider,provider_key,original_name,mime_type,byte_size,version,note,is_current,upload_status,created_at",
      )
      .in("chapter_id", ids)
      .eq("stage", "TYPESET")
      .eq("is_current", true)
      .eq("upload_status", "AVAILABLE")
      .then(({ data }) => setFiles((data ?? []) as Artifact[]));
  }, [chapters]);
  return (
    <section className="page">
      <div className="page-heading">
        <p className="eyebrow">PUBLICAÇÃO</p>
        <h2>Prontos pra upar</h2>
        <p>Capítulos aprovados pelo QC e seus arquivos finais.</p>
      </div>
      <Panel title="Aprovados">
        {ready.length ? (
          ready.map((chapter) => {
            const file = files.find((item) => item.chapter_id === chapter.id);
            const approved = chapter.chapter_stages.find(
              (stage) => stage.stage === "READY",
            )?.completed_at;
            return (
              <article className="artifact" key={chapter.id}>
                <div>
                  <strong>
                    {chapter.work?.title} #{chapter.number}
                  </strong>
                  <small>
                    {file
                      ? `Type v${file.version}`
                      : "Arquivo final carregando"}
                    {approved ? ` · ${formatDate(approved)}` : ""}
                  </small>
                </div>
                <div className="task-actions">
                  {file && (
                    <button
                      className="secondary"
                      onClick={() =>
                        void downloadArtifact(file.provider, file.provider_key)
                      }
                    >
                      Baixar
                    </button>
                  )}
                  <Link className="primary" to={`/chapters/${chapter.id}`}>
                    Créditos e histórico
                  </Link>
                </div>
              </article>
            );
          })
        ) : (
          <Empty text="Nenhum capítulo aguardando publicação." />
        )}
      </Panel>
    </section>
  );
}
function Task({
  chapter,
  stage,
  member,
  refresh,
}: Entry & Pick<PanelProps, "member" | "refresh">) {
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const role =
    stage.stage === "READY"
      ? "ADMIN"
      : stageRole[stage.stage as keyof typeof stageRole];
  const claim =
    stage.status === "AVAILABLE" &&
    (member.is_admin || member.roles.includes(role as Role));
  const release =
    stage.status === "IN_PROGRESS" &&
    (member.is_admin || stage.assigned_to === member.user_id);
  const run = async (kind: "claim" | "release") => {
    if (busy) return;
    setBusy(true);
    try {
      if (kind === "claim") await claimStage(stage.id);
      else await releaseStage(stage.id);
      refresh();
    } catch (cause) {
      setError(messageOf(cause));
    } finally {
      setBusy(false);
    }
  };
  return (
    <article className="task">
      <div>
        <Link to={`/chapters/${chapter.id}`}>
          <strong>
            {chapter.work?.title} #{chapter.number}
          </strong>
        </Link>
        <span>
          {stageLabel[stage.stage]} · {statusLabel(stage.status)}
        </span>
        {stage.assignee && (
          <span>
            Responsável:{" "}
            {stage.assignee.display_name || stage.assignee.github_login}
          </span>
        )}
      </div>
      <div className="task-actions">
        {claim && (
          <button
            className="primary"
            disabled={busy}
            onClick={() => void run("claim")}
          >
            {busy ? "Assumindo…" : "Assumir tarefa"}
          </button>
        )}
        {release && (
          <button
            className="secondary"
            disabled={busy}
            onClick={() => void run("release")}
          >
            {busy ? "Liberando…" : "Liberar tarefa"}
          </button>
        )}
        <Link className="secondary" to={`/chapters/${chapter.id}`}>
          Abrir
        </Link>
      </div>
      {error && <small className="error">{error}</small>}
    </article>
  );
}

type WorkRow = {
  id: string;
  title: string;
  aliases: string[];
  status: "ACTIVE" | "PAUSED" | "COMPLETED";
  synopsis: string;
  cover_path: string | null;
  catalog: { status: string }[];
};
function Works({ member }: PanelProps) {
  const [works, setWorks] = useState<WorkRow[]>([]);
  const [title, setTitle] = useState("");
  const [synopsis, setSynopsis] = useState("");
  const [aliases, setAliases] = useState("");
  const [error, setError] = useState("");
  const load = () =>
    void supabase
      ?.from("works")
      .select(
        "id,title,aliases,status,synopsis,cover_path,catalog:work_chapter_catalog(status)",
      )
      .order("title")
      .then(({ data, error }) => {
        if (error) setError(error.message);
        else setWorks((data ?? []) as unknown as WorkRow[]);
      });
  useEffect(load, []);
  const create = async () => {
    if (!supabase || !title.trim()) return;
    const { error } = await supabase.from("works").insert({
      title: title.trim(),
      synopsis,
      aliases: aliases
        .split(",")
        .map((value) => value.trim())
        .filter(Boolean),
    });
    if (error) setError(error.message);
    else {
      setTitle("");
      setSynopsis("");
      setAliases("");
      load();
    }
  };
  return (
    <section className="page">
      <div className="page-heading">
        <p className="eyebrow">BIBLIOTECA</p>
        <h2>Obras</h2>
        <p>Catálogo editorial separado dos workflows de produção.</p>
      </div>
      {member.is_admin && (
        <details className="create-box">
          <summary>＋ Nova obra</summary>
          <div>
            <input
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="Título"
            />
            <textarea
              value={synopsis}
              onChange={(e) => setSynopsis(e.target.value)}
              placeholder="Sinopse"
            />
            <input
              value={aliases}
              onChange={(e) => setAliases(e.target.value)}
              placeholder="Aliases separados por vírgula"
            />
            <button className="primary" onClick={() => void create()}>
              Criar obra
            </button>
          </div>
        </details>
      )}
      <section className="works-grid">
        {works.map((work) => {
          const total = work.catalog?.length ?? 0;
          const done =
            work.catalog?.filter((item) => item.status === "COMPLETED")
              .length ?? 0;
          const production =
            work.catalog?.filter((item) => item.status === "IN_PRODUCTION")
              .length ?? 0;
          return (
            <article className="work-card" key={work.id}>
              <Cover path={work.cover_path} title={work.title} />
              <div className="work-card-body">
                <span className="badge">{labelWork(work.status)}</span>
                <h3>{work.title}</h3>
                {work.aliases.length > 0 && (
                  <small>{work.aliases.join(" · ")}</small>
                )}
                <p>{work.synopsis || "Sem sinopse cadastrada."}</p>
                <div className="work-metrics">
                  <span>
                    <b>{total}</b>Total
                  </span>
                  <span>
                    <b>{done}</b>Concluídos
                  </span>
                  <span>
                    <b>{production}</b>Produção
                  </span>
                  <span>
                    <b>{total - done - production}</b>A fazer
                  </span>
                </div>
                <Link className="secondary" to={`/works/${work.id}`}>
                  Abrir catálogo →
                </Link>
              </div>
            </article>
          );
        })}
      </section>
      {!works.length && <Empty text={error || "Nenhuma obra cadastrada."} />}
    </section>
  );
}
function Work({ member }: PanelProps) {
  const { id } = useParams();
  const [work, setWork] = useState<WorkRow | null>(null);
  const [catalog, setCatalog] = useState<
    {
      id: string;
      number: number;
      status: "TODO" | "IN_PRODUCTION" | "COMPLETED";
    }[]
  >([]);
  const [filter, setFilter] = useState("ALL");
  const [start, setStart] = useState("1");
  const [end, setEnd] = useState("");
  const [status, setStatus] = useState("TODO");
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const load = () => {
    void supabase
      ?.from("works")
      .select("id,title,aliases,status,synopsis,cover_path")
      .eq("id", id)
      .maybeSingle()
      .then(({ data }) => setWork(data as WorkRow | null));
    void supabase
      ?.from("work_chapter_catalog")
      .select("id,number,status")
      .eq("work_id", id)
      .order("number")
      .then(({ data }) => setCatalog((data ?? []) as typeof catalog));
  };
  useEffect(load, [id]);
  const range = async (applyStatus = false) => {
    if (!id || !supabase || busy) return;
    setBusy(true);
    const rpc = applyStatus
      ? "set_catalog_chapter_status_range"
      : "add_catalog_chapter_range";
    const args = applyStatus
      ? {
          p_work_id: id,
          p_start: Number(start),
          p_end: Number(end || start),
          p_status: status,
        }
      : { p_work_id: id, p_start: Number(start), p_end: Number(end || start) };
    const { data, error } = await supabase.rpc(rpc, args);
    setBusy(false);
    setMessage(
      error
        ? messageOf(error)
        : applyStatus
          ? `${data} capítulos atualizados.`
          : `${data?.[0]?.added ?? 0} adicionados; ${data?.[0]?.existing ?? 0} já existentes.`,
    );
    load();
  };
  const cover = async (file?: File) => {
    if (
      !file ||
      !work ||
      !["image/jpeg", "image/png", "image/webp"].includes(file.type)
    ) {
      setMessage("Selecione JPG, PNG ou WEBP.");
      return;
    }
    setBusy(true);
    const ext =
      file.type === "image/png"
        ? "png"
        : file.type === "image/webp"
          ? "webp"
          : "jpg";
    const path = `${work.id}/${crypto.randomUUID()}.${ext}`;
    const { error: uploadError } = await supabase!.storage
      .from("work-covers")
      .upload(path, file, { contentType: file.type });
    if (!uploadError) {
      const { error } = await supabase!
        .from("works")
        .update({ cover_path: path })
        .eq("id", work.id);
      setMessage(error ? messageOf(error) : "Capa atualizada.");
      load();
    } else setMessage(messageOf(uploadError));
    setBusy(false);
  };
  const removeCover = async () => {
    if (!work?.cover_path) return;
    setBusy(true);
    const old = work.cover_path;
    const { error } = await supabase!
      .from("works")
      .update({ cover_path: null })
      .eq("id", work.id);
    if (!error) {
      await supabase!.storage.from("work-covers").remove([old]);
      load();
    }
    setMessage(error ? messageOf(error) : "Capa removida.");
    setBusy(false);
  };
  const visible = catalog.filter(
    (item) => filter === "ALL" || item.status === filter,
  );
  const counts = {
    total: catalog.length,
    done: catalog.filter((x) => x.status === "COMPLETED").length,
    production: catalog.filter((x) => x.status === "IN_PRODUCTION").length,
  };
  return (
    <section className="page">
      <div className="page-heading">
        <p className="eyebrow">CATÁLOGO</p>
        <h2>{work?.title || "Obra"}</h2>
        <p>{work?.synopsis}</p>
      </div>
      {work && (
        <div className="stats">
          <span>
            <b>{counts.total}</b>Total
          </span>
          <span>
            <b>{counts.done}</b>Concluídos
          </span>
          <span>
            <b>{counts.production}</b>Em produção
          </span>
          <span>
            <b>{counts.total - counts.done - counts.production}</b>A fazer
          </span>
        </div>
      )}
      {member.is_admin && <WorkDetailsEditor work={work} onSaved={load} />}
      {member.is_admin && (
        <Panel title="Administrar catálogo">
          <div className="form-row">
            <label>
              De
              <input
                type="number"
                min="1"
                value={start}
                onChange={(e) => setStart(e.target.value)}
              />
            </label>
            <label>
              Até
              <input
                type="number"
                min="1"
                value={end}
                onChange={(e) => setEnd(e.target.value)}
              />
            </label>
            <label>
              Status
              <select
                value={status}
                onChange={(e) => setStatus(e.target.value)}
              >
                <option value="TODO">A fazer</option>
                <option value="COMPLETED">Concluído</option>
              </select>
            </label>
            <button
              className="primary"
              disabled={busy}
              onClick={() => void range()}
            >
              Adicionar intervalo
            </button>
            <button
              className="secondary"
              disabled={busy}
              onClick={() => void range(true)}
            >
              Aplicar status
            </button>
          </div>
          <div className="cover-controls">
            <label className="secondary">
              Trocar capa
              <input
                hidden
                type="file"
                accept=".jpg,.jpeg,.png,.webp,image/jpeg,image/png,image/webp"
                onChange={(e) => void cover(e.target.files?.[0])}
              />
            </label>
            {work?.cover_path && (
              <button
                className="danger-text"
                onClick={() => void removeCover()}
              >
                Remover capa
              </button>
            )}
          </div>
          {message && <small>{message}</small>}
        </Panel>
      )}
      <div className="filters">
        <button
          className={filter === "ALL" ? "active" : ""}
          onClick={() => setFilter("ALL")}
        >
          Todos
        </button>
        <button
          className={filter === "COMPLETED" ? "active" : ""}
          onClick={() => setFilter("COMPLETED")}
        >
          Concluídos
        </button>
        <button
          className={filter === "IN_PRODUCTION" ? "active" : ""}
          onClick={() => setFilter("IN_PRODUCTION")}
        >
          Em produção
        </button>
        <button
          className={filter === "TODO" ? "active" : ""}
          onClick={() => setFilter("TODO")}
        >
          A fazer
        </button>
      </div>
      <section className="catalog-grid">
        {visible.map((item) => (
          <button
            key={item.id}
            className={`catalog-chip ${item.status.toLowerCase()}`}
            disabled={!member.is_admin}
            onClick={() => {
              if (member.is_admin) {
                setStart(String(item.number));
                setEnd(String(item.number));
              }
            }}
          >
            <b>#{item.number}</b>
            <span>{statusLabel(item.status)}</span>
          </button>
        ))}
      </section>
    </section>
  );
}
function WorkDetailsEditor({
  work,
  onSaved,
}: {
  work: WorkRow | null;
  onSaved: () => void;
}) {
  const [title, setTitle] = useState(work?.title ?? "");
  const [synopsis, setSynopsis] = useState(work?.synopsis ?? "");
  const [aliases, setAliases] = useState((work?.aliases ?? []).join(", "));
  const [status, setStatus] = useState(work?.status ?? "ACTIVE");
  const [busy, setBusy] = useState(false);
  if (!work) return null;
  const save = async () => {
    setBusy(true);
    const { error } = await supabase!
      .from("works")
      .update({
        title: title.trim(),
        synopsis: synopsis.trim(),
        aliases: aliases
          .split(",")
          .map((value) => value.trim())
          .filter(Boolean),
        status,
      })
      .eq("id", work.id);
    setBusy(false);
    if (!error) onSaved();
  };
  return (
    <Panel title="Dados da obra">
      <div className="form-row">
        <label>
          Título
          <input value={title} onChange={(e) => setTitle(e.target.value)} />
        </label>
        <label>
          Aliases
          <input value={aliases} onChange={(e) => setAliases(e.target.value)} />
        </label>
        <label>
          Status
          <select
            value={status}
            onChange={(e) => setStatus(e.target.value as WorkRow["status"])}
          >
            <option value="ACTIVE">Ativa</option>
            <option value="PAUSED">Pausada</option>
            <option value="COMPLETED">Concluída</option>
          </select>
        </label>
      </div>
      <label>
        Sinopse
        <textarea
          value={synopsis}
          onChange={(e) => setSynopsis(e.target.value)}
        />
      </label>
      <button
        className="primary"
        disabled={busy || !title.trim()}
        onClick={() => void save()}
      >
        {busy ? "Salvando…" : "Salvar dados"}
      </button>
    </Panel>
  );
}
type CommentItem = {
  id: string;
  body: string;
  stage: Stage | null;
  created_at: string;
  author: {
    display_name: string | null;
    github_login: string;
    avatar_url: string | null;
  } | null;
};
type CreditItem = {
  id: string;
  stage: Stage;
  completed_at: string;
  user: { display_name: string | null; github_login: string } | null;
};
type ActivityItem = {
  id: number;
  action: string;
  stage: Stage | null;
  created_at: string;
  metadata: Record<string, string>;
  actor: { display_name: string | null; github_login: string } | null;
};
function Chapter({ member, refresh, chapters }: PanelProps) {
  const { id } = useParams();
  const [chapter, setChapter] = useState<Chapter | null>(null);
  const [artifacts, setArtifacts] = useState<Artifact[]>([]);
  const [comments, setComments] = useState<CommentItem[]>([]);
  const [credits, setCredits] = useState<CreditItem[]>([]);
  const [activity, setActivity] = useState<ActivityItem[]>([]);
  const [body, setBody] = useState("");
  const [files, setFiles] = useState<Record<string, File | undefined>>({});
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [reason, setReason] = useState("");
  const [returnStage, setReturnStage] = useState<Stage>("TYPESET");
  const load = async () => {
    if (!id || !supabase) return;
    const [c, a, co, cr, ac] = await Promise.all([
      supabase
        .from("chapters")
        .select(
          "id,number,title,work:works(id,title),chapter_stages(id,chapter_id,stage,status,assigned_to,assigned_at,completed_at,rejection_reason,assignee:profiles!chapter_stages_assigned_to_fkey(display_name,github_login,avatar_url))",
        )
        .eq("id", id)
        .maybeSingle(),
      supabase
        .from("artifacts")
        .select(
          "id,chapter_id,stage,provider,provider_key,original_name,mime_type,byte_size,version,note,is_current,upload_status,created_at,uploader:profiles!artifacts_uploaded_by_fkey(display_name,github_login,avatar_url)",
        )
        .eq("chapter_id", id)
        .eq("upload_status", "AVAILABLE")
        .order("created_at", { ascending: false }),
      supabase
        .from("comments")
        .select(
          "id,body,stage,created_at,author:profiles!comments_author_id_fkey(display_name,github_login,avatar_url)",
        )
        .eq("chapter_id", id)
        .order("created_at"),
      supabase
        .from("stage_completions")
        .select(
          "id,stage,completed_at,user:profiles!stage_completions_user_id_fkey(display_name,github_login)",
        )
        .eq("chapter_id", id)
        .order("completed_at"),
      supabase
        .from("activity_log")
        .select(
          "id,action,stage,created_at,metadata,actor:profiles!activity_log_actor_id_fkey(display_name,github_login)",
        )
        .eq("chapter_id", id)
        .order("created_at", { ascending: false })
        .limit(100),
    ]);
    const failed = c.error || a.error || co.error || cr.error || ac.error;
    setError(failed ? failed.message : "");
    setChapter(c.data as unknown as Chapter);
    setArtifacts((a.data ?? []) as unknown as Artifact[]);
    setComments((co.data ?? []) as unknown as CommentItem[]);
    setCredits((cr.data ?? []) as unknown as CreditItem[]);
    setActivity((ac.data ?? []) as unknown as ActivityItem[]);
  };
  useEffect(() => {
    void load();
  }, [id, chapters]);
  const run = async (key: string, action: () => Promise<unknown>) => {
    if (busy) return;
    setBusy(key);
    setError("");
    try {
      await action();
      await load();
      refresh();
    } catch (cause) {
      setError(messageOf(cause));
    } finally {
      setBusy("");
    }
  };
  if (!chapter)
    return (
      <section className="page">
        <h2>Carregando capítulo…</h2>
        {error && <small className="error">{error}</small>}
      </section>
    );
  const review = chapter.chapter_stages.find((item) => item.stage === "REVIEW");
  return (
    <section className="page">
      <div className="page-heading">
        <p className="eyebrow">CENTRAL DO CAPÍTULO</p>
        <h2>
          {chapter.work?.title} #{chapter.number}
        </h2>
        <p>Workflow, arquivos, créditos e histórico em um só lugar.</p>
      </div>
      {error && <p className="error">{error}</p>}
      <div className="chapter-layout">
        <div>
          <Panel title="Workflow">
            <div className="workflow">
              {chapter.chapter_stages.map((stage) => {
                const role =
                  stage.stage === "READY"
                    ? "ADMIN"
                    : stageRole[stage.stage as keyof typeof stageRole];
                const mayClaim =
                  stage.status === "AVAILABLE" && allowed(member, role as Role);
                const owns =
                  stage.assigned_to === member.user_id || member.is_admin;
                const mayWork =
                  owns &&
                  stage.status === "IN_PROGRESS" &&
                  !["REVIEW", "READY"].includes(stage.stage);
                const current = artifacts.find(
                  (a) => a.stage === stage.stage && a.is_current,
                );
                const dependencies =
                  stage.stage === "TYPESET"
                    ? artifacts.filter(
                        (a) =>
                          a.is_current &&
                          ["CLEAN_REDRAW", "TRANSLATION"].includes(a.stage),
                      )
                    : [];
                return (
                  <article
                    className={`stage-step ${stage.status.toLowerCase()}`}
                    key={stage.id}
                  >
                    <b>
                      {stage.status === "COMPLETED"
                        ? "✓"
                        : stageLabel[stage.stage][0]}
                    </b>
                    <div>
                      <strong>{stageLabel[stage.stage]}</strong>
                      <span>{statusLabel(stage.status)}</span>
                      {stage.assignee && (
                        <small>
                          {stage.assignee.display_name ||
                            stage.assignee.github_login}
                        </small>
                      )}
                      {stage.rejection_reason && (
                        <small className="error">
                          Motivo: {stage.rejection_reason}
                        </small>
                      )}
                      {dependencies.length > 0 && (
                        <div className="stage-actions">
                          {dependencies.map((file) => (
                            <button
                              className="secondary"
                              key={file.id}
                              onClick={() =>
                                void run(`download-${file.id}`, () =>
                                  downloadArtifact(
                                    file.provider,
                                    file.provider_key,
                                  ),
                                )
                              }
                            >
                              {stageLabel[file.stage]} mais recente · Baixar
                            </button>
                          ))}
                        </div>
                      )}
                      {mayClaim && (
                        <button
                          className="primary"
                          disabled={!!busy}
                          onClick={() =>
                            void run(`claim-${stage.id}`, () =>
                              claimStage(stage.id),
                            )
                          }
                        >
                          Assumir
                        </button>
                      )}
                      {mayWork && (
                        <div className="stage-actions">
                          <input
                            type="file"
                            onChange={(event) =>
                              setFiles({
                                ...files,
                                [stage.id]: event.target.files?.[0],
                              })
                            }
                          />
                          <button
                            className="secondary"
                            disabled={!files[stage.id] || !!busy}
                            onClick={() =>
                              void run(`upload-${stage.id}`, () =>
                                uploadArtifact({
                                  chapterId: chapter.id,
                                  stage: stage.stage,
                                  file: files[stage.id]!,
                                }),
                              )
                            }
                          >
                            {busy === `upload-${stage.id}`
                              ? "Enviando…"
                              : "Enviar versão"}
                          </button>
                          <button
                            className="primary"
                            disabled={!current || !!busy}
                            onClick={() =>
                              void run(`complete-${stage.id}`, () =>
                                completeStage(stage.id),
                              )
                            }
                          >
                            {busy === `complete-${stage.id}`
                              ? "Concluindo…"
                              : "Concluir"}
                          </button>
                        </div>
                      )}
                    </div>
                  </article>
                );
              })}
            </div>
          </Panel>
          {review?.status === "IN_PROGRESS" &&
            (review.assigned_to === member.user_id || member.is_admin) && (
              <Panel title="Decisão do QC">
                <div className="review-form">
                  <button
                    className="primary"
                    disabled={!!busy}
                    onClick={() =>
                      void run("approve", () => reviewChapter(review.id, true))
                    }
                  >
                    Aprovar capítulo
                  </button>
                  <label>
                    Retornar para
                    <select
                      value={returnStage}
                      onChange={(event) =>
                        setReturnStage(event.target.value as Stage)
                      }
                    >
                      <option value="TYPESET">Type</option>
                      <option value="TRANSLATION">Tradução</option>
                      <option value="CLEAN_REDRAW">Clean / Redraw</option>
                    </select>
                  </label>
                  <label>
                    Motivo obrigatório
                    <textarea
                      value={reason}
                      onChange={(event) => setReason(event.target.value)}
                    />
                  </label>
                  <button
                    className="danger"
                    disabled={!reason.trim() || !!busy}
                    onClick={() =>
                      void run("reject", () =>
                        reviewChapter(review.id, false, reason, returnStage),
                      )
                    }
                  >
                    Reprovar
                  </button>
                </div>
              </Panel>
            )}
          <Panel title="Arquivos e versões">
            {artifacts.length ? (
              artifacts.map((file) => (
                <article className="artifact" key={file.id}>
                  <div>
                    <strong>
                      {stageLabel[file.stage]} v{file.version}
                    </strong>
                    {file.is_current && <span className="badge">Atual</span>}
                    <small>
                      {file.original_name} · {formatBytes(file.byte_size)}
                    </small>
                  </div>
                  <button
                    className="secondary"
                    disabled={!!busy}
                    onClick={() =>
                      void run(`download-${file.id}`, () =>
                        downloadArtifact(file.provider, file.provider_key),
                      )
                    }
                  >
                    Baixar
                  </button>
                </article>
              ))
            ) : (
              <Empty text="Nenhum arquivo enviado." />
            )}
          </Panel>
          <Panel title="Comentários">
            <div className="comment-form">
              <textarea
                placeholder="Observação interna…"
                value={body}
                onChange={(event) => setBody(event.target.value)}
              />
              <button
                className="primary"
                disabled={!body.trim() || !!busy}
                onClick={() =>
                  void run("comment", async () => {
                    await addComment(chapter.id, body.trim());
                    setBody("");
                  })
                }
              >
                Comentar
              </button>
            </div>
            {comments.map((comment) => (
              <article className="comment" key={comment.id}>
                <span className="avatar">
                  {
                    (comment.author?.display_name ||
                      comment.author?.github_login ||
                      "?")[0]
                  }
                </span>
                <div>
                  <strong>
                    {comment.author?.display_name ||
                      comment.author?.github_login}
                  </strong>
                  <small>
                    {comment.stage ? stageLabel[comment.stage] : "Geral"} ·{" "}
                    {formatDate(comment.created_at)}
                  </small>
                  <p>{comment.body}</p>
                </div>
              </article>
            ))}
          </Panel>
        </div>
        <aside className="chapter-aside">
          <Panel title="Créditos">
            {credits.length ? (
              credits.map((credit) => (
                <div className="credit" key={credit.id}>
                  <span>{stageLabel[credit.stage]}</span>
                  <strong>
                    {credit.user?.display_name || credit.user?.github_login}
                  </strong>
                </div>
              ))
            ) : (
              <Empty text="Os créditos aparecem ao concluir cada etapa." />
            )}
          </Panel>
          <Panel title="Histórico">
            {activity.length ? (
              activity.map((item) => (
                <div className="activity" key={item.id}>
                  <i />
                  <p>
                    <strong>
                      {item.actor?.display_name ||
                        item.actor?.github_login ||
                        "Sistema"}
                    </strong>{" "}
                    {activityText(item)}
                    <small>{formatDate(item.created_at)}</small>
                  </p>
                </div>
              ))
            ) : (
              <Empty text="Nenhuma atividade ainda." />
            )}
          </Panel>
        </aside>
      </div>
    </section>
  );
}
function Notifications({ refresh, notifications }: PanelProps) {
  const [items, setItems] = useState<
    {
      id: string;
      body: string;
      link_path: string | null;
      read_at: string | null;
    }[]
  >([]);
  const nav = useNavigate();
  const load = () =>
    void supabase
      ?.from("notifications")
      .select("id,body,link_path,read_at")
      .order("created_at", { ascending: false })
      .then(({ data }) => setItems(data ?? []));
  useEffect(load, [notifications]);
  const open = async (item: (typeof items)[number]) => {
    if (!item.read_at) await markNotificationRead(item.id);
    refresh();
    load();
    nav((item.link_path || "/notifications").replace(/^#/, ""));
  };
  return (
    <section className="page">
      <h2>Notificações</h2>
      <button
        className="secondary"
        onClick={() => void markAllNotificationsRead().then(load)}
      >
        Marcar todas como lidas
      </button>
      <Panel title="Todas">
        {items.map((item) => (
          <button
            className="notification"
            key={item.id}
            onClick={() => void open(item)}
          >
            {item.body}
          </button>
        ))}
        {!items.length && <Empty text="Nenhuma notificação." />}
      </Panel>
    </section>
  );
}
const staffRoles: { code: Role; label: string }[] = [
  { code: "RAW_PROVIDER", label: "Raw Provider" },
  { code: "CLEAN_REDRAW", label: "Clean / Redraw" },
  { code: "TRANSLATOR", label: "Tradutor" },
  { code: "TYPESETTER", label: "Typesetter" },
  { code: "REVIEWER_QC", label: "Revisor / QC" },
];
type MemberItem = {
  user_id: string;
  github_login: string;
  display_name: string | null;
  is_active: boolean;
  is_admin: boolean;
  user_roles: { role_code: Role }[];
};
type InviteItem = { github_login: string; roles: Role[]; is_admin: boolean };
function Members() {
  const [members, setMembers] = useState<MemberItem[]>([]);
  const [invites, setInvites] = useState<InviteItem[]>([]);
  const [login, setLogin] = useState("");
  const [roles, setRoles] = useState<Role[]>([]);
  const [admin, setAdmin] = useState(false);
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const load = async () => {
    const [memberResult, inviteResult] = await Promise.all([
      supabase!
        .from("staff_members")
        .select(
          "user_id,github_login,display_name,is_active,is_admin,user_roles(role_code)",
        )
        .order("github_login"),
      supabase!
        .from("staff_invites")
        .select("github_login,roles,is_admin")
        .order("created_at", { ascending: false }),
    ]);
    setMembers((memberResult.data ?? []) as MemberItem[]);
    setInvites((inviteResult.data ?? []) as InviteItem[]);
    setError(
      memberResult.error || inviteResult.error
        ? messageOf(memberResult.error || inviteResult.error)
        : "",
    );
  };
  useEffect(() => {
    void load();
  }, []);
  const selectRole = (role: Role) =>
    setRoles((current) =>
      current.includes(role)
        ? current.filter((item) => item !== role)
        : [...current, role],
    );
  const invite = async () => {
    const clean = login.trim().replace(/^@/, "").toLowerCase();
    if (!clean || busy) return;
    setBusy("invite");
    const { error } = await supabase!
      .from("staff_invites")
      .upsert({ github_login: clean, roles, is_admin: admin });
    setBusy("");
    if (error) setError(messageOf(error));
    else {
      setLogin("");
      setRoles([]);
      setAdmin(false);
      await load();
    }
  };
  const toggle = async (item: MemberItem) => {
    setBusy(item.user_id);
    const { error } = await supabase!
      .from("staff_members")
      .update({ is_active: !item.is_active })
      .eq("user_id", item.user_id);
    setBusy("");
    if (error) setError(messageOf(error));
    else await load();
  };
  const toggleAdmin = async (item: MemberItem) => {
    setBusy(item.user_id);
    const { error } = await supabase!
      .from("staff_members")
      .update({ is_admin: !item.is_admin })
      .eq("user_id", item.user_id);
    setBusy("");
    if (error) setError(messageOf(error));
    else await load();
  };
  const memberRole = async (item: MemberItem, role: Role) => {
    setBusy(item.user_id);
    const has = item.user_roles.some((value) => value.role_code === role);
    const request = has
      ? supabase!
          .from("user_roles")
          .delete()
          .eq("user_id", item.user_id)
          .eq("role_code", role)
      : supabase!
          .from("user_roles")
          .insert({ user_id: item.user_id, role_code: role });
    const { error } = await request;
    setBusy("");
    if (error) setError(messageOf(error));
    else await load();
  };
  return (
    <section className="page">
      <div className="page-heading">
        <p className="eyebrow">ADMINISTRAÇÃO</p>
        <h2>Membros</h2>
        <p>Convites, cargos e acesso da staff.</p>
      </div>
      {error && <p className="error">{error}</p>}
      <Panel title="Pré-autorizar GitHub">
        <div className="invite-form">
          <input
            value={login}
            onChange={(e) => setLogin(e.target.value)}
            placeholder="@github-login"
          />
          <div className="role-picker">
            {staffRoles.map((role) => (
              <label key={role.code}>
                <input
                  type="checkbox"
                  checked={roles.includes(role.code)}
                  onChange={() => selectRole(role.code)}
                />
                {role.label}
              </label>
            ))}
            <label>
              <input
                type="checkbox"
                checked={admin}
                onChange={(event) => setAdmin(event.target.checked)}
              />
              Administrador
            </label>
          </div>
          <button
            className="primary"
            disabled={!login.trim() || !!busy}
            onClick={() => void invite()}
          >
            {busy === "invite" ? "Salvando…" : "Criar convite"}
          </button>
        </div>
      </Panel>
      {invites.length > 0 && (
        <Panel title="Convites pendentes">
          {invites.map((item) => (
            <article className="member-row" key={item.github_login}>
              <div>
                <strong>@{item.github_login}</strong>
                <span>
                  {[
                    ...item.roles.map(
                      (role) =>
                        staffRoles.find((value) => value.code === role)?.label,
                    ),
                    ...(item.is_admin ? ["Administrador"] : []),
                  ]
                    .filter(Boolean)
                    .join(" · ") || "Sem cargos"}
                </span>
              </div>
              <button
                className="danger-text"
                onClick={() =>
                  void supabase!
                    .from("staff_invites")
                    .delete()
                    .eq("github_login", item.github_login)
                    .then(() => load())
                }
              >
                Cancelar convite
              </button>
            </article>
          ))}
        </Panel>
      )}
      <Panel title="Membros da staff">
        {members.map((item) => (
          <article
            className={`member-card ${item.is_active ? "" : "inactive"}`}
            key={item.user_id}
          >
            <div className="member-row">
              <div>
                <strong>{item.display_name || item.github_login}</strong>
                <span>
                  @{item.github_login} ·{" "}
                  {item.is_active ? "Ativo" : "Desativado"}
                  {item.is_admin ? " · Administrador" : ""}
                </span>
              </div>
              <div>
                <button
                  className="secondary"
                  disabled={busy === item.user_id}
                  onClick={() => void toggleAdmin(item)}
                >
                  {item.is_admin ? "Remover admin" : "Tornar admin"}
                </button>
                <button
                  className="secondary"
                  disabled={busy === item.user_id}
                  onClick={() => void toggle(item)}
                >
                  {item.is_active ? "Desativar" : "Reativar"}
                </button>
              </div>
            </div>
            <div className="role-picker compact">
              {staffRoles.map((role) => (
                <label key={role.code}>
                  <input
                    type="checkbox"
                    disabled={busy === item.user_id}
                    checked={item.user_roles.some(
                      (value) => value.role_code === role.code,
                    )}
                    onChange={() => void memberRole(item, role.code)}
                  />
                  {role.label}
                </label>
              ))}
            </div>
          </article>
        ))}
      </Panel>
    </section>
  );
}
function Settings() {
  return (
    <section className="page">
      <h2>Configurações</h2>
      <Panel title="Projeto">
        <p>Configurações operacionais do painel.</p>
      </Panel>
    </section>
  );
}
function Panel({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  return (
    <section className="panel">
      <h3>{title}</h3>
      {children}
    </section>
  );
}
function Empty({ text }: { text: string }) {
  return <p className="empty">{text}</p>;
}
function Cover({ path, title }: { path: string | null; title: string }) {
  const [url, setUrl] = useState("");
  useEffect(() => {
    let active = true;
    setUrl("");
    if (path)
      void supabase?.storage
        .from("work-covers")
        .createSignedUrl(path, 900)
        .then(({ data }) => {
          if (active) setUrl(data?.signedUrl ?? "");
        });
    return () => {
      active = false;
    };
  }, [path]);
  return (
    <div className="cover">
      {url ? (
        <img src={url} alt={`Capa de ${title}`} />
      ) : (
        <div className="cover-placeholder">
          <b>N</b>
          <span>PROJECT NOX</span>
        </div>
      )}
    </div>
  );
}
function NotFound() {
  return (
    <section className="page">
      <h2>Página não encontrada.</h2>
    </section>
  );
}
const entries = (chapters: Chapter[]): Entry[] =>
  chapters.flatMap((chapter) =>
    (chapter.chapter_stages ?? []).map((stage) => ({ chapter, stage })),
  );
const labelWork = (value: string) =>
  value === "ACTIVE" ? "Ativa" : value === "PAUSED" ? "Pausada" : "Concluída";
const statusLabel = (value: string) =>
  ({
    TODO: "A fazer",
    IN_PRODUCTION: "Em produção",
    COMPLETED: "Concluído",
    WAITING: "Aguardando",
    AVAILABLE: "Disponível",
    IN_PROGRESS: "Em andamento",
    REJECTED: "Reprovado",
  })[value] || value;
const formatDate = (value: string) =>
  new Intl.DateTimeFormat("pt-BR", {
    dateStyle: "short",
    timeStyle: "short",
  }).format(new Date(value));
const formatBytes = (value: number) =>
  value < 1048576
    ? `${Math.max(1, Math.round(value / 1024))} KB`
    : `${(value / 1048576).toFixed(1)} MB`;
const messageOf = (cause: unknown) => {
  const raw =
    cause instanceof Error
      ? cause.message
      : cause && typeof cause === "object" && "message" in cause
        ? String((cause as { message: unknown }).message)
        : "Erro inesperado.";
  if (/duplicate|unique/i.test(raw))
    return "Este item acabou de ser alterado por outra pessoa.";
  if (/permission|permissão|policy|row-level/i.test(raw))
    return "Você não tem permissão para executar esta ação.";
  if (/último administrador|last admin/i.test(raw))
    return "O último administrador ativo não pode perder acesso.";
  return raw;
};
const activityText = (item: ActivityItem) => {
  const action =
    {
      claimed: "assumiu",
      released: "liberou",
      uploaded: "enviou uma versão em",
      completed: "concluiu",
      approved: "aprovou o capítulo",
      rejected: `reprovou e devolveu para ${item.metadata?.return_stage ? stageLabel[item.metadata.return_stage as Stage] : "correção"}`,
      stage_available: "disponibilizou",
      production_started: "iniciou a produção em",
    }[item.action] || item.action;
  return `${action}${item.stage && !["approved", "rejected"].includes(item.action) ? ` ${stageLabel[item.stage]}` : ""}`;
};
