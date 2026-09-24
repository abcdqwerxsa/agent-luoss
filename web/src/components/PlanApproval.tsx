/* Adapted from Beautiful UI "Approval Card" (MIT License, © 2026 Shane Levine,
 * https://www.beautifului.dev/) — human-in-the-loop card shell with pill
 * actions (quiet revise, accent confirm with ⏎). agent-luoss shows it after a
 * plan-mode turn settles; confirm sends a canned approval message. */
export default function PlanApproval({ onConfirm, onRevise }: { onConfirm: () => void; onRevise: () => void }) {
  return (
    <div className="bui plan-approval" style={{ animation: "fade-up 320ms cubic-bezier(0.23,1,0.32,1) both" }}>
      <div className="pa-head">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="var(--ink-2)">
          <path d="M12 2l2.4 7.2L22 12l-7.6 2.8L12 22l-2.4-7.2L2 12l7.6-2.8z" />
        </svg>
        <span className="text-[13px] font-medium text-ink-2">计划已生成，是否执行？</span>
      </div>
      <div className="pa-actions">
        <button type="button" className="pa-btn ghost" onClick={onRevise}>
          继续调整
        </button>
        <button type="button" className="pa-btn accent" onClick={onConfirm}>
          确认执行
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M6 9l6 6 6-6" transform="rotate(-90 12 12)" />
          </svg>
        </button>
      </div>
    </div>
  );
}
