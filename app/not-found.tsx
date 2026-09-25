/**
 * An address with nothing at it.
 *
 * A server component, unlike the two error boundaries — `notFound()` is a control-flow signal
 * rather than a caught exception, so this needs no client runtime and costs the tree nothing.
 *
 * Reached two ways, and they read the same to the person: a URL that matches no route at all, and
 * an explicit `notFound()` from `/company/[symbol]`, `/doc/[id]` or `/news/brief/[id]` when the row
 * is not there. The copy therefore names the likeliest cause — a symbol nobody follows — without
 * asserting it, because a typo'd URL is the other half of the traffic here.
 */
import { Failure } from '@/components/Failure.tsx';

export default function NotFound() {
  return (
    <Failure eyebrow="Not found" title="There is nothing at that address.">
      <p>
        Either the link is wrong, or it points at something this system does not hold — a symbol the
        fund does not follow, or a document that was deleted. Nothing failed; there is simply no row
        behind it.
      </p>
    </Failure>
  );
}
