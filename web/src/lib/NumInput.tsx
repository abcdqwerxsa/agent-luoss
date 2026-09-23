import { useEffect, useState } from "react";
import { Icon } from "./icons";

// Themed number input with step buttons (native spinners are hidden globally
// in app.css). Local text while typing; onCommit fires on blur/Enter/step.
export function NumInput({ value, step = 1, min, title, width, onCommit }: {
  value: number;
  step?: number;
  min?: number;
  title?: string;
  width?: number;
  onCommit?: (v: number) => void;
}) {
  const [txt, setTxt] = useState(String(value));
  useEffect(() => setTxt(String(value)), [value]);

  const parsed = () => {
    const n = parseFloat(txt);
    return Number.isFinite(n) ? n : 0;
  };
  const clamp = (n: number) => (min != null && n < min ? min : n);
  const commit = (n: number) => {
    const v = clamp(n);
    setTxt(String(v));
    if (v !== value) onCommit?.(v);
  };

  return (
    <span className="num-input" style={width ? { width } : undefined} title={title}>
      <input
        inputMode="decimal"
        value={txt}
        onChange={(e) => setTxt(e.target.value)}
        onBlur={() => commit(parsed())}
        onKeyDown={(e) => e.key === "Enter" && commit(parsed())}
      />
      <span className="steps">
        <button type="button" tabIndex={-1} aria-label="increase" onClick={() => commit(clamp(parsed() + step))}><Icon name="chevron-up" size={10} /></button>
        <button type="button" tabIndex={-1} aria-label="decrease" onClick={() => commit(clamp(parsed() - step))}><Icon name="chevron-down" size={10} /></button>
      </span>
    </span>
  );
}
