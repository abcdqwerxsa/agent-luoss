// Tiny markdown-subset renderer producing React elements.
// XSS-safe by construction: no HTML pass-through, links not clickable.
import React from "react";

function inline(text: string, key: string): React.ReactNode[] {
  const parts: React.ReactNode[] = [];
  const re = /(\*\*[^*]+\*\*|`[^`]+`)/g;
  let last = 0, m: RegExpExecArray | null, i = 0;
  while ((m = re.exec(text)) !== null) {
    if (m.index > last) parts.push(text.slice(last, m.index));
    const tok = m[0];
    if (tok.startsWith("**")) parts.push(<strong key={`${key}-b${i}`}>{tok.slice(2, -2)}</strong>);
    else parts.push(<code key={`${key}-c${i}`}>{tok.slice(1, -1)}</code>);
    last = m.index + tok.length;
    i++;
  }
  if (last < text.length) parts.push(text.slice(last));
  return parts;
}

export function Markdown({ text }: { text: string }) {
  const lines = text.split("\n");
  const out: React.ReactNode[] = [];
  let code: string[] | null = null;
    let list: string[] | null = null;

  const flushList = () => {
    if (list) {
      out.push(<ul key={`ul-${out.length}`}>{list.map((li, i) => <li key={i}>{inline(li, `li${i}`)}</li>)}</ul>);
      list = null;
    }
  };

  lines.forEach((line, idx) => {
    if (line.trim().startsWith("```")) {
      if (code) {
        out.push(<pre key={`pre-${idx}`}><code>{(code as string[]).join("\n")}</code></pre>);
        code = null;
      } else {
        flushList();
        code = [];
      }
      return;
    }
    if (code) { code.push(line); return; }
    const liMatch = line.match(/^\s*[-*]\s+(.*)/);
    if (liMatch) {
      if (!list) list = [];
      list.push(liMatch[1]);
      return;
    }
    flushList();
    const h = line.match(/^(#{1,4})\s+(.*)/);
    if (h) {
      const level = h[1].length;
      const Tag = (["h3", "h4", "h5", "h6"] as const)[level - 1];
      out.push(<Tag key={`h-${idx}`}>{inline(h[2], `h${idx}`)}</Tag>);
      return;
    }
    if (line.trim() === "") { out.push(<div key={`sp-${idx}`} className="md-space" />); return; }
    out.push(<p key={`p-${idx}`}>{inline(line, `p${idx}`)}</p>);
  });
  if (code) out.push(<pre key="pre-last"><code>{(code as string[]).join("\n")}</code></pre>);
  flushList();
  return <div className="md">{out}</div>;
}
