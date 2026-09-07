import { useState, type ReactNode } from "react";
import { Link } from "react-router-dom";
import { supabase } from "./lib/supabase";
import { messageOf } from "./lib/errors";
import { orderedStages, stageLabel, stageRole } from "./workflow";
import { useConfirmation } from "./ConfirmDialog";
import { ContextMenu } from "./ContextMenu";
import type { Chapter, Role } from "./types";

export async function adminOperation(name: string, args: Record<string, unknown>) {
  if (!supabase) throw new Error("Conexão indisponível.");
  const { error } = await supabase.rpc(name, args);
  if (error) throw error;
}
export function AdminChapterActions({ chapter, onChanged, onDeleted, compact = false, extraActions }: {
  chapter: Chapter; onChanged: () => void | Promise<void>; onDeleted: () => void | Promise<void>; compact?: boolean; extraActions?: ReactNode;
}) {
  const { confirm, dialog } = useConfirmation();
  const [busy, setBusy] = useState("");
  const [feedback, setFeedback] = useState("");
  const [error, setError] = useState("");
  const label = `${chapter.work?.title} #${chapter.number}`;
  const run = async (action: "cancel" | "unpublish" | "delete") => {
    if (busy) return;
    const deleting = action === "delete";
    if (!await confirm({
      title: `${deleting ? "Excluir permanentemente" : action === "cancel" ? "Cancelar produção de" : "Despublicar"} ${label}?`,
      description: deleting ? "O capítulo, suas tarefas, comentários e histórico serão excluídos da central. Arquivos já armazenados não serão apagados. Esta ação não pode ser desfeita." : action === "cancel" ? "As tarefas serão encerradas e o capítulo voltará para A fazer. Arquivos anteriores e créditos serão preservados." : "O capítulo sairá de Upados e voltará para Pra upar. Arquivos e créditos serão preservados.",
      requiredText: deleting ? label : undefined, danger: deleting || action === "cancel", confirmLabel: deleting ? "Excluir capítulo" : action === "cancel" ? "Cancelar produção" : "Despublicar",
    })) return;
    setBusy(action); setError(""); setFeedback("");
    try {
      await adminOperation(`admin_${action === "cancel" ? "cancel_production" : action === "unpublish" ? "unpublish_chapter" : "delete_chapter"}`, { p_chapter_id: chapter.id, ...(deleting ? { p_confirmation: label } : {}) });
      setFeedback(action === "cancel" ? "Produção cancelada. O capítulo voltou para A fazer." : action === "unpublish" ? "Capítulo devolvido para Pra upar." : "Capítulo excluído.");
      if (deleting) await onDeleted(); else await onChanged();
    } catch (cause) { setError(messageOf(cause)); } finally { setBusy(""); }
  };
  const actions = <>
    {extraActions}
    {compact && <Link to={`/chapters/${chapter.id}`}>Gerenciar capítulo</Link>}
    {chapter.published_at && <button className="secondary" disabled={!!busy} onClick={() => void run("unpublish")}>{busy === "unpublish" ? "Despublicando…" : "Despublicar"}</button>}
    {!chapter.cancelled_at && !chapter.published_at && <button className="secondary" disabled={!!busy} onClick={() => void run("cancel")}>{busy === "cancel" ? "Cancelando…" : "Cancelar produção"}</button>}
    <button className="danger" disabled={!!busy} onClick={() => void run("delete")}>{busy === "delete" ? "Excluindo…" : "Excluir capítulo"}</button>
  </>;
  return <>
    {compact ? <ContextMenu label={`Opções administrativas de ${label}`}>{actions}</ContextMenu> : <div className="admin-danger-actions">{actions}</div>}
    {feedback && <p className="feedback success" role="status">{feedback}</p>}{error && <p className="feedback error" role="alert">{error}</p>}{dialog}
  </>;
}

