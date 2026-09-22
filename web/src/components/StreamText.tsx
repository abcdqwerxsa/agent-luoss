/* Ported from Beautiful UI "Streaming Text" (MIT License, © 2026 Shane Levine,
 * https://www.beautifului.dev/) — words resolve out of blur as they stream in.
 * The showcase loop/citations are dropped; words mount as SSE delivers them
 * and each new word animates in on mount. */
export default function StreamText({ text }: { text: string }) {
  const tokens = text.split(/(\s+)/);
  return (
    <p className="bui m-0 whitespace-pre-wrap text-[13px] leading-relaxed text-ink">
      {tokens.map((tok, i) =>
        tok.trim() ? (
          <span key={i} className="st-word">
            {tok}
          </span>
        ) : (
          tok
        ),
      )}
    </p>
  );
}
