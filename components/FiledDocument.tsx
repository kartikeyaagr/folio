/**
 * The document the company published, as the company published it.
 *
 * This used to render `DocumentText` — this system's extraction of the PDF, with a find box over
 * it. The extraction is real work and it stays: it is what the agents read, what `/chat` searches,
 * and the only reason the corpus can answer a question about a call. It is the wrong thing to hand
 * a person. A transcript's tables arrive as runs of numbers with the columns gone, a deck extracts
 * to captions with no slides, and every one of them drops the exchange's letterhead — so a reader
 * checking a figure against "the filing" was checking it against a lossy copy.
 *
 * `<object>` rather than `<iframe>`: it takes a `<p>` fallback for a browser with no PDF viewer,
 * where an iframe would show an empty box. The `Range`-capable route behind it streams, so opening
 * a 22MB annual report does not wait for 22MB.
 */
export function FiledDocument({ sha, label }: { sha: string; label: string }) {
  const href = `/api/attachment/${sha}`;
  return (
    <div className="doc-file">
      <object data={href} type="application/pdf" className="doc-file-view" aria-label={label}>
        <p className="picker-none">
          This browser will not display a PDF in the page.{' '}
          <a href={href} target="_blank" rel="noreferrer">Open {label}</a> instead.
        </p>
      </object>
    </div>
  );
}
