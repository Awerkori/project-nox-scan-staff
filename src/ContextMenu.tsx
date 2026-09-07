import { useEffect, useId, useRef, type ReactNode } from "react";

// Native top-layer popover: escapes card clipping, closes on Escape/outside click.
export function ContextMenu({ label, children }: { label: string; children: ReactNode }) {
  const id = useId();
  const trigger = useRef<HTMLButtonElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const close = (event: Event) => { if (panel.current?.matches(":popover-open") && !(event.target instanceof Node && panel.current.contains(event.target))) panel.current.hidePopover(); };
    window.addEventListener("resize", close);
    document.addEventListener("scroll", close, true);
    return () => { window.removeEventListener("resize", close); document.removeEventListener("scroll", close, true); };
  }, []);
  const position = () => {
    const button = trigger.current, menu = panel.current;
    if (!button || !menu) return;
    const rect = button.getBoundingClientRect();
    const width = Math.min(260, window.innerWidth - 24);
    menu.style.width = `${width}px`;
    menu.style.left = `${Math.max(12, Math.min(rect.right - width, window.innerWidth - width - 12))}px`;
    const height = menu.getBoundingClientRect().height;
    menu.style.top = `${Math.max(12, rect.bottom + height + 12 < window.innerHeight ? rect.bottom + 8 : rect.top - height - 8)}px`;
  };
  return <div className="chapter-menu">
    <button ref={trigger} type="button" popoverTarget={id} aria-label={label}>⋯</button>
    <div ref={panel} id={id} popover="auto" className="context-panel" onToggle={() => { if (panel.current?.matches(":popover-open")) position(); }} onClick={event => { if ((event.target as HTMLElement).closest("button:not(:disabled),a")) panel.current?.hidePopover(); }}>
      {children}
    </div>
  </div>;
}
