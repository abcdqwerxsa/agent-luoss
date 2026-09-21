import { useLayoutEffect, useRef, useState, type ReactNode } from "react";

/* Ported from Beautiful UI "Thinking" + "Tool Chips" (MIT License,
 * © 2026 Shane Levine, https://www.beautifului.dev/) — expandable agent
 * trace with timeline rows; rows carrying `detail` are clickable and expand
 * inline (the Tool Chips row-expand pattern). Controlled `working` prop
 * drives the shimmer header; rows and details come from real task events. */
export interface TraceRow {
  primary: string;
  secondary?: string;
  mono?: boolean;
  detail?: ReactNode;
}

export default function ThinkingTrace({
  rows,
  active = "执行中",
  done = "执行轨迹",
  working = false,
  children,
}: {
  rows: TraceRow[];
  active?: string;
  done?: string;
  working?: boolean;
  children?: ReactNode;
}) {
  const [manualExpanded, setManualExpanded] = useState<boolean | null>(null);
  const [openRows, setOpenRows] = useState<Set<number>>(new Set());
  const expanded = manualExpanded ?? working;
  const traceRef = useRef<HTMLDivElement>(null);
  const [lineHeight, setLineHeight] = useState(0);
  useLayoutEffect(() => {
    if (traceRef.current) setLineHeight(traceRef.current.offsetHeight);
  }, [expanded, rows.length]);

  return (
    <div className="bui flex w-full flex-col">
      {/* header */}
      <button
        type="button"
        aria-expanded={expanded}
        onClick={() => setManualExpanded((current) => !(current ?? working))}
        className="-mx-1.5 flex w-fit items-center gap-2 rounded-control px-1.5 py-1 transition-colors duration-100 hover:bg-hover-2"
      >
        <svg width="16" height="16" viewBox="0 0 24 24" fill={working ? "var(--ink-2)" : "var(--ink-3)"}>
          <path d="M12 2l2.4 7.2L22 12l-7.6 2.8L12 22l-2.4-7.2L2 12l7.6-2.8z" />
        </svg>
        <span role="status" className="contents">
          {working ? (
            <span
              className="bg-clip-text text-[13px] font-medium whitespace-nowrap text-transparent"
              style={{
                backgroundImage: "linear-gradient(90deg, var(--ink-3) 35%, var(--ink) 50%, var(--ink-3) 65%)",
                backgroundSize: "200% 100%",
                animation: "shimmer-text 1.4s linear infinite",
              }}
            >
              {active}
            </span>
          ) : (
            <span className="text-[13px] font-medium whitespace-nowrap text-ink-2" style={{ animation: "fade-in 350ms ease-out both" }}>
              {done}
            </span>
          )}
        </span>
        <svg
          width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="var(--ink-3)" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"
          className="transition-transform duration-300"
          style={{ transform: expanded ? "rotate(180deg)" : "rotate(0)" }}
        >
          <path d="M6 9l6 6 6-6" />
        </svg>
      </button>

      {/* expandable trace */}
      <div
        className="grid transition-[grid-template-rows,opacity] duration-400"
        style={{ gridTemplateRows: expanded ? "1fr" : "0fr", opacity: expanded ? 1 : 0, transitionTimingFunction: "cubic-bezier(0.23, 1, 0.32, 1)" }}
      >
        <div className="overflow-hidden">
          <div className="relative mt-1 ml-[5px] pl-4">
            <span
              aria-hidden
              className="absolute left-[3px] w-px bg-line"
              style={{ top: -8, height: lineHeight ? lineHeight - 2 : 0, transition: "height 500ms cubic-bezier(0.23,1,0.32,1)" }}
            />
            <div ref={traceRef} className="flex flex-col gap-1 py-1">
              {rows.map((row, i) => {
                const hasDetail = row.detail !== undefined;
                const rowOpen = openRows.has(i);
                const inner = (
                  <>
                    {i < rows.length - 1 || !working ? (
                      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="var(--ink-3)" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" className="shrink-0">
                        <path d="M20 6L9 17l-5-5" />
                      </svg>
                    ) : (
                      <span className="size-3 shrink-0 rounded-full border-[1.5px] border-line-strong border-t-ink-2" style={{ animation: "spin 700ms linear infinite" }} />
                    )}
                    <span className="min-w-0 truncate text-[12.5px] font-medium text-ink">{row.primary}</span>
                    {row.secondary && (
                      <span className={`shrink-0 text-[11.5px] text-ink-3 ${row.mono ? "font-mono" : ""}`}>{row.secondary}</span>
                    )}
                    {hasDetail && (
                      <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="var(--ink-3)" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" className="ml-auto shrink-0 transition-transform duration-200" style={{ transform: rowOpen ? "rotate(0deg)" : "rotate(-90deg)" }}>
                        <path d="M6 9l6 6 6-6" />
                      </svg>
                    )}
                  </>
                );
                return (
                  <div key={`${row.primary}-${i}`} className="flex flex-col">
                    <div
                      role={hasDetail ? "button" : undefined}
                      tabIndex={hasDetail ? 0 : undefined}
                      onClick={hasDetail ? () => setOpenRows((cur) => { const n = new Set(cur); n.has(i) ? n.delete(i) : n.add(i); return n; }) : undefined}
                      className={`flex min-h-7 w-full items-center gap-2 rounded-[6px] px-1.5 py-0.5 text-left ${hasDetail ? "cursor-pointer transition-colors duration-150 hover:bg-hover" : ""}`}
                      style={{ animation: `fade-up 320ms cubic-bezier(0.23,1,0.32,1) ${Math.min(i, 6) * 120}ms both` }}
                    >
                      {inner}
                    </div>
                    {hasDetail && rowOpen && (
                      <div className="ml-6 pb-1" style={{ animation: "fade-in 200ms ease-out both" }}>
                        {row.detail}
                      </div>
                    )}
                  </div>
                );
              })}
              {children}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
