import React, { useEffect, useRef } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { GenerativeUIBlock } from "./genui";
import { Icon } from "./icons";
import { ErrorBoundary } from "../components/ErrorBoundary";

export function Markdown({ text }: { text: string }) {
  return (
    <div className="md">
      <ErrorBoundary fallback={<pre className="toolout" style={{ whiteSpace: "pre-wrap" }}>{text}</pre>}>
        <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          a: ({ href, children }) => {
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
              const childContent = String((child.props as any)?.children || "");
              const isGenUi = cls.includes("language-jsonui") || cls.includes("language-json-ui") ||
                (cls.includes("language-json") && (/^\s*\{\s*"op"\s*:/.test(childContent) || (childContent.includes('"root"') && childContent.includes('"elements"'))));
              if (cls.includes("language-infographic") || isGenUi) return <>{children}</>;
            }
            return <pre>{children}</pre>;
          },
          code: ({ className, children }) => {
            const m = /language-([\w-]+)/.exec(className || "");
            const lang = m?.[1];
            const codeStr = String(children);
            if (lang === "infographic") return <InfographicBlock dsl={codeStr} />;
            const isGenUi = lang === "jsonui" || lang === "json-ui" ||
              (lang === "json" && (/^\s*\{\s*"op"\s*:/.test(codeStr) || (codeStr.includes('"root"') && codeStr.includes('"elements"'))));
            if (isGenUi) {
              const body = codeStr.replace(/^(?:ui|json-?ui)\r?\n/, "");
              return <GenerativeUIBlock code={body} />;
            }
            return <code className={className}>{children}</code>;
          },
        }}
      >
        {citeDocs(text)}
      </ReactMarkdown>
      </ErrorBoundary>
    </div>
  );
}

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
    if (instRef.current) {
      try { instRef.current.render(dsl); setFailed(false); } catch { /* 容错 */ }
      return;
    }
    import("@antv/infographic").then(({ Infographic }) => {
      if (disposed || !ref.current) return;
      try {
        instRef.current = new Infographic({ container: ref.current, width: "100%", padding: 16 });
        instRef.current.render(dsl);
        setFailed(false);
      } catch {
        /* 流式中暂不设失败 */
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
