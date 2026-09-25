/**
 * The screen for the two things that are not a `<Blank>`: the system broke, or there is nothing
 * at that address.
 *
 * `<Blank why="…">` is for a question the system **declines** to answer, and the design system is
 * explicit that it must not be reused for anything else. A thrown exception and a missing row are
 * both failures, not declinations, so they get their own shape — but they keep the same manner:
 * say what happened, say it in a sentence, and never show a number that could be read as a fact.
 *
 * Deliberately imports nothing. `app/error.tsx` and `app/global-error.tsx` must carry
 * `'use client'` because Next's API requires it, and anything they import is pulled into the
 * client bundle with them — importing `components/ui.tsx` here would drag `CompanySearch` and the
 * whole kit across that boundary to render a heading and a link.
 *
 * The recovery action is a plain `<a>`, not `next/link`. After an error the router's own state is
 * the thing least worth trusting; a full document load is the one navigation that cannot fail the
 * same way twice.
 */
export function Failure({
  eyebrow,
  title,
  children,
  action,
}: {
  eyebrow: string;
  title: string;
  children: React.ReactNode;
  action?: React.ReactNode;
}) {
  return (
    <main className="failure">
      <div className="failure-card">
        <span className="failure-mark">T</span>
        <p className="failure-eyebrow">{eyebrow}</p>
        <h1 className="failure-title">{title}</h1>
        <div className="failure-why">{children}</div>
        <div className="failure-acts">
          {action}
          <a className="failure-act" href="/">
            Back to the desk
          </a>
        </div>
      </div>
    </main>
  );
}
