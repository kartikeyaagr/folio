/**
 * The only plugin, and the only reason this file exists: Tailwind v4 is a PostCSS plugin now, with
 * no `tailwind.config.js` beside it — the theme is declared in CSS, in `app/tailwind.css`.
 *
 * Adding this file turns PostCSS on for the whole app. Nothing else is registered here on purpose:
 * autoprefixer is not needed (Next's compiler targets browserslist itself) and a second plugin
 * would be a second thing deciding what the CSS means.
 */
export default {
  plugins: ['@tailwindcss/postcss'],
};
