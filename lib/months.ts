/**
 * The month as this system spells it: three letters, every month.
 *
 * `Intl` names September "Sept" under en-IN and en-GB and "Sep" under en-US, so a formatter that
 * lets `Intl` spell the month picks a dialect by accident. By 18-Sep-2026, nine page-local copies
 * had drifted into three locales, and "Sept" beside "Sep" makes a column of dates ragged. Every
 * date the app shows reads its parts from `Intl` and spells the month from here: the formatters in
 * components/ui.tsx, and a filed document's name in lib/files.ts, which sits in the same row as one
 * of them.
 */
export const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'] as const;
