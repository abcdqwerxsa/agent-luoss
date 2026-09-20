// Markdown renderer for assistant messages.
// react-markdown renders to React elements only (no innerHTML) — XSS-safe;
// remark-gfm adds tables, strikethrough, task lists, autolinks.
import React from "react";
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
        }}
      >
        {text}
      </ReactMarkdown>
    </div>
  );
}
