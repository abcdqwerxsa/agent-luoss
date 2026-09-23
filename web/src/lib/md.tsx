// Markdown renderer for assistant messages.
// react-markdown renders to React elements only (no innerHTML) — XSS-safe;
// remark-gfm adds tables, strikethrough, task lists, autolinks.
// ```infographic fenced blocks are rendered inline as SVG via @antv/infographic
// (declarative DSL, no JS execution; lazy-loaded to keep the main bundle lean).
import React, { useEffect, useRef } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { GenerativeUIBlock } from "./genui";
import { Icon } from "./icons";

export function Markdown({ text }: { text: string }) {
  return (
    <div className="md">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          a: ({ href, children }) => {
            // knowledge base source citations: [doc:xxx] preprocessed to #kb-doc-xxx
            if (href?.startsWith("#kb-doc-")) {
              const id = href.slice("#kb-doc-".length);
              return <span className="src-chip" title={`知识库文档 ${id}`}><Icon name="book" size={11} />{children}</span>;
            }
            return (
              <a href={href} target="_blank" rel="noreferrer noopener">{children}</a>
            );
          },
          pre: ({ children }) => {
            const child = React.Children.toArray(children)[0];
            if (React.isValidElement(child)) {
              const cls = String((child.props as any)?.className || "");
              if (cls.includes("language-infographic") || cls.includes("language-jsonui") || cls.includes("language-json-ui")) return <>{children}</>;
            }
            return <pre>{children}</pre>;
          },
          code: ({ className, children }) => {
            const m = /language-([\w-]+)/.exec(className || "");
            const lang = m?.[1];
            if (lang === "infographic") return <InfographicBlock dsl={String(children)} />;
            if (lang === "jsonui" || lang === "json-ui") {
              // react-markdown splits hyphenated info strings into lang+meta and
              // prepends the meta ("ui\n") to the code content — strip it.
              const body = lang === "json-ui" ? String(children).replace(/^ui\r?\n/, "") : String(children);
              return <GenerativeUIBlock code={body} />;
            }
            return <code className={className}>{children}</code>;
          },
        }}
      >
        {citeDocs(text)}
      </ReactMarkdown>
    </div>
  );
}

// citeDocs turns [doc:xxx] citation markers into markdown links rendered as
// source chips by the <a> override above.
function citeDocs(text: string): string {
  return text.replace(/\[doc:([A-Za-z0-9_]+)\]/g, (_m, id: string) => `[📄 ${id.slice(-8)}](#kb-doc-${id})`);
}

function InfographicBlock({ dsl }: { dsl: string }) {
  const ref = useRef<HTMLDivElement>(null);
  const instRef = useRef<any>(null);
  const [failed, setFailed] = React.useState(false);
  useEffect(() => {
    if (!dsl.trim()) return;
    let disposed = false;
    // Reuse the instance across streaming deltas: official incremental mode
    // is render(buffer) repeatedly on the same instance.
    if (instRef.current) {
      try { instRef.current.render(dsl); } catch { setFailed(true); }
      return;
    }
    import("@antv/infographic").then(({ Infographic }) => {
      if (disposed || !ref.current) return;
      try {
        instRef.current = new Infographic({ container: ref.current, width: "100%", padding: 16 });
        instRef.current.render(dsl);
      } catch {
        setFailed(true);
      }
    }).catch(() => setFailed(true));
    return () => { disposed = true; };
  }, [dsl]);
  useEffect(() => () => { try { instRef.current?.destroy?.(); } catch { /* noop */ } }, []);
  if (failed) {
    return <pre className="infographic-fallback">{dsl}</pre>;
  }
  return <div className="infographic-block card" ref={ref} />;
}
