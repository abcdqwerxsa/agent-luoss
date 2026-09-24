import { useCallback, useState, type ReactNode } from "react";

/* Adapted from Beautiful UI CodeBlock / Diff */
const KEYWORDS = new Set([
  "import", "from", "export", "default", "async", "function", "const", "let", "var",
  "await", "return", "if", "else", "for", "while", "new", "throw", "try", "catch",
  "null", "true", "false", "undefined", "type", "interface", "class", "package", "func"
]);

const TOKEN_RE = /("(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|`[^`]*`|\b\d+(?:\.\d+)?\b|\b(?:import|from|export|default|async|function|const|let|var|await|return|if|else|for|while|new|throw|try|catch|null|true|false|undefined|type|interface|class|package|func)\b|[A-Za-z_$][\w$]*(?=\s*\())/g;

function highlight(text: string): ReactNode[] {
  const nodes: ReactNode[] = [];
  let last = 0;
  let k = 0;
  for (const m of text.matchAll(TOKEN_RE)) {
    const idx = m.index ?? 0;
    const t = m[0];
    if (idx > last) nodes.push(<span key={k++}>{text.slice(last, idx)}</span>);
    let color: string;
    let weight: number | undefined;
    if (/^["'`]/.test(t) || /^\d/.test(t)) {
      color = "var(--code-str, #f59e0b)";
    } else if (KEYWORDS.has(t)) {
      color = "var(--accent, #38bdf8)";
    } else {
      color = "var(--text-1, #f1f5f9)";
      weight = 500;
    }
    nodes.push(<span key={k++} style={{ color, fontWeight: weight }}>{t}</span>);
    last = idx + t.length;
  }
  if (last < text.length) nodes.push(<span key={k++}>{text.slice(last)}</span>);
  return nodes;
}

export function CodeBlock({
  code,
  language,
  filename,
}: {
  code: string;
  language?: string;
  filename?: string;
}) {
  const [copied, setCopied] = useState(false);
  const raw = code.replace(/\r?\n$/, "");
  const lines = raw.split("\n");
  const isDiff = language === "diff" || (lines.some((l) => l.startsWith("+")) && lines.some((l) => l.startsWith("-")));

  const copy = useCallback(() => {
    navigator.clipboard.writeText(raw).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1600);
    }).catch(() => {});
  }, [raw]);

  const title = filename || language || "code";

  return (
    <div className="code-block-card">
      <div className="code-block-head">
        <span className="code-block-title">
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="code-icon">
            <polyline points="16 18 22 12 16 6" />
            <polyline points="8 6 2 12 8 18" />
          </svg>
          <span className="mono">{title}</span>
        </span>
        <button
          type="button"
          aria-label="复制代码"
          onClick={copy}
          className={`code-copy-btn ${copied ? "copied" : ""}`}
        >
          {copied ? (
            <>
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                <polyline points="20 6 9 17 4 12" />
              </svg>
              <span>已复制</span>
            </>
          ) : (
            <>
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <rect x="9" y="9" width="13" height="13" rx="2" ry="2" />
                <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
              </svg>
              <span>复制</span>
            </>
          )}
        </button>
      </div>

      <div className="code-block-body">
        {lines.map((line, i) => {
          let lineType: "normal" | "add" | "del" | "hunk" = "normal";
          if (isDiff) {
            if (line.startsWith("+")) lineType = "add";
            else if (line.startsWith("-")) lineType = "del";
            else if (line.startsWith("@@")) lineType = "hunk";
          }
          return (
            <div key={i} className={`code-line ${lineType !== "normal" ? `line-${lineType}` : ""}`}>
              <span className="code-line-num select-none">{i + 1}</span>
              <code className="code-line-content">
                {isDiff ? line : highlight(line)}
              </code>
            </div>
          );
        })}
      </div>
    </div>
  );
}
