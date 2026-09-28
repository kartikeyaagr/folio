import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';

/**
 * Class joiner for the shadcn/Base UI primitives in `components/primitives/`.
 *
 * It lives in `app/_lib/` rather than `lib/` deliberately. `lib/` is imported by the standalone
 * `tsx` jobs as well as the app, and an eslint rule keeps it free of anything web-only; a class
 * merger is web-only by definition. `components/ui.tsx` keeps its own two-line `btnClass` for the
 * Folio kit — this is for the vendored primitives, whose upstream source expects `cn`.
 */
export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}
