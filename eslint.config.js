// Two rules here are load-bearing, both from the v3 engineering review (D5).
//
// 1. `lib/` is imported by BOTH the Next.js app and the standalone tsx jobs. A `next/*`
//    import inside lib/ compiles fine for the web app and dies at runtime in a job. v2 got
//    this guarantee for free because its services were Python and physically could not
//    import TypeScript; the one-package decision removes that, so a lint rule replaces it.
//
// 2. The 300-line cap exists because v2's `lib/pipeline.ts` reached 2,007 lines. There was
//    no boundary between fetching and rendering, so one file absorbed both.
import tseslint from 'typescript-eslint';

export default tseslint.config(
  { ignores: ['.next/**', 'node_modules/**'] },
  ...tseslint.configs.recommended,
  {
    files: ['lib/**/*.ts'],
    rules: {
      'no-restricted-imports': ['error', {
        patterns: [{
          group: ['next', 'next/*', 'server-only'],
          message: 'lib/ is imported by the tsx jobs, which have no Next runtime. Keep Next imports in app/.',
        }],
      }],
      'max-lines': ['warn', { max: 300, skipBlankLines: true, skipComments: true }],
    },
  },
);
