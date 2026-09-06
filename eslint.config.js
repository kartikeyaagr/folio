// Three rules here are load-bearing.
//
// 1. `lib/` is imported by BOTH the Next.js app and the standalone tsx jobs. A `next/*` import
//    inside lib/ compiles fine for the web app and dies at runtime in a job. v2 got this
//    guarantee for free because its services were Python and physically could not import
//    TypeScript; the one-package decision removes that, so a lint rule replaces it.
//
// 2. The backend must be provable without the frontend. app/ may import lib/; lib/, jobs/ and
//    db/ may never import app/. One-way, so the backend can be built, tested and run with no UI
//    in the tree, and stays that way once the UI lands.
//
// 3. The 300-line cap exists because v2's `lib/pipeline.ts` reached 2,007 lines. There was no
//    boundary between fetching and rendering, so one file absorbed both.
//
// NOTE: `no-restricted-imports` is set once per matched path. Flat config is later-wins for the
// same rule name, so two blocks both matching `lib/**` silently drop the earlier one's patterns —
// which is exactly what happened on the first attempt, and the ban did not fire. Keep every
// pattern for a given path inside that path's single block.
import tseslint from 'typescript-eslint';

/** The backend never reaches for the UI. */
const noAppImports = {
  group: ['@/app', '@/app/**', '**/app/**'],
  message: 'The backend does not depend on the UI. app/ imports lib/, never the reverse.',
};

/** lib/ runs under raw tsx in the jobs, where there is no Next runtime. */
const noNextImports = {
  group: ['next', 'next/*', 'server-only'],
  message: 'lib/ is imported by the tsx jobs, which have no Next runtime. Keep Next imports in app/.',
};

export default tseslint.config(
  { ignores: ['.next/**', 'node_modules/**'] },
  ...tseslint.configs.recommended,
  {
    files: ['lib/**/*.ts'],
    rules: {
      'no-restricted-imports': ['error', { patterns: [noNextImports, noAppImports] }],
      'max-lines': ['warn', { max: 300, skipBlankLines: true, skipComments: true }],
    },
  },
  {
    files: ['jobs/**/*.ts', 'db/**/*.ts'],
    rules: {
      'no-restricted-imports': ['error', { patterns: [noAppImports] }],
    },
  },
);
