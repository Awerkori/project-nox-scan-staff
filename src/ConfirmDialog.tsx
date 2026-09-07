import { useEffect, useRef, useState } from "react";
type Options = { title: string; description: string; confirmLabel?: string; requiredText?: string; danger?: boolean };

export function useConfirmation() {
  const [options, setOptions] = useState<Options | null>(null);
  const [text, setText] = useState("");
  const pending = useRef<((value: boolean) => void) | null>(null);
  const dialogRef = useRef<HTMLDialogElement>(null);
  useEffect(() => { if (options && !dialogRef.current?.open) dialogRef.current?.showModal(); }, [options]);
  useEffect(() => () => { pending.current?.(false); }, []);
  const finish = (value: boolean) => {
    dialogRef.current?.close(); pending.current?.(value); pending.current = null; setOptions(null); setText("");
  };
  const confirm = (next: Options) => new Promise<boolean>(resolve => {
    pending.current?.(false); pending.current = resolve; setText(""); setOptions(next);
  });
  const dialog = options && <dialog ref={dialogRef} className="confirm-dialog" aria-labelledby="confirmation-title" onCancel={event => { event.preventDefault(); finish(false); }}>
    <form onSubmit={event => { event.preventDefault(); if (!options.requiredText || text === options.requiredText) finish(true); }}>
      <h3 id="confirmation-title">{options.title}</h3>
      <p>{options.description}</p>
      {options.requiredText && <label className="simple-field"><span>Digite <strong>{options.requiredText}</strong> para confirmar</span><input aria-label="Confirmação da exclusão" autoComplete="off" value={text} onChange={event => setText(event.target.value)} /></label>}
      <div className="dialog-actions"><button type="button" className="secondary" onClick={() => finish(false)}>Cancelar</button><button className={options.danger ? "danger" : "primary"} disabled={!!options.requiredText && text !== options.requiredText}>{options.confirmLabel || "Confirmar"}</button></div>
    </form>
  </dialog>;
  return { confirm, dialog };
}
