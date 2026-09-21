// Custom dropdown — native <select> popups ignore page CSS on Windows Chrome,
// so we render our own to keep the dark theme.
import { useEffect, useRef, useState } from "react";

export interface Opt { value: string; label: string }

export function Select({ value, onChange, options, className, title, dropUp }: {
  value: string;
  onChange: (v: string) => void;
  options: Opt[];
  className?: string;
  title?: string;
  dropUp?: boolean; // open upward (bottom toolbars)
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => { if (!ref.current?.contains(e.target as Node)) setOpen(false); };
    const esc = (e: KeyboardEvent) => { if (e.key === "Escape") setOpen(false); };
    document.addEventListener("mousedown", close);
    document.addEventListener("keydown", esc);
    return () => { document.removeEventListener("mousedown", close); document.removeEventListener("keydown", esc); };
  }, [open]);
  const cur = options.find((o) => o.value === value);
  return (
    <div className={`select-dd ${dropUp ? "up" : ""} ${className || ""}`} ref={ref} data-tip={title}>
      <button type="button" className={`select-btn ${open ? "open" : ""}`} onClick={() => setOpen(!open)}>
        <span className="select-val">{cur?.label ?? "—"}</span>
        <svg className="select-caret" width="10" height="6" viewBox="0 0 10 6" aria-hidden>
          <path fill="currentColor" d="M1 1l4 4 4-4" />
        </svg>
      </button>
      {open && (
        <ul className="select-menu" role="listbox">
          {options.map((o) => (
            <li key={o.value} role="option" aria-selected={o.value === value}
                className={o.value === value ? "sel" : ""}
                onClick={() => { onChange(o.value); setOpen(false); }}>
              {o.label}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
