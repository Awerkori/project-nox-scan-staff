import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
} from "react";
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
  markChapterPublished,
  markNotificationRead,
  releaseStage,
  reviewChapter,
  startCatalogProduction,
  uploadArtifact,
} from "./lib/production";
import { supabase } from "./lib/supabase";
import { fetchChapters } from "./lib/chapters";
import { SimpleWorkCatalog } from "./WorkCatalog";
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
  error?: string;
  publicationAvailable?: boolean;
  refresh: () => void | Promise<void>;
  logout: () => void;
};
type Entry = { chapter: Chapter; stage: ChapterStage };
const NoticeContext = createContext<(message: string) => void>(() => undefined);
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
      ["✅", "Pra upar", "/ready"],
      ["📦", "Upados", "/published"],
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
const stagePath = (stage: Stage) =>
  stage === "READY"
    ? "/ready"
    : `/${Object.keys(routeRole).find((path) => routeRole[path] === stageRole[stage])}`;

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
        <Route
          path="published"
          element={
            <RoleGate {...props} role="ADMIN">
              <Published {...props} />
            </RoleGate>
          }
        />
        <Route path="works" element={<Works {...props} />} />
        <Route
          path="works/:id"
          element={<SimpleWorkCatalog member={props.member} />}
        />
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

function Shell({ member, notifications, toast, error, logout }: PanelProps) {
  const navigate = useNavigate();
  const [menuOpen, setMenuOpen] = useState(false);
  const [notice, setNotice] = useState("");
  useEffect(() => {
    if (!notice) return;
    const timer = window.setTimeout(() => setNotice(""), 5000);
    return () => window.clearTimeout(timer);
  }, [notice]);
  return (
    <NoticeContext.Provider value={setNotice}>
      <div className="app">
        <button
          className="mobile-menu secondary"
          aria-expanded={menuOpen}
          aria-controls="staff-navigation"
          onClick={() => setMenuOpen(!menuOpen)}
        >
          {menuOpen ? "Fechar menu ×" : "☰ Menu · Project Nox"}
        </button>
        <aside
          id="staff-navigation"
          className={`sidebar${menuOpen ? " open" : ""}`}
        >
          <div className="brand">
            <b>N</b>
            <h1>
              Project Nox <small>Scan Staff</small>
            </h1>
          </div>
          <nav onClick={() => setMenuOpen(false)}>
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
                      <span aria-hidden="true">{icon}</span>
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
          {toast || notice ? (
            <div className="toast" role="status">
              {toast || notice}
            </div>
          ) : null}
          {error && <Feedback kind="error">{error}</Feedback>}
          <Outlet />
        </main>
      </div>
    </NoticeContext.Provider>
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
  const ongoing = props.chapters.filter(
    (chapter) =>
      !chapter.published_at &&
      !chapter.chapter_stages.some(
        (stage) => stage.stage === "READY" && stage.status === "COMPLETED",
      ),
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
            mine.map(({ chapter, stage }) => (
              <Link
                className="home-task"
                key={stage.id}
                to={stagePath(stage.stage)}
              >
                <div>
                  <strong>
                    {chapter.work?.title} #{chapter.number}
                  </strong>
                  <small>{stageLabel[stage.stage]}</small>
                </div>
                <span>Continuar →</span>
              </Link>
            ))
          ) : (
            <Empty text="Você está em dia. Nenhuma tarefa atribuída." />
          )}
        </Panel>
        <Panel title="Filas de produção">
          {Object.entries(routeRole)
            .filter(([, role]) => allowed(props.member, role))
            .map(([path]) => {
              const stage = (
                Object.keys(stageRole) as Exclude<Stage, "READY">[]
              ).find((stage) => stageRole[stage] === routeRole[path])!;
              const count = available.filter(
                (item) => item.stage.stage === stage,
              ).length;
              return (
                <Link className="home-task" key={path} to={`/${path}`}>
                  <strong>{stageLabel[stage]}</strong>
                  <span>
                    {stage === "RAW"
                      ? "Escolher capítulo →"
                      : `${count} ${count === 1 ? "disponível" : "disponíveis"} →`}
                  </span>
                </Link>
              );
            })}
        </Panel>
        <Panel title="Capítulos em andamento">
          {ongoing.length ? (
            ongoing.slice(0, 8).map((chapter) => (
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
            <Empty text="Nenhum capítulo em produção agora." />
          )}
        </Panel>
      </section>
    </section>
  );
}
function RawQueue(props: PanelProps) {
  const [works, setWorks] = useState<{ id: string; title: string }[]>([]);
  const [workId, setWorkId] = useState("");
  const [catalog, setCatalog] = useState<{ id: string; number: number }[]>([]);
  const [catalogId, setCatalogId] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [success, setSuccess] = useState("");
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
    let active = true;
    setCatalogId("");
    setCatalog([]);
    if (!workId) return;
    void supabase
      ?.from("work_chapter_catalog")
      .select("id,number")
      .eq("work_id", workId)
      .eq("status", "TODO")
      .order("number")
      .limit(500)
      .then(({ data, error }) => {
        if (!active) return;
        setCatalog(data ?? []);
        setCatalogId(data?.[0]?.id ?? "");
        setError(error?.message ?? "");
      });
    return () => {
      active = false;
    };
  }, [workId, props.chapters]);
  const start = async () => {
    if (!catalogId || busy) return;
    setBusy(true);
    setError("");
    setSuccess("");
    try {
      await startCatalogProduction(catalogId);
      await props.refresh();
      setCatalog((current) => current.filter((item) => item.id !== catalogId));
      setSuccess("RAW adicionado aos seus capítulos.");
    } catch (cause) {
      setError(messageOf(cause));
    } finally {
      setBusy(false);
    }
  };
  const active = entries(props.chapters).filter(
    (x) =>
      x.stage.stage === "RAW" &&
      x.stage.status === "IN_PROGRESS" &&
      x.stage.assigned_to === props.member.user_id,
  );
  const {
    artifacts,
    credits,
    loading,
    error: filesError,
    reload,
  } = useCurrentArtifacts(
    active.map((item) => item.chapter.id),
    props.chapters,
  );
  return (
    <section className="page production-page">
      <div className="page-heading channel-heading">
        <p className="eyebrow">PRODUÇÃO</p>
        <h2>Raw</h2>
        <p>Escolha um capítulo, envie o RAW e conclua. Só isso.</p>
      </div>
      <section className="queue-section available-section">
        <QueueHeading
          title="Capítulos disponíveis"
          count={catalog.length}
          help="Escolha a obra e o capítulo que você vai iniciar."
        />
        <div className="raw-picker">
          <label>
            <span>Obra</span>
            <select value={workId} onChange={(e) => setWorkId(e.target.value)}>
              {works.map((work) => (
                <option value={work.id} key={work.id}>
                  {work.title}
                </option>
              ))}
            </select>
          </label>
          <label>
            <span>Capítulo</span>
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
                <option>Nenhum capítulo disponível</option>
              )}
            </select>
          </label>
          <button
            className="primary queue-claim"
            disabled={!catalogId || busy}
            onClick={() => void start()}
          >
            {busy ? "Pegando capítulo…" : "Pegar este capítulo"}
          </button>
        </div>
        {error && <Feedback kind="error">{error}</Feedback>}
        {success && <Feedback kind="success">{success}</Feedback>}
        {entries(props.chapters)
          .filter(
            (item) =>
              item.stage.stage === "RAW" &&
              item.stage.status === "AVAILABLE" &&
              !item.chapter.published_at,
          )
          .map((entry) => (
            <AvailableStageCard
              key={entry.stage.id}
              entry={entry}
              refresh={props.refresh}
            />
          ))}
      </section>
      <section className="queue-section mine-section">
        {filesError && <Feedback kind="error">{filesError}</Feedback>}
        <QueueHeading
          title="Meus capítulos"
          count={active.length}
          help="Continue exatamente de onde parou."
        />
        {active.length ? (
          <div className="work-list">
            {active.map((entry) => (
              <StageWorkCard
                key={entry.stage.id}
                entry={entry}
                artifacts={artifacts}
                credits={credits}
                filesLoading={loading}
                refresh={props.refresh}
                reloadFiles={reload}
              />
            ))}
          </div>
        ) : (
          <Empty text="Você ainda não pegou nenhum RAW." />
        )}
      </section>
    </section>
  );
}
function Queue({ stage: queueStage, ...props }: PanelProps & { stage: Stage }) {
  const list = entries(props.chapters).filter(
    (x) =>
      x.stage.stage === queueStage &&
      !x.chapter.published_at &&
      ["AVAILABLE", "IN_PROGRESS"].includes(x.stage.status),
  );
  const available = list.filter((entry) => entry.stage.status === "AVAILABLE");
  const mine = list.filter(
    (entry) =>
      entry.stage.status === "IN_PROGRESS" &&
      entry.stage.assigned_to === props.member.user_id,
  );
  const {
    artifacts,
    credits,
    loading,
    error: filesError,
    reload,
  } = useCurrentArtifacts(
    mine.map((item) => item.chapter.id),
    props.chapters,
  );
  const copy = channelCopy[queueStage as Exclude<Stage, "RAW" | "READY">];
  return (
    <section className="page production-page">
      <div className="page-heading channel-heading">
        <p className="eyebrow">PRODUÇÃO</p>
        <h2>{copy.title}</h2>
        <p>{copy.description}</p>
      </div>
      <section className="queue-section available-section">
        <QueueHeading
          title="Capítulos disponíveis"
          count={available.length}
          help="Escolha um capítulo para começar."
        />
        {available.length ? (
          <div className="available-list">
            {available.map((entry) => (
              <AvailableStageCard
                key={entry.stage.id}
                entry={entry}
                refresh={props.refresh}
              />
            ))}
          </div>
        ) : (
          <Empty text="Nada disponível agora. Quando uma etapa for liberada, ela aparecerá aqui." />
        )}
      </section>
      <section className="queue-section mine-section">
        {filesError && <Feedback kind="error">{filesError}</Feedback>}
        <QueueHeading
          title="Meus capítulos"
          count={mine.length}
          help="Arquivos e ações dos capítulos que estão com você."
        />
        {mine.length ? (
          <div className="work-list">
            {mine.map((entry) => (
              <StageWorkCard
                key={entry.stage.id}
                entry={entry}
                artifacts={artifacts}
                credits={credits}
                filesLoading={loading}
                refresh={props.refresh}
                reloadFiles={reload}
              />
            ))}
          </div>
        ) : (
          <Empty text="Nenhum capítulo com você nesta etapa." />
        )}
      </section>
    </section>
  );
}
function QueueHeading({
  title,
  count,
  help,
}: {
  title: string;
  count: number;
  help: string;
}) {
  return (
    <div className="queue-heading">
      <div>
        <h3>{title}</h3>
        <p>{help}</p>
      </div>
      <b>{count}</b>
    </div>
  );
}
function AvailableStageCard({
  entry,
  refresh,
}: {
  entry: Entry;
  refresh: PanelProps["refresh"];
}) {
  const notify = useContext(NoticeContext);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const claim = async () => {
    if (busy) return;
    setBusy(true);
    setError("");
    try {
      await claimStage(entry.stage.id);
      notify("Capítulo adicionado em Meus capítulos.");
      await refresh();
    } catch (cause) {
      setError(messageOf(cause));
    } finally {
      setBusy(false);
    }
  };
  return (
    <article className="available-card">
      <div>
        <strong>
          {entry.chapter.work?.title} #{entry.chapter.number}
        </strong>
        <span>Pronto para começar</span>
      </div>
      <button
        className="primary queue-claim"
        disabled={busy}
        onClick={() => void claim()}
      >
        {busy ? "Assumindo…" : "Pegar capítulo"}
      </button>
      {error && <Feedback kind="error">{error}</Feedback>}
    </article>
  );
}
function useCurrentArtifacts(chapterIds: string[], revision?: unknown) {
  const [artifacts, setArtifacts] = useState<Artifact[]>([]);
  const [credits, setCredits] = useState<CreditItem[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const idsKey = [...new Set(chapterIds)].sort().join(",");
  const load = useCallback(async () => {
    const ids = idsKey ? idsKey.split(",") : [];
    if (!supabase || !ids.length) {
      setArtifacts([]);
      return;
    }
    setLoading(true);
    const [files, contributions] = await Promise.all([
      supabase
        .from("artifacts")
        .select(
          "id,chapter_id,stage,provider,provider_key,original_name,mime_type,byte_size,version,note,is_current,upload_status,created_at",
        )
        .in("chapter_id", ids)
        .eq("upload_status", "AVAILABLE")
        .eq("is_current", true),
      supabase
        .from("stage_completions")
        .select(
          "id,chapter_id,stage,completed_at,user:profiles!stage_completions_user_id_fkey(display_name,github_login)",
        )
        .in("chapter_id", ids)
        .order("completed_at"),
    ]);
    setArtifacts((files.data ?? []) as Artifact[]);
    setCredits((contributions.data ?? []) as unknown as CreditItem[]);
    setError(
      files.error || contributions.error
        ? "Não foi possível carregar arquivos ou créditos. Tente atualizar."
        : "",
    );
    setLoading(false);
  }, [idsKey]);
  useEffect(() => {
    void load();
  }, [load, revision]);
  return { artifacts, credits, loading, error, reload: load };
}
const dependencyStages: Record<Exclude<Stage, "READY">, Stage[]> = {
  RAW: [],
  CLEAN_REDRAW: ["RAW"],
  TRANSLATION: ["RAW"],
  TYPESET: ["CLEAN_REDRAW", "TRANSLATION"],
  REVIEW: ["TYPESET"],
};
function StageWorkCard({
  entry,
  artifacts,
  credits = [],
  filesLoading,
  refresh,
  reloadFiles,
  showDetails = true,
}: {
  entry: Entry;
  artifacts: Artifact[];
  credits?: CreditItem[];
  filesLoading: boolean;
  refresh: PanelProps["refresh"];
  reloadFiles: () => Promise<void>;
  showDetails?: boolean;
}) {
  const notify = useContext(NoticeContext);
  const fileInput = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState("");
  const [message, setMessage] = useState<{
    kind: "error" | "success";
    text: string;
  }>();
  const stage = entry.stage.stage as Exclude<Stage, "READY">;
  const current = artifacts.find(
    (item) => item.chapter_id === entry.chapter.id && item.stage === stage,
  );
  const dependencies = dependencyStages[stage].flatMap((dependency) => {
    const artifact = artifacts.find(
      (item) =>
        item.chapter_id === entry.chapter.id && item.stage === dependency,
    );
    return artifact ? [artifact] : [];
  });
  const run = async (
    key: string,
    action: () => Promise<unknown>,
    success: string,
  ) => {
    if (busy) return;
    setBusy(key);
    setMessage(undefined);
    try {
      await action();
      setMessage({ kind: "success", text: success });
    } catch (cause) {
      setMessage({ kind: "error", text: messageOf(cause) });
    } finally {
      setBusy("");
    }
  };
  const upload = (file?: File) =>
    file &&
    run(
      "upload",
      async () => {
        await uploadArtifact({ chapterId: entry.chapter.id, stage, file });
        if (fileInput.current) fileInput.current.value = "";
        await reloadFiles();
      },
      "Arquivo enviado. Agora você já pode concluir a etapa.",
    );
  const complete = () =>
    run(
      "complete",
      async () => {
        await completeStage(entry.stage.id);
        notify(`${stageLabel[stage]} concluído. Obrigado pelo trabalho!`);
        await refresh();
      },
      "Etapa concluída.",
    );
  return (
    <article className="work-card-action">
      <header>
        <div>
          <span className="your-task">{stageLabel[stage]} · COM VOCÊ</span>
          <h3>
            {entry.chapter.work?.title} #{entry.chapter.number}
          </h3>
        </div>
        {showDetails && (
          <Link to={`/chapters/${entry.chapter.id}`}>Ver detalhes</Link>
        )}
      </header>
      {entry.stage.rejection_reason && (
        <Feedback kind="error">
          Correção solicitada: {entry.stage.rejection_reason}
        </Feedback>
      )}
      <div className="action-flow">
        {filesLoading && <p role="status">Carregando material…</p>}
        {!filesLoading &&
          dependencies.length < dependencyStages[stage].length && (
            <Feedback kind="error">
              O material ainda não carregou. Atualize antes de começar.
            </Feedback>
          )}
        {dependencies.map((dependency, index) => (
          <button
            className="action-button download-action"
            disabled={!!busy}
            key={dependency.id}
            onClick={() =>
              void run(
                `download-${dependency.id}`,
                () =>
                  downloadArtifact(
                    dependency.provider,
                    dependency.provider_key,
                  ),
                "Download iniciado.",
              )
            }
          >
            <span>{index + 1}</span>
            <div>
              <strong>Baixar {stageLabel[dependency.stage]}</strong>
              <small>Versão {dependency.version}</small>
            </div>
          </button>
        ))}
        {stage !== "REVIEW" ? (
          <>
            <div className="upload-action action-button">
              <span>{dependencies.length + 1}</span>
              <div>
                <strong>
                  {current ? "Enviar nova versão" : "Enviar arquivo"}
                </strong>
                <small>
                  {current
                    ? `Versão atual: v${current.version}`
                    : "Escolha o arquivo pronto para enviar"}
                </small>
              </div>
              <input
                ref={fileInput}
                aria-label={`Arquivo ${stageLabel[stage]}`}
                hidden
                type="file"
                disabled={!!busy}
                onChange={(event) => void upload(event.target.files?.[0])}
              />
              <button
                className="primary upload-button"
                disabled={!!busy}
                onClick={() => fileInput.current?.click()}
              >
                {busy === "upload" ? "Enviando…" : "Fazer upload"}
              </button>
            </div>
            <button
              className="action-button complete-action"
              disabled={!current || !!busy || filesLoading}
              onClick={() => void complete()}
            >
              <span>{dependencies.length + 2}</span>
              <div>
                <strong>
                  {busy === "complete"
                    ? "Concluindo…"
                    : `Concluir ${stage === "RAW" ? "RAW" : stageLabel[stage]}`}
                </strong>
                <small>
                  {current
                    ? `Usar versão ${current.version}`
                    : "Envie um arquivo primeiro"}
                </small>
              </div>
            </button>
          </>
        ) : (
          <Link
            className="action-button complete-action review-action"
            to={`/chapters/${entry.chapter.id}`}
          >
            <span>{dependencies.length + 1}</span>
            <div>
              <strong>Revisar e decidir</strong>
              <small>Aprovar ou solicitar correção</small>
            </div>
          </Link>
        )}
      </div>
      {current && (
        <button
          className="uploaded-file secondary"
          disabled={!!busy}
          onClick={() =>
            void run(
              "download-current",
              () => downloadArtifact(current.provider, current.provider_key),
              "Download iniciado.",
            )
          }
        >
          ✓ Arquivo enviado · v{current.version} · Baixar
        </button>
      )}
      {["TYPESET", "REVIEW"].includes(stage) && (
        <Credits
          credits={credits.filter(
            (credit) => credit.chapter_id === entry.chapter.id,
          )}
        />
      )}
      {message && <Feedback kind={message.kind}>{message.text}</Feedback>}
      <button
        className="release-link"
        disabled={!!busy}
        onClick={() =>
          void run(
            "release",
            async () => {
              await releaseStage(entry.stage.id);
              notify("Capítulo devolvido à fila.");
              await refresh();
            },
            "Capítulo devolvido à fila.",
          )
        }
      >
        Não vou continuar — devolver à fila
      </button>
    </article>
  );
}
function Credits({ credits }: { credits: CreditItem[] }) {
  const unique = credits.filter(
    (credit, index) =>
      credits.findIndex(
        (other) =>
          other.stage === credit.stage &&
          other.user?.github_login === credit.user?.github_login,
      ) === index,
  );
  return (
    <div className="inline-credits">
      <strong>Créditos</strong>
      {unique.length ? (
        unique.map((credit) => (
          <span key={credit.id}>
            {stageLabel[credit.stage]}:{" "}
            <b>{credit.user?.display_name || credit.user?.github_login}</b>
          </span>
        ))
      ) : (
        <span>As contribuições aparecem aqui após cada conclusão.</span>
      )}
    </div>
  );
}
function Feedback({
  kind,
  children,
}: {
  kind: "error" | "success";
  children: React.ReactNode;
}) {
  return (
    <p
      role={kind === "error" ? "alert" : "status"}
      className={`feedback ${kind}`}
    >
      {children}
    </p>
  );
}
const channelCopy: Record<
  Exclude<Stage, "RAW" | "READY">,
  { title: string; description: string }
> = {
  CLEAN_REDRAW: {
    title: "Clean",
    description: "Baixe o RAW, faça o Clean e envie o arquivo final.",
  },
  TRANSLATION: {
    title: "Tradução",
    description: "Baixe o RAW, traduza o capítulo e envie o arquivo.",
  },
  TYPESET: {
    title: "Type",
    description: "Baixe Clean e Tradução, monte o capítulo e envie o Type.",
  },
  REVIEW: {
    title: "Revisão",
    description: "Baixe o Type, confira o capítulo e aprove ou peça correção.",
  },
};
function Ready({ chapters, refresh, publicationAvailable = true }: PanelProps) {
  const notify = useContext(NoticeContext);
  const ready = chapters.filter(
    (chapter) =>
      !chapter.published_at &&
      chapter.chapter_stages.some(
        (stage) => stage.stage === "READY" && stage.status === "COMPLETED",
      ),
  );
  const { artifacts: files, loading } = useCurrentArtifacts(
    ready.map((chapter) => chapter.id),
  );
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const publish = async (chapter: Chapter) => {
    if (busy) return;
    if (
      !window.confirm(
        `${chapter.work?.title} #${chapter.number} já foi publicado? Ele será movido para Upados.`,
      )
    )
      return;
    setBusy(chapter.id);
    setError("");
    try {
      await markChapterPublished(chapter.id);
      notify("Publicação confirmada. O capítulo está em Upados.");
      await refresh();
    } catch (cause) {
      setError(messageOf(cause));
    } finally {
      setBusy("");
    }
  };
  return (
    <section className="page production-page">
      <div className="page-heading channel-heading">
        <p className="eyebrow">PUBLICAÇÃO</p>
        <h2>Pra upar</h2>
        <p>Baixe o arquivo aprovado e marque quando a publicação terminar.</p>
      </div>
      {error && <Feedback kind="error">{error}</Feedback>}
      {!publicationAvailable && (
        <Feedback kind="error">
          Os downloads continuam disponíveis. O registro em Upados aguarda a
          atualização da central.
        </Feedback>
      )}
      <section className="queue-section">
        <QueueHeading
          title="Aguardando publicação"
          count={ready.length}
          help="Somente capítulos aprovados aparecem aqui."
        />
        {ready.length ? (
          <div className="publication-list">
            {ready.map((chapter) => {
              const file = files.find(
                (item) =>
                  item.chapter_id === chapter.id && item.stage === "TYPESET",
              );
              const approved = chapter.chapter_stages.find(
                (stage) => stage.stage === "READY",
              )?.completed_at;
              return (
                <article className="publication-card" key={chapter.id}>
                  <div className="publication-number">#{chapter.number}</div>
                  <div>
                    <strong>{chapter.work?.title}</strong>
                    <small>
                      {file ? `Type v${file.version}` : "Carregando arquivo"}
                      {approved ? ` · aprovado em ${formatDate(approved)}` : ""}
                    </small>
                  </div>
                  <div className="publication-actions">
                    <button
                      className="primary big-action"
                      disabled={!file || !!busy || loading}
                      onClick={() =>
                        file &&
                        void downloadArtifact(
                          file.provider,
                          file.provider_key,
                        ).catch((cause) => setError(messageOf(cause)))
                      }
                    >
                      Baixar arquivo final
                    </button>
                    <button
                      className="publish-action big-action"
                      disabled={!file || !!busy || !publicationAvailable}
                      onClick={() => void publish(chapter)}
                    >
                      {busy === chapter.id ? "Salvando…" : "Marcar como upado"}
                    </button>
                    <Link to={`/chapters/${chapter.id}`}>Ver créditos</Link>
                  </div>
                </article>
              );
            })}
          </div>
        ) : (
          <Empty text="Tudo publicado. Nenhum capítulo aguardando upload." />
        )}
      </section>
    </section>
  );
}
function Published({ chapters, publicationAvailable = true }: PanelProps) {
  const [published, setPublished] = useState<Chapter[]>([]);
  const [page, setPage] = useState(0);
  const [more, setMore] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => {
    let active = true;
    void fetchChapters({ published: true, page }).then(({ data, error }) => {
      if (!active) return;
      setError(error ? messageOf(error) : "");
      setPublished((data || []) as unknown as Chapter[]);
      setMore(data?.length === 30);
    });
    return () => {
      active = false;
    };
  }, [page, chapters]);
  const { artifacts: files, loading } = useCurrentArtifacts(
    published.map((chapter) => chapter.id),
  );
  return (
    <section className="page production-page">
      <div className="page-heading channel-heading">
        <p className="eyebrow">ARQUIVO</p>
        <h2>Upados</h2>
        <p>Histórico dos capítulos que já foram publicados.</p>
      </div>
      <section className="queue-section">
        {error && <Feedback kind="error">{error}</Feedback>}
        <QueueHeading
          title="Capítulos publicados"
          count={published.length}
          help="Os capítulos finalizados ficam guardados somente aqui."
        />
        {published.length ? (
          <div className="publication-list">
            {published.map((chapter) => {
              const file = files.find(
                (item) =>
                  item.chapter_id === chapter.id && item.stage === "TYPESET",
              );
              return (
                <article
                  className="publication-card published"
                  key={chapter.id}
                >
                  <div className="publication-number">#{chapter.number}</div>
                  <div>
                    <strong>{chapter.work?.title}</strong>
                    <small>
                      Publicado em {formatDate(chapter.published_at!)}
                      {file ? ` · Type v${file.version}` : ""}
                    </small>
                  </div>
                  <div className="publication-actions">
                    <button
                      className="secondary big-action"
                      disabled={!file || loading}
                      onClick={() =>
                        file &&
                        void downloadArtifact(
                          file.provider,
                          file.provider_key,
                        ).catch((cause) => setError(messageOf(cause)))
                      }
                    >
                      Baixar arquivo
                    </button>
                    <Link
                      className="secondary big-action"
                      to={`/chapters/${chapter.id}`}
                    >
                      Ver capítulo
                    </Link>
                  </div>
                </article>
              );
            })}
          </div>
        ) : (
          <Empty
            text={
              publicationAvailable
                ? "Nenhum capítulo foi marcado como upado ainda."
                : "O histórico de publicação aguarda a atualização da central."
            }
          />
        )}
        <div className="pagination">
          <button
            className="secondary"
            disabled={!page}
            onClick={() => setPage(page - 1)}
          >
            Anterior
          </button>
          <span>Página {page + 1}</span>
          <button
            className="secondary"
            disabled={!more}
            onClick={() => setPage(page + 1)}
          >
            Próxima
          </button>
        </div>
      </section>
    </section>
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
  const [busy, setBusy] = useState(false);
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
    if (!supabase || !title.trim() || busy) return;
    setBusy(true);
    const { error } = await supabase.from("works").insert({
      title: title.trim(),
      synopsis,
      aliases: aliases
        .split(",")
        .map((value) => value.trim())
        .filter(Boolean),
    });
    setBusy(false);
    if (error) setError(messageOf(error));
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
        <p>Encontre uma obra e veja quais capítulos faltam.</p>
      </div>
      {member.is_admin && (
        <details className="create-box">
          <summary>＋ Nova obra</summary>
          <div>
            <input
              value={title}
              aria-label="Título da nova obra"
              onChange={(e) => setTitle(e.target.value)}
              placeholder="Título"
            />
            <textarea
              value={synopsis}
              aria-label="Sinopse da nova obra"
              onChange={(e) => setSynopsis(e.target.value)}
              placeholder="Sinopse"
            />
            <input
              value={aliases}
              onChange={(e) => setAliases(e.target.value)}
              placeholder="Outros nomes, separados por vírgula"
            />
            <button
              className="primary"
              disabled={busy || !title.trim()}
              onClick={() => void create()}
            >
              {busy ? "Criando…" : "Criar obra"}
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
  chapter_id?: string;
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
  const notify = useContext(NoticeContext);
  const { id } = useParams();
  const [chapter, setChapter] = useState<Chapter | null>(null);
  const [loading, setLoading] = useState(true);
  const [artifacts, setArtifacts] = useState<Artifact[]>([]);
  const [comments, setComments] = useState<CommentItem[]>([]);
  const [credits, setCredits] = useState<CreditItem[]>([]);
  const [activity, setActivity] = useState<ActivityItem[]>([]);
  const [body, setBody] = useState("");
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [reason, setReason] = useState("");
  const [returnStage, setReturnStage] = useState<Stage>("TYPESET");
  const load = async () => {
    if (!id || !supabase) return;
    const [c, a, co, cr, ac] = await Promise.all([
      fetchChapters({ id }),
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
    setChapter((c.data?.[0] as unknown as Chapter) || null);
    setLoading(false);
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
      if (key === "approve")
        notify("Capítulo aprovado e enviado para Pra upar.");
      if (key === "reject")
        notify("Correção solicitada. A etapa voltou para a fila.");
      if (key === "comment") notify("Observação adicionada.");
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
        <h2>{loading ? "Carregando capítulo…" : "Capítulo não encontrado"}</h2>
        {!loading && (
          <Link className="secondary" to="/">
            Voltar ao início
          </Link>
        )}
        {error && <small className="error">{error}</small>}
      </section>
    );
  const review = chapter.chapter_stages.find((item) => item.stage === "REVIEW");
  const myStage = chapter.chapter_stages.find(
    (stage) =>
      stage.status === "IN_PROGRESS" &&
      stage.assigned_to === member.user_id &&
      stage.stage !== "READY" &&
      allowed(member, stageRole[stage.stage] as Role),
  );
  const claimableStage = chapter.chapter_stages.find((stage) => {
    if (stage.status !== "AVAILABLE" || stage.stage === "READY") return false;
    return allowed(member, stageRole[stage.stage] as Role);
  });
  const ready = chapter.chapter_stages.some(
    (stage) => stage.stage === "READY" && stage.status === "COMPLETED",
  );
  const chapterState = chapter.published_at
    ? "Upado"
    : ready
      ? "Pronto pra upar"
      : myStage
        ? `${stageLabel[myStage.stage]} com você`
        : "Em produção";
  return (
    <section className="page chapter-page">
      <div className="page-heading chapter-title">
        <Link
          className="back-link"
          to={chapter.published_at ? "/published" : "/"}
        >
          ← Voltar
        </Link>
        <p className="eyebrow">CENTRAL DO CAPÍTULO</p>
        <div>
          <h2>
            {chapter.work?.title} #{chapter.number}
          </h2>
          <span className="chapter-state">{chapterState}</span>
        </div>
      </div>
      {error && <Feedback kind="error">{error}</Feedback>}
      {myStage && myStage.stage !== "REVIEW" && (
        <section className="chapter-focus">
          <QueueHeading
            title="O que você precisa fazer"
            count={1}
            help="Siga os passos abaixo na ordem."
          />
          <StageWorkCard
            entry={{ chapter, stage: myStage }}
            artifacts={artifacts}
            filesLoading={false}
            refresh={refresh}
            reloadFiles={load}
            showDetails={false}
          />
        </section>
      )}
      {!myStage && claimableStage && (
        <section className="chapter-focus">
          <QueueHeading
            title="Este capítulo está disponível"
            count={1}
            help={`Você pode assumir ${stageLabel[claimableStage.stage]} agora.`}
          />
          <AvailableStageCard
            entry={{ chapter, stage: claimableStage }}
            refresh={refresh}
          />
        </section>
      )}
      {review?.status === "IN_PROGRESS" &&
        (review.assigned_to === member.user_id || member.is_admin) && (
          <section className="chapter-focus review-focus">
            <QueueHeading
              title="Revisar e decidir"
              count={1}
              help="Baixe o Type, confira e escolha uma decisão."
            />
            {artifacts
              .filter((file) => file.stage === "TYPESET" && file.is_current)
              .map((file) => (
                <button
                  className="action-button download-action"
                  key={file.id}
                  onClick={() =>
                    void run(`download-${file.id}`, () =>
                      downloadArtifact(file.provider, file.provider_key),
                    )
                  }
                >
                  <span>1</span>
                  <div>
                    <strong>Baixar Type para revisar</strong>
                    <small>Versão {file.version}</small>
                  </div>
                </button>
              ))}
            <div className="review-decisions">
              <button
                className="approve-action big-action"
                disabled={!!busy}
                onClick={() =>
                  void run("approve", () => reviewChapter(review.id, true))
                }
              >
                {busy === "approve" ? "Aprovando…" : "Aprovar capítulo"}
              </button>
              <details>
                <summary>Solicitar correção</summary>
                <div className="review-form">
                  <label>
                    Voltar para
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
                    O que precisa ser corrigido?
                    <textarea
                      value={reason}
                      onChange={(event) => setReason(event.target.value)}
                      placeholder="Explique de forma objetiva para quem receber a correção."
                    />
                  </label>
                  <button
                    className="danger big-action"
                    disabled={!reason.trim() || !!busy}
                    onClick={() =>
                      void run("reject", () =>
                        reviewChapter(review.id, false, reason, returnStage),
                      )
                    }
                  >
                    {busy === "reject"
                      ? "Enviando correção…"
                      : "Devolver para correção"}
                  </button>
                </div>
              </details>
            </div>
          </section>
        )}
      <div className="chapter-layout">
        <div>
          <Panel title="Andamento">
            <div className="workflow">
              {chapter.chapter_stages.map((stage) => {
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
                    </div>
                  </article>
                );
              })}
            </div>
          </Panel>
          <details className="chapter-details">
            <summary>
              Arquivos e versões anteriores ({artifacts.length})
            </summary>
            <Panel title="Arquivos">
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
          </details>
          <Panel title="Observações">
            <div className="comment-form">
              <textarea
                placeholder="Observação interna…"
                aria-label="Observação interna"
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
          <Panel title="Quem trabalhou">
            <Credits credits={credits} />
          </Panel>
          <details className="chapter-details">
            <summary>Histórico do capítulo</summary>
            <Panel title="Últimas atividades">
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
                      {item.metadata?.reason && (
                        <small>Motivo: {item.metadata.reason}</small>
                      )}
                      <small>{formatDate(item.created_at)}</small>
                    </p>
                  </div>
                ))
              ) : (
                <Empty text="Nenhuma atividade ainda." />
              )}
            </Panel>
          </details>
        </aside>
      </div>
    </section>
  );
}
function Notifications({ refresh, notifications }: PanelProps) {
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
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
      .limit(50)
      .then(({ data, error }) => {
        setItems(data ?? []);
        setLoading(false);
        setError(error ? messageOf(error) : "");
      });
  useEffect(load, [notifications]);
  const run = async (action: () => Promise<void>) => {
    if (busy) return;
    setBusy(true);
    setError("");
    try {
      await action();
      load();
      await refresh();
    } catch (cause) {
      setError(messageOf(cause));
    } finally {
      setBusy(false);
    }
  };
  const open = async (item: (typeof items)[number]) => {
    if (!item.read_at) await markNotificationRead(item.id);
    nav((item.link_path || "/notifications").replace(/^#/, ""));
  };
  return (
    <section className="page">
      <div className="page-heading">
        <p className="eyebrow">AVISOS DA STAFF</p>
        <h2>Notificações</h2>
        <p>Novos trabalhos e atualizações dos seus capítulos.</p>
      </div>
      {error && <Feedback kind="error">{error}</Feedback>}
      <button
        className="secondary"
        disabled={busy || !notifications}
        onClick={() => void run(markAllNotificationsRead)}
      >
        Marcar todas como lidas
      </button>
      <Panel title="Últimos avisos">
        {items.map((item) => (
          <button
            className={`notification ${item.read_at ? "read" : "unread"}`}
            key={item.id}
            disabled={busy}
            onClick={() => void run(() => open(item))}
          >
            <span>{item.body}</span>
            <small>{item.read_at ? "Abrir →" : "Novo · Abrir →"}</small>
          </button>
        ))}
        {!items.length && (
          <Empty
            text={
              loading
                ? "Carregando avisos…"
                : "Você está em dia. Novos avisos aparecerão aqui."
            }
          />
        )}
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
  const [deliveries, setDeliveries] = useState<
    Array<{
      id: string;
      work_title: string;
      chapter_number: string;
      stage: Stage;
      recipient_email: string;
      status: "PENDING" | "PROCESSING" | "SENT" | "FAILED";
      attempts: number;
      last_error: string | null;
      created_at: string;
    }>
  >([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const load = async () => {
    setLoading(true);
    setError("");
    const { data, error: queryError } = await supabase!
      .from("production_email_outbox")
      .select(
        "id,work_title,chapter_number,stage,recipient_email,status,attempts,last_error,created_at",
      )
      .in("status", ["PENDING", "PROCESSING", "FAILED"])
      .order("created_at", { ascending: false })
      .limit(20);
    if (queryError) setError(queryError.message);
    else setDeliveries((data ?? []) as typeof deliveries);
    setLoading(false);
  };
  useEffect(() => {
    void load();
  }, []);
  return (
    <section className="page">
      <h2>Configurações</h2>
      <Panel title="Projeto">
        <p>
          As configurações sensíveis de e-mail ficam protegidas nos secrets do
          Supabase e nunca são enviadas ao navegador.
        </p>
      </Panel>
      <section className="panel email-diagnostics">
        <div className="panel-heading">
          <div>
            <h3>Diagnóstico de e-mails</h3>
            <p>Envios pendentes ou que precisam de atenção.</p>
          </div>
          <button
            className="secondary"
            disabled={loading}
            onClick={() => void load()}
          >
            {loading ? "Atualizando…" : "Atualizar"}
          </button>
        </div>
        {error && (
          <p className="notice">
            Não foi possível consultar os envios: {error}
          </p>
        )}
        {!loading && !error && deliveries.length === 0 && (
          <Empty text="Nenhuma falha ou envio pendente." />
        )}
        {deliveries.map((delivery) => (
          <article className="email-delivery" key={delivery.id}>
            <div>
              <strong>
                {delivery.work_title} #{delivery.chapter_number} ·{" "}
                {stageLabel[delivery.stage]}
              </strong>
              <span>{delivery.recipient_email}</span>
            </div>
            <span
              className={`delivery-status ${delivery.status.toLowerCase()}`}
            >
              {delivery.status === "FAILED"
                ? "Falhou"
                : delivery.status === "PROCESSING"
                  ? "Enviando"
                  : "Pendente"}
            </span>
            <small>
              {delivery.last_error || `Tentativa ${delivery.attempts}`}
            </small>
          </article>
        ))}
      </section>
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
      published: "marcou o capítulo como upado",
    }[item.action] || item.action;
  return `${action}${item.stage && !["approved", "rejected"].includes(item.action) ? ` ${stageLabel[item.stage]}` : ""}`;
};
