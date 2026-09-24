import { useMemo } from "react";

/* Adapted from Beautiful UI "Diff Table" (MIT License, © 2026 Shane Levine,
 * https://www.beautifului.dev/). The showcase renders records add/remove
 * rows; agent-luoss renders unified diffs from edit tool output in the same
 * visual language (green adds, red removals, muted hunk headers). */
type Line = { kind: "add" | "del" | "hunk" | "ctx"; text: string };

export default function DiffView({ diff }: { diff: string }) {
  const lines = useMemo<Line[]>(() => {
    const out: Line[] = [];
    for (const raw of diff.split("\n")) {
      if (raw.startsWith("@@")) out.push({ kind: "hunk", text: raw });
      else if (raw.startsWith("+")) out.push({ kind: "add", text: raw });
      else if (raw.startsWith("-")) out.push({ kind: "del", text: raw });
      else out.push({ kind: "ctx", text: raw });
    }
    return out.slice(0, 400); // ponytail: cap very large diffs in the UI
  }, [diff]);
  if (!lines.some((l) => l.kind === "add" || l.kind === "del")) return null;
  return (
    <div className="bui diffview font-mono text-[11.5px] leading-[1.7]">
      {lines.map((l, i) => (
        <div key={i} className={`d-row d-${l.kind}`}>
          {l.text || " "}
        </div>
      ))}
    </div>
  );
}
