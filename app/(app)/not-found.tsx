/**
 * A missing row, for somebody who is signed in.
 *
 * Separate from `app/not-found.tsx` for one reason: a boundary inside this group renders inside
 * this group's layout, so the rail survives. A mistyped ticker should leave the reader one click
 * from where they were rather than dropping them out of the product — and every `notFound()` call
 * site in the tree (`/company/[symbol]`, `/doc/[id]`, `/news/brief/[id]`) is behind this layout.
 *
 * The root copy still covers an unmatched URL typed by somebody with no session, where there is no
 * rail to render and nothing to go back to.
 */
import { Failure } from '@/components/Failure.tsx';

export default function NotFound() {
  return (
    <Failure eyebrow="Not found" title="There is nothing at that address.">
      <p>
        Either the link is wrong, or it points at something the system does not hold — a symbol the
        fund does not follow, or a document that has been deleted. Nothing failed; there is no row
        behind it.
      </p>
      <p>
        If it is a name you want followed, <a href="/companies">Companies</a> is where it is added.
      </p>
    </Failure>
  );
}
