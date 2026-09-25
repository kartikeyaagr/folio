/**
 * What fills the pane while a page is being built.
 *
 * Every page in this group is `force-dynamic` and awaits a `Promise.all` of live queries before it
 * returns a byte — `/admin` issues eight. Until this file existed there was no pending affordance
 * anywhere in the tree, so a click held the *previous* screen, unchanged and fully interactive,
 * for as long as Postgres took. A page that looks finished while it is still loading is the one
 * state a reader cannot tell from a page that is finished.
 *
 * A skeleton, not a spinner, because the design system says so and gives the reason: the shape
 * standing in for the content is itself information about what is coming. Three rows, because the
 * shared shape across these screens is a header and a list — matching each page exactly would mean
 * a file per route that drifts the moment a column moves.
 *
 * It is not a `<Blank>`. `<Blank why="…">` means the system declined to answer; this means it has
 * not answered yet, and conflating the two would teach the hatch to mean "wait".
 */
export default function Loading() {
  return (
    <div className="skel" aria-busy="true" aria-live="polite">
      <span className="sr-only">Loading</span>
      <div className="skel-head">
        <div className="skel-bar skel-title" />
        <div className="skel-bar skel-sub" />
      </div>
      <div className="skel-rows">
        <div className="skel-row" />
        <div className="skel-row" />
        <div className="skel-row" />
      </div>
    </div>
  );
}
