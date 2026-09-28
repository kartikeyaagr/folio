/**
 * Which agents a person may ask for work, and what each one has to be given.
 *
 * **The list is defined by what the handler reads off the run.** That is the only question that
 * matters here, and getting it wrong once already cost something: `/agents` used to filter on
 * `trigger = 'prompt'` — a statement about how an agent fires *unattended* — and so offered the
 * desk analyst, whose handler threw for want of a thread before it read anything. Every click
 * produced a run that failed three times with nothing recording what had asked for it.
 *
 * It began as two agents, because a form could offer a company and nothing else. `/chat` is now a
 * request desk with real subject pickers (`./subjects.ts`), so the two that need a specific filed
 * period or a specific transcript are askable too — the picker supplies the `subject_ref` their
 * sweeps supply, read from the same tables the sweeps read. All four model-calling agents are here.
 *
 * `email-workflow` and `reminders` are not, and not by oversight: they call no model and run on
 * their own schedule. There is nothing to ask them for — they drain the outbox and read what is
 * due — and nothing a person types should be doing either.
 *
 * This file imports nothing but types on purpose. Every handler module drags `prompt.ts` →
 * `exemplars.ts` → the 130 MB ONNX embedder in behind it; a page importing that is `v4.md §15`
 * finding 15, which cost a `next build`.
 */

/**
 * What the run must carry, which is exactly what the request desk must let somebody pick.
 *
 *   none                 the agent reads the whole followed universe
 *   company              `company_id`, and the handler reads what it needs off that
 *   fundamentals_period  a `subject_ref` naming one filed period
 *   transcript           a `subject_ref` naming one transcript document
 *
 * The last two are the subject their event sweeps enqueue. A picker offering anything else would
 * produce a run that claims, fails with `no fundamentals row null`, retries twice and lands under
 * "Failed runs" as something nobody meant to ask for.
 */
export type SubjectKind = 'none' | 'company' | 'fundamentals_period' | 'transcript';

export interface Invocable {
  subject: SubjectKind;
  /** One phrase, shown on the request desk under the agent's name. */
  what: string;
  /** What the picker's control is called, where there is one. */
  pick?: string;
}

export const INVOCABLE: Record<string, Invocable> = {
  'results-figures': {
    subject: 'fundamentals_period',
    what: 'Reads a filed results period and checks its figures against the filing.',
    pick: 'Which period',
  },
  'concall-insights': {
    subject: 'transcript',
    what: 'Reads an earnings call transcript against the previous one.',
    pick: 'Which call',
  },
  'forensics-review': {
    subject: 'company',
    what: "Works the 14-item forensic checklist against a company's annual filings.",
  },
  'news-brief': {
    subject: 'none',
    what: 'Briefs the desk on the last week: every followed name, then the major stories across ' +
      'the outlets.',
  },
};

/** Exported so a test can assert each of these is seeded, enabled and calls a model. */
export const INVOCABLE_KEYS = Object.keys(INVOCABLE);

/**
 * The check a server action runs before it enqueues anything.
 *
 * `agent_runs.agent_key` has a foreign key to `agents`, so a forged POST could never invent an
 * agent — and that is the whole extent of what a foreign key does here. It says the row exists; it
 * says nothing about whether the run can do any work.
 */
export const isInvocable = (key: string): boolean =>
  Object.prototype.hasOwnProperty.call(INVOCABLE, key);

/**
 * Whether a request carries what this agent's handler will go looking for.
 *
 * Returns the sentence to show the asker, or null when the request is complete. Said in the words
 * of the thing they were picking, because the alternative — letting it through and failing on the
 * queue twenty minutes later — is a dead end they could not have predicted from the button.
 */
export function missingSubject(
  key: string,
  companyId: string | null,
  subjectRef: string | null,
): string | null {
  const wanted = INVOCABLE[key];
  if (!wanted) return `${key} cannot be asked for work from here.`;
  switch (wanted.subject) {
    case 'none':
      return null;
    case 'company':
      return companyId ? null : 'Pick a company — this agent reads one company’s filings.';
    case 'fundamentals_period':
      return subjectRef ? null : 'Pick which filed period to read.';
    case 'transcript':
      return subjectRef ? null : 'Pick which call to read.';
  }
}
