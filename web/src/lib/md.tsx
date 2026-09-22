// Markdown renderer for assistant messages.
// react-markdown renders to React elements only (no innerHTML) — XSS-safe;
// remark-gfm adds tables, strikethrough, task lists, autolinks.
// ```infographic fenced blocks are rendered inline as SVG via @antv/infographic
// (declarative DSL, no JS execution; lazy-loaded to keep the main bundle lean).
import React, { useEffect, useRef } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

export function Markdown({ text }: { text: string }) {
  return (
    <div className="md">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          a: ({ href, children }) => (
            <a href={href} target="_blank" rel="noreferrer noopener">{children}</a>
          ),
          pre: ({ children }) => {
            const child = React.Children.toArray(children)[0];
            if (React.isValidElement(child) && String((child.props as any)?.className || "").includes("language-infographic")) {
              return <>{children}</>;
            }
            return <pre>{children}</pre>;
          },
          code: ({ className, children }) => {
            const lang = /language-(\w+)/.exec(className || "")?.[1];
            if (lang === "infographic") return <InfographicBlock dsl={String(children)} />;
            return <code className={className}>{children}</code>;
          },
        }}
      >
        {text}
      </ReactMarkdown>
    </div>
  );
}

function InfographicBlock({ dsl }: { dsl: string }) {
  const ref = useRef<HTMLDivElement>(null);
  const [failed, setFailed] = React.useState(false);
  useEffect(() => {
    if (!dsl.trim()) return;
    let disposed = false;
    let inst: any;
    import("@antv/infographic").then(({ Infographic }) => {
      if (disposed || !ref.current) return;
      try {
        inst = new Infographic({ container: ref.current, width: "100%", padding: 16 });
        inst.render(dsl);
      } catch {
        setFailed(true);
      }
    }).catch(() => setFailed(true));
    return () => { disposed = true; try { inst?.destroy?.(); } catch { /* noop */ } };
  }, [dsl]);
  if (failed) {
    return <pre className="infographic-fallback">{dsl}</pre>;
  }
  return <div className="infographic-block card" ref={ref} />;
}
