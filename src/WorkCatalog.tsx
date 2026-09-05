import { useCallback, useEffect, useMemo, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { supabase } from "./lib/supabase";
import type { CatalogStatus, StaffMember } from "./types";

type Work = {
  id: string;
  title: string;
  synopsis: string;
  aliases: string[];
  status: "ACTIVE" | "PAUSED" | "COMPLETED";
  cover_path: string | null;
};
type CatalogChapter = {
  id: string;
  number: number;
  status: CatalogStatus;
  production: { id: string }[];
};
const labels: Record<CatalogStatus, string> = {
  TODO: "A fazer",
  IN_PRODUCTION: "Em produção",
  COMPLETED: "Concluído",
};
export const canRemoveCatalogChapter = (
  status: CatalogStatus,
  hasProduction = false,
) => status !== "IN_PRODUCTION" && !hasProduction;
export function parseChapterRange(
  mode: "single" | "range",
  single: string,
  start: string,
  end: string,
) {
  const from = Number(mode === "single" ? single : start);
  const to = Number(mode === "single" ? single : end);
  return Number.isInteger(from) &&
    Number.isInteger(to) &&
    from > 0 &&
    to >= from
    ? { from, to }
    : null;
}

export function SimpleWorkCatalog({ member }: { member: StaffMember }) {
  const { id } = useParams();
  const [work, setWork] = useState<Work | null>(null);
  const [chapters, setChapters] = useState<CatalogChapter[]>([]);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [filter, setFilter] = useState<"ALL" | CatalogStatus>("ALL");
  const [mode, setMode] = useState<"single" | "range">("single");
  const [single, setSingle] = useState("");
  const [start, setStart] = useState("");
  const [end, setEnd] = useState("");
  const [busy, setBusy] = useState("");
  const [feedback, setFeedback] = useState("");

  const load = useCallback(async () => {
    if (!id || !supabase) return;
    const [workResult, catalogResult] = await Promise.all([
      supabase
        .from("works")
        .select("id,title,synopsis,aliases,status,cover_path")
        .eq("id", id)
        .maybeSingle(),
      supabase
        .from("work_chapter_catalog")
        .select("id,number,status,production:chapters(id)")
        .eq("work_id", id)
        .order("number"),
    ]);
    if (workResult.error || catalogResult.error)
      setFeedback(
        workResult.error?.message ??
          catalogResult.error?.message ??
          "Não foi possível carregar a obra.",
      );
    else {
      setWork(workResult.data as Work);
      setChapters((catalogResult.data ?? []) as CatalogChapter[]);
    }
  }, [id]);
  useEffect(() => {
    void load();
  }, [load]);

  const run = async (key: string, action: () => Promise<void>) => {
    if (busy) return;
    setBusy(key);
    setFeedback("");
    try {
      await action();
      await load();
    } catch (error) {
      setFeedback(
        error instanceof Error
          ? error.message
          : "Não foi possível concluir a ação.",
      );
    } finally {
      setBusy("");
    }
  };
  const add = () =>
    run("add", async () => {
      const range = parseChapterRange(mode, single, start, end);
      if (!id || !range)
        throw new Error("Informe um capítulo ou intervalo válido.");
      const { data, error } = await supabase!.rpc("add_catalog_chapter_range", {
        p_work_id: id,
        p_start: range.from,
        p_end: range.to,
      });
      if (error) throw error;
      setFeedback(`${data?.[0]?.added ?? 0} capítulo(s) adicionado(s).`);
      setSingle("");
      setStart("");
      setEnd("");
    });
  const updateStatus = (
    ids: string[],
    status: Exclude<CatalogStatus, "IN_PRODUCTION">,
  ) =>
    run("status", async () => {
      if (
        chapters.some(
          (chapter) =>
            ids.includes(chapter.id) && chapter.production.length > 0,
        )
      )
        throw new Error(
          "Capítulos que já entraram em produção são atualizados automaticamente pelo workflow.",
        );
      const { error } = await supabase!.rpc("update_catalog_chapters", {
        p_ids: ids,
        p_status: status,
      });
      if (error) throw error;
      setSelected(new Set());
      setFeedback(`${ids.length} capítulo(s) atualizado(s).`);
    });
  const remove = (ids: string[]) =>
    run("remove", async () => {
      const targets = chapters.filter((chapter) => ids.includes(chapter.id));
      if (
        targets.some(
          (chapter) =>
            !canRemoveCatalogChapter(
              chapter.status,
              chapter.production.length > 0,
            ),
        )
      )
        throw new Error("Capítulos em produção não podem ser removidos.");
      if (!window.confirm(`Remover ${ids.length} capítulo(s) do catálogo?`))
        return;
      const { error } = await supabase!.rpc("delete_catalog_chapters", {
        p_ids: ids,
      });
      if (error) throw error;
      setSelected(new Set());
      setFeedback(`${ids.length} capítulo(s) removido(s).`);
    });
  const visible = useMemo(
    () =>
      chapters.filter(
        (chapter) => filter === "ALL" || chapter.status === filter,
      ),
    [chapters, filter],
  );
  const selectedHasProduction = chapters.some(
    (chapter) => selected.has(chapter.id) && chapter.production.length > 0,
  );
  const counts = {
    completed: chapters.filter((chapter) => chapter.status === "COMPLETED")
      .length,
    production: chapters.filter((chapter) => chapter.status === "IN_PRODUCTION")
      .length,
  };
  if (!work)
    return (
      <section className="page">
        <p className="empty">{feedback || "Carregando obra…"}</p>
      </section>
    );

  return (
    <section className="page catalog-page">
      <div className="page-heading">
        <Link className="back-link" to="/works">
          ← Obras
        </Link>
        <p className="eyebrow">CATÁLOGO DA OBRA</p>
        <h2>{work.title}</h2>
        <p>{work.synopsis || "Sem sinopse cadastrada."}</p>
      </div>
      <div className="stats">
        <span>
          <b>{chapters.length}</b>Total
        </span>
        <span>
          <b>{counts.completed}</b>Concluídos
        </span>
        <span>
          <b>{counts.production}</b>Em produção
        </span>
        <span>
          <b>{chapters.length - counts.completed - counts.production}</b>A fazer
        </span>
      </div>
      {member.is_admin && (
        <WorkForm work={work} busy={busy} run={run} />
      )}
      {member.is_admin && (
        <section className="panel chapter-create">
          <div className="panel-heading">
            <div>
              <h3>Adicionar capítulos</h3>
              <p>Inclua um capítulo ou um intervalo contínuo.</p>
            </div>
            <div className="segmented">
              <button
                className={mode === "single" ? "active" : ""}
                onClick={() => setMode("single")}
              >
                Adicionar capítulo
              </button>
              <button
                className={mode === "range" ? "active" : ""}
                onClick={() => setMode("range")}
              >
                Adicionar vários capítulos
              </button>
            </div>
          </div>
          {mode === "single" ? (
            <label className="simple-field">
              <span>Número do capítulo</span>
              <input
                type="number"
                min="1"
                value={single}
                onChange={(event) => setSingle(event.target.value)}
                placeholder="81"
              />
            </label>
          ) : (
            <div className="range-fields">
              <label className="simple-field">
                <span>Primeiro</span>
                <input
                  type="number"
                  min="1"
                  value={start}
                  onChange={(event) => setStart(event.target.value)}
                  placeholder="1"
                />
              </label>
              <span>até</span>
              <label className="simple-field">
                <span>Último</span>
                <input
                  type="number"
                  min="1"
                  value={end}
                  onChange={(event) => setEnd(event.target.value)}
                  placeholder="80"
                />
              </label>
            </div>
          )}
          <button
            className="primary"
            disabled={busy === "add"}
            onClick={() => void add()}
          >
            {busy === "add"
              ? "Adicionando…"
              : mode === "single"
                ? "Adicionar capítulo"
                : "Adicionar vários capítulos"}
          </button>
        </section>
      )}
      {feedback && <p className="notice">{feedback}</p>}
      <section className="panel catalog-list-panel">
        <div className="panel-heading">
          <div>
            <h3>Capítulos</h3>
            <p>{visible.length} exibido(s)</p>
          </div>
          <div className="filters">
            {(["ALL", "TODO", "IN_PRODUCTION", "COMPLETED"] as const).map(
              (value) => (
                <button
                  className={filter === value ? "active" : ""}
                  key={value}
                  onClick={() => setFilter(value)}
                >
                  {value === "ALL" ? "Todos" : labels[value]}
                </button>
              ),
            )}
          </div>
        </div>
        {member.is_admin && selected.size > 0 && (
          <div className="bulk-bar">
            <strong>{selected.size} selecionado(s)</strong>
            {selectedHasProduction && (
              <span>Itens com produção não podem ser alterados.</span>
            )}
            <button
              className="secondary"
              disabled={!!busy || selectedHasProduction}
              onClick={() => void updateStatus([...selected], "TODO")}
            >
              Marcar A fazer
            </button>
            <button
              className="secondary"
              disabled={!!busy || selectedHasProduction}
              onClick={() => void updateStatus([...selected], "COMPLETED")}
            >
              Marcar concluídos
            </button>
            <button
              className="danger"
              disabled={!!busy || selectedHasProduction}
              onClick={() => void remove([...selected])}
            >
              Remover
            </button>
            <button className="ghost" onClick={() => setSelected(new Set())}>
              Cancelar seleção
            </button>
          </div>
        )}
        {member.is_admin && visible.length > 0 && (
          <label className="select-all">
            <input
              type="checkbox"
              checked={visible.every((chapter) => selected.has(chapter.id))}
              onChange={(event) =>
                setSelected(
                  event.target.checked
                    ? new Set(visible.map((chapter) => chapter.id))
                    : new Set(),
                )
              }
            />
            Selecionar todos desta lista
          </label>
        )}
        <div className="catalog-list">
          {visible.map((chapter) => (
            <article
              className={`catalog-row${member.is_admin ? "" : " viewer"}`}
              key={chapter.id}
            >
              {member.is_admin && (
                <input
                  type="checkbox"
                  checked={selected.has(chapter.id)}
                  onChange={() =>
                    setSelected((current) => {
                      const next = new Set(current);
                      if (next.has(chapter.id)) next.delete(chapter.id);
                      else next.add(chapter.id);
                      return next;
                    })
                  }
                />
              )}
              <strong>#{chapter.number}</strong>
              <span
                className={`catalog-status ${chapter.status.toLowerCase()}`}
              >
                {labels[chapter.status]}
              </span>
              {member.is_admin && (
                <details className="chapter-menu">
                  <summary aria-label={`Ações do capítulo ${chapter.number}`}>
                    ⋯
                  </summary>
                  <div>
                    <button
                      disabled={chapter.production.length > 0}
                      onClick={() => void updateStatus([chapter.id], "TODO")}
                    >
                      Marcar como A fazer
                    </button>
                    <button
                      disabled={chapter.production.length > 0}
                      onClick={() =>
                        void updateStatus([chapter.id], "COMPLETED")
                      }
                    >
                      Marcar como concluído
                    </button>
                    <button
                      className="danger-text"
                      disabled={
                        !canRemoveCatalogChapter(
                          chapter.status,
                          chapter.production.length > 0,
                        )
                      }
                      onClick={() => void remove([chapter.id])}
                    >
                      {!canRemoveCatalogChapter(
                        chapter.status,
                        chapter.production.length > 0,
                      )
                        ? "Possui produção — não removível"
                        : "Remover capítulo"}
                    </button>
                  </div>
                </details>
              )}
            </article>
          ))}
        </div>
        {!visible.length && (
          <p className="empty">Nenhum capítulo neste filtro.</p>
        )}
      </section>
    </section>
  );
}

function WorkForm({
  work,
  busy,
  run,
}: {
  work: Work;
  busy: string;
  run: (key: string, action: () => Promise<void>) => Promise<void>;
}) {
  const [title, setTitle] = useState(work.title);
  const [synopsis, setSynopsis] = useState(work.synopsis);
  const [otherNames, setOtherNames] = useState(work.aliases.join(", "));
  const [coverUrl, setCoverUrl] = useState("");
  useEffect(() => {
    setTitle(work.title);
    setSynopsis(work.synopsis);
    setOtherNames(work.aliases.join(", "));
  }, [work]);
  useEffect(() => {
    let active = true;
    setCoverUrl("");
    if (work.cover_path)
      void supabase!.storage
        .from("work-covers")
        .createSignedUrl(work.cover_path, 900)
        .then(({ data }) => {
          if (active) setCoverUrl(data?.signedUrl ?? "");
        });
    return () => {
      active = false;
    };
  }, [work.cover_path]);
  const save = () =>
    run("work", async () => {
      const { error } = await supabase!
        .from("works")
        .update({
          title: title.trim(),
          synopsis: synopsis.trim(),
          aliases: otherNames
            .split(",")
            .map((value) => value.trim())
            .filter(Boolean),
        })
        .eq("id", work.id);
      if (error) throw error;
    });
  const uploadCover = (file?: File) =>
    run("cover", async () => {
      if (
        !file ||
        !["image/jpeg", "image/png", "image/webp"].includes(file.type)
      )
        throw new Error("Escolha uma imagem JPG, PNG ou WEBP.");
      const extension =
        file.type === "image/png"
          ? "png"
          : file.type === "image/webp"
            ? "webp"
            : "jpg";
      const path = `${work.id}/${crypto.randomUUID()}.${extension}`;
      const { error: uploadError } = await supabase!.storage
        .from("work-covers")
        .upload(path, file, { contentType: file.type });
      if (uploadError) throw uploadError;
      const { error } = await supabase!
        .from("works")
        .update({ cover_path: path })
        .eq("id", work.id);
      if (error) throw error;
      if (work.cover_path)
        await supabase!.storage.from("work-covers").remove([work.cover_path]);
    });
  const removeCover = () =>
    run("cover", async () => {
      if (!work.cover_path) return;
      const { error } = await supabase!
        .from("works")
        .update({ cover_path: null })
        .eq("id", work.id);
      if (error) throw error;
      await supabase!.storage.from("work-covers").remove([work.cover_path]);
    });
  return (
    <section className="panel work-editor">
      <div className="panel-heading">
        <div>
          <h3>Informações da obra</h3>
          <p>Dados exibidos para toda a staff.</p>
        </div>
      </div>
      <div className="work-edit-layout">
        <div className="cover-editor">
          {coverUrl ? (
            <img src={coverUrl} alt={`Capa de ${work.title}`} />
          ) : (
            <span>Sem capa</span>
          )}
          <label className="secondary">
            {busy === "cover" ? "Enviando…" : "Trocar capa"}
            <input
              hidden
              type="file"
              accept=".jpg,.jpeg,.png,.webp,image/jpeg,image/png,image/webp"
              disabled={busy === "cover"}
              onChange={(event) => void uploadCover(event.target.files?.[0])}
            />
          </label>
          {work.cover_path && (
            <button className="danger-text" onClick={() => void removeCover()}>
              Remover capa
            </button>
          )}
        </div>
        <div className="work-fields">
          <label className="simple-field">
            <span>Título</span>
            <input
              value={title}
              onChange={(event) => setTitle(event.target.value)}
            />
          </label>
          <label className="simple-field">
            <span>Outros nomes</span>
            <input
              value={otherNames}
              onChange={(event) => setOtherNames(event.target.value)}
              placeholder="Separe por vírgulas"
            />
          </label>
          <label className="simple-field full">
            <span>Sinopse</span>
            <textarea
              value={synopsis}
              onChange={(event) => setSynopsis(event.target.value)}
            />
          </label>
          <button
            className="primary"
            disabled={busy === "work" || !title.trim()}
            onClick={() => void save()}
          >
            {busy === "work" ? "Salvando…" : "Salvar informações"}
          </button>
        </div>
      </div>
    </section>
  );
}
