import { useLayoutEffect, useRef, useState, type ReactNode } from "react";

export interface TraceRow {
  primary: string;
  chip?: string;
  secondary?: string;
  mono?: boolean;
  tool?: string;
  detail?: ReactNode;
}

const ToolIcons: Record<string, ReactNode> = {
  think: (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="currentColor">
      <path d="M12 2l2.4 7.2L22 12l-7.6 2.8L12 22l-2.4-7.2L2 12l7.6-2.8z" />
    </svg>
  ),
  write: (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M17 3a2.8 2.8 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5z" />
    </svg>
  ),
  edit: (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7" />
      <path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z" />
    </svg>
  ),
  run: (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <polyline points="4 17 10 11 4 5" />
      <line x1="12" y1="19" x2="20" y2="19" />
    </svg>
  ),
  read: (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
      <polyline points="14 2 14 8 20 8" />
    </svg>
  ),
  search: (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="11" cy="11" r="8" />
      <line x1="21" y1="21" x2="16.65" y2="16.65" />
    </svg>
  ),
  default: (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="12" cy="12" r="3" />
      <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z" />
    </svg>
  ),
};

function getToolIcon(name: string = ""): ReactNode {
  const n = name.toLowerCase();
  if (n.includes("think")) return ToolIcons.think;
  if (n.includes("write") || n.includes("create")) return ToolIcons.write;
  if (n.includes("edit") || n.includes("replace") || n.includes("patch")) return ToolIcons.edit;
  if (n.includes("run") || n.includes("bash") || n.includes("command") || n.includes("exec")) return ToolIcons.run;
  if (n.includes("read") || n.includes("view") || n.includes("cat")) return ToolIcons.read;
  if (n.includes("search") || n.includes("grep") || n.includes("find")) return ToolIcons.search;
  return ToolIcons.default;
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
    if (!traceRef.current) return;
    const updateHeight = () => {
      if (traceRef.current) setLineHeight(traceRef.current.offsetHeight);
    };
    updateHeight();
    const ro = new ResizeObserver(updateHeight);
    ro.observe(traceRef.current);
    return () => ro.disconnect();
  }, [expanded, rows.length]);

  return (
    <div className="bui flex w-full flex-col thinking-trace-wrap">
      {/* 展开/收起 触发器 */}
      <button
        type="button"
        aria-expanded={expanded}
        onClick={() => setManualExpanded((current) => !(current ?? working))}
        className="trace-trigger flex w-fit items-center gap-2 rounded-control px-2 py-1 transition-colors duration-150 hover:bg-hover-2"
      >
        <span className="trace-trigger-icon flex shrink-0 items-center justify-center">
          <svg width="15" height="15" viewBox="0 0 24 24" fill={working ? "var(--accent)" : "var(--ink-3)"}>
            <path d="M12 2l2.4 7.2L22 12l-7.6 2.8L12 22l-2.4-7.2L2 12l7.6-2.8z" />
          </svg>
        </span>
        <span role="status" className="contents">
          {working ? (
            <span
              className="trace-active-text bg-clip-text text-[13px] font-medium whitespace-nowrap text-transparent"
              style={{
                backgroundImage: "linear-gradient(90deg, var(--ink-3) 30%, var(--accent) 50%, var(--ink-3) 70%)",
                backgroundSize: "200% 100%",
                animation: "shimmer-text 1.4s linear infinite",
              }}
            >
              {active}
            </span>
          ) : (
            <span className="text-[13px] font-medium whitespace-nowrap text-ink-2" style={{ animation: "fade-in 300ms ease-out both" }}>
              {done}
            </span>
          )}
        </span>
        <svg
          width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="var(--ink-3)" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"
          className="transition-transform duration-300"
          style={{ transform: expanded ? "rotate(180deg)" : "rotate(0)" }}
        >
          <path d="M6 9l6 6 6-6" />
        </svg>
      </button>

      {/* 轨迹与思考细节 */}
      <div
        className="grid transition-[grid-template-rows,opacity] duration-300"
        style={{ gridTemplateRows: expanded ? "1fr" : "0fr", opacity: expanded ? 1 : 0, transitionTimingFunction: "cubic-bezier(0.23, 1, 0.32, 1)" }}
      >
        <div className="overflow-hidden">
          <div className="relative mt-1 ml-[6px] pl-4">
            <span
              aria-hidden
              className="absolute left-[3px] w-px bg-line"
              style={{ top: -6, height: lineHeight ? lineHeight - 2 : 0, transition: "height 400ms cubic-bezier(0.23,1,0.32,1)" }}
            />
            <div ref={traceRef} className="flex flex-col gap-1.5 py-1.5">
              {children}
              {rows.map((row, i) => {
                const hasDetail = row.detail !== undefined;
                const rowOpen = openRows.has(i);
                const isDone = row.secondary === "完成";
                const isErr = row.secondary === "失败";
                const icon = getToolIcon(row.tool || row.primary);

                return (
                  <div key={`${row.primary}-${i}`} className="flex flex-col">
                    <div
                      role={hasDetail ? "button" : undefined}
                      tabIndex={hasDetail ? 0 : undefined}
                      onClick={hasDetail ? () => setOpenRows((cur) => { const n = new Set(cur); n.has(i) ? n.delete(i) : n.add(i); return n; }) : undefined}
                      className={`tool-chip-row flex min-h-7 w-full items-center gap-2 rounded-control px-2 py-1 text-left ${hasDetail ? "cursor-pointer transition-colors duration-150 hover:bg-hover" : ""}`}
                      style={{ animation: `fade-up 300ms cubic-bezier(0.23,1,0.32,1) ${Math.min(i, 6) * 80}ms both` }}
                    >
                      <span className="tool-icon-wrap flex size-4 shrink-0 items-center justify-center text-ink-3">
                        {icon}
                      </span>
                      <span className="min-w-0 truncate text-[12.5px] font-medium text-ink">
                        {row.primary}
                      </span>
                      {row.chip && (
                        <span className="tool-chip-param inline-flex h-5 max-w-64 min-w-0 items-center truncate rounded-[4px] bg-field px-1.5 font-mono text-[11px] text-ink-2 shadow-hairline">
                          {row.chip}
                        </span>
                      )}
                      {row.secondary && (
                        <span className={`shrink-0 text-[11px] ${isErr ? "text-red" : isDone ? "text-green" : "text-ink-3"}`}>
                          {isDone ? "✓ 完成" : row.secondary}
                        </span>
                      )}
                      {hasDetail && (
                        <svg
                          width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="var(--ink-3)" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"
                          className="ml-auto shrink-0 transition-transform duration-200"
                          style={{ transform: rowOpen ? "rotate(0deg)" : "rotate(-90deg)" }}
                        >
                          <path d="M6 9l6 6 6-6" />
                        </svg>
                      )}
                    </div>
                    {hasDetail && rowOpen && (
                      <div className="ml-6 pt-1 pb-2" style={{ animation: "fade-in 200ms ease-out both" }}>
                        {row.detail}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