type Candidate = { user_id: string; display_name: string | null; github_login: string; is_admin: boolean; user_roles: { role_code: Role }[] };
export function ChapterAdmin({ chapter, refresh, onDeleted }: { chapter: Chapter; refresh: () => void | Promise<void>; onDeleted: () => void | Promise<void> }) {
  const { confirm, dialog } = useConfirmation();
  const [members, setMembers] = useState<Candidate[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [success, setSuccess] = useState("");
  const [selected, setSelected] = useState("");
  const [assignee, setAssignee] = useState("");
  const [reopen, setReopen] = useState("");
  const [reason, setReason] = useState("");
  const stages = orderedStages(chapter.chapter_stages).filter(s => s.stage !== "READY");
  const assignable = stages.filter(s => ["AVAILABLE", "IN_PROGRESS"].includes(s.status));
  const target = assignable.find(s => s.id === selected);
  const loadMembers = async () => {
    const { data, error } = await supabase!.from("staff_members").select("user_id,display_name,github_login,is_admin,user_roles(role_code)").eq("is_active", true).order("github_login");
    if (error) setError(messageOf(error)); else setMembers((data || []) as Candidate[]);
  };
  const run = async (kind: "assign" | "reopen") => {
    if (busy) return;
    if (!await confirm({ title: kind === "assign" ? (assignee ? "Alterar o responsável?" : "Devolver a tarefa à fila?") : "Reabrir esta etapa?", description: kind === "assign" ? "O responsável anterior será liberado. Arquivos e créditos anteriores continuam no histórico." : "Esta etapa e o trabalho que depende dela precisarão ser refeitos. Arquivos e créditos anteriores serão preservados.", confirmLabel: kind === "assign" ? "Confirmar alteração" : "Reabrir etapa" })) return;
    setBusy(true); setError(""); setSuccess("");
    try {
      await adminOperation(kind === "assign" ? "admin_assign_stage" : "admin_reopen_stage", kind === "assign" ? { p_stage_id: selected, p_assignee: assignee || null } : { p_stage_id: reopen, p_reason: reason });
      setSuccess(kind === "assign" ? (assignee ? "Responsável atualizado." : "Tarefa devolvida à fila.") : "Etapa reaberta. O andamento foi atualizado.");
      setSelected(""); setAssignee(""); setReopen(""); setReason(""); await refresh();
    } catch (cause) { setError(messageOf(cause)); } finally { setBusy(false); }
  };
  return <details className="chapter-details chapter-administration" onToggle={event => { if (event.currentTarget.open) void loadMembers(); }}>
    <summary>Gerenciar capítulo <span>Somente administradores</span></summary>
    <div className="admin-tools">
      {error && <p className="feedback error" role="alert">{error}</p>}{success && <p className="feedback success" role="status">{success}</p>}
      {!chapter.published_at && !chapter.cancelled_at && <div className="admin-tool-grid">
        <section><h3>Responsável pela tarefa</h3><p>Atribua a alguém ou devolva para a fila.</p>
          <label className="simple-field"><span>Etapa para atribuir</span><select value={selected} onChange={e => { setSelected(e.target.value); setAssignee(""); }}><option value="">Escolher etapa</option>{assignable.map(s => <option key={s.id} value={s.id}>{stageLabel[s.stage]}{s.assignee ? ` · ${s.assignee.display_name || s.assignee.github_login}` : " · disponível"}</option>)}</select></label>
          <label className="simple-field"><span>Novo responsável</span><select value={assignee} disabled={!target} onChange={e => setAssignee(e.target.value)}><option value="">Devolver à fila</option>{members.filter(m => m.is_admin || (target && m.user_roles.some(r => r.role_code === stageRole[target.stage as Exclude<typeof target.stage, "READY">]))).map(m => <option key={m.user_id} value={m.user_id}>{m.display_name || m.github_login}</option>)}</select></label>
          <button className="secondary" disabled={busy || !selected} onClick={() => void run("assign")}>{busy ? "Salvando…" : "Salvar responsável"}</button>
        </section>
        <section><h3>Reabrir uma etapa</h3><p>Corrija o andamento sem apagar o trabalho anterior.</p>
          <label className="simple-field"><span>Etapa para reabrir</span><select value={reopen} onChange={e => setReopen(e.target.value)}><option value="">Escolher etapa</option>{stages.map(s => <option key={s.id} value={s.id}>{stageLabel[s.stage]}</option>)}</select></label>
          <label className="simple-field"><span>Motivo da reabertura</span><input value={reason} onChange={e => setReason(e.target.value)} placeholder="O que precisa ser corrigido?" /></label>
          <button className="secondary" disabled={busy || !reopen || !reason.trim()} onClick={() => void run("reopen")}>{busy ? "Salvando…" : "Reabrir etapa"}</button>
        </section>
      </div>}
      {chapter.cancelled_at && <p>Produção cancelada. O capítulo pode ser escolhido novamente no canal Raw.</p>}
      <AdminChapterActions chapter={chapter} onChanged={refresh} onDeleted={onDeleted} />
    </div>{dialog}
  </details>;
}
