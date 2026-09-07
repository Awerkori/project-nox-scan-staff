import { useState } from "react";
import { Link } from "react-router-dom";
import { ContextMenu } from "./ContextMenu";
import { useConfirmation } from "./ConfirmDialog";
import { supabase } from "./lib/supabase";
import { messageOf } from "./lib/errors";

export function WorkActions({ work, refresh, onDeleted }: { work: { id: string; title: string; status: string }; refresh: () => void; onDeleted: () => void }) {
  const { confirm, dialog } = useConfirmation();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [success, setSuccess] = useState("");
  const run = async (remove: boolean) => {
    if (busy || !supabase) return;
    const resume = work.status === "PAUSED";
    if (!await confirm({ title: remove ? `Excluir permanentemente ${work.title}?` : `${resume ? "Retomar" : "Arquivar"} ${work.title}?`, description: remove ? "A obra, o catálogo e todos os dados de produção serão excluídos da central. Os arquivos no Telegram e no Supabase serão preservados, com suas referências guardadas em uma auditoria privada. Esta ação não pode ser desfeita pela interface." : resume ? "A obra voltará a aparecer na escolha de novos capítulos no Raw." : "A obra ficará pausada na biblioteca e não aparecerá na escolha de novos capítulos no Raw. O trabalho já iniciado e os arquivos serão preservados.", requiredText: remove ? work.title : undefined, confirmLabel: remove ? "Excluir obra" : resume ? "Retomar obra" : "Arquivar obra", danger: remove })) return;
    setBusy(true); setError(""); setSuccess("");
    try {
      const result = remove ? await supabase.rpc("admin_delete_work", { p_work_id: work.id, p_confirmation: work.title }) : await supabase.from("works").update({ status: resume ? "ACTIVE" : "PAUSED" }).eq("id", work.id);
      if (result.error) throw result.error;
      if (remove) onDeleted(); else { setSuccess(resume ? "Obra retomada." : "Obra arquivada. Produção existente preservada."); refresh(); }
    } catch (cause) { setError(messageOf(cause)); } finally { setBusy(false); }
  };
  return <><ContextMenu label={`Administrar obra ${work.title}`}>
    <Link to={`/works/${work.id}`}>Editar obra</Link>
    <button disabled={busy} onClick={() => void run(false)}>{busy ? "Salvando…" : work.status === "PAUSED" ? "Retomar obra" : "Arquivar obra"}</button>
    <button className="danger" disabled={busy} onClick={() => void run(true)}>Excluir obra</button>
  </ContextMenu>{error && <p role="alert" className="feedback error">{error}</p>}{success && <p role="status" className="feedback success">{success}</p>}{dialog}</>;
}
