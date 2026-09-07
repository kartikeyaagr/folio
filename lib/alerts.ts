/**
 * Raising alerts, and deciding who hears about them.
 *
 * Two rules, and the second is the one that is easy to get wrong:
 *
 *   * **Severity decides when.** critical and high interrupt; normal and low wait for the desk.
 *   * **Coverage decides who — except when nobody covers the name.** A company nobody has claimed
 *     is exactly the company whose alerts would otherwise go to an empty list and vanish, and an
 *     unclaimed name is more likely to be neglected, not less. So: critical goes to everyone
 *     always, everything else goes to whoever covers it, and an uncovered name goes to everyone.
 *     **Routing must never be able to make an alert disappear.**
 *
 * Deduplication is on `(rule_key, subject_ref)`, so re-evaluating an overlapping window raises
 * nothing twice and the evaluator needs no memory of what it last looked at.
 */

import { randomBytes } from 'node:crypto';
import { readTxn, serviceTxn, writeTxn, type Client } from './db.ts';

export type Severity = 'critical' | 'high' | 'normal' | 'low';

const id = (): string => randomBytes(16).toString('hex');

export interface RaiseInput {
  ruleKey: string;
  subjectRef: string;
  companyId: string | null;
  severity: Severity;
  title: string;
  detail?: string | null;
}

/**
 * Raise an alert and queue its notifications in the same transaction.
 *
 * One commit, deliberately: there must be no state where the alert exists and nobody was ever
 * going to be told, nor one where a mail is queued for an alert that was rolled back.
 *
 * Returns false when the alert already existed, which is the ordinary case on a re-run.
 */
export async function raiseAlert(c: Client, input: RaiseInput): Promise<boolean> {
  const alertId = id();
  const { rows } = await c.query<{ id: string }>(
    `INSERT INTO alerts (id, rule_key, company_id, severity, title, detail, subject_ref)
     VALUES ($1,$2,$3,$4,$5,$6,$7)
     ON CONFLICT (rule_key, subject_ref) DO NOTHING
     RETURNING id`,
    [alertId, input.ruleKey, input.companyId, input.severity, input.title, input.detail ?? null, input.subjectRef],
  );
  if (!rows[0]) return false;

  for (const userId of await recipients(c, input.companyId, input.severity)) {
    await c.query(
      `INSERT INTO notification_outbox (id, kind, recipient, subject, body, alert_id)
       VALUES ($1,'alert',$2,$3,$4,$5)`,
      [id(), userId, input.title, input.detail ?? input.title, alertId],
    );
  }
  return true;
}

/**
 * Who gets told.
 *
 * The uncovered case returning everyone is the whole safety property here, not a fallback.
 */
export async function recipients(
  c: Client,
  companyId: string | null,
  severity: Severity,
): Promise<string[]> {
  const everyone = async (): Promise<string[]> => {
    const { rows } = await c.query<{ id: string }>(
      'SELECT id FROM users WHERE disabled_at IS NULL ORDER BY id',
    );
    return rows.map((r) => r.id);
  };

  // Something that stops the fund is not one person's problem, and the covering analyst may be
  // on a plane.
  if (severity === 'critical' || companyId === null) return everyone();

  const { rows } = await c.query<{ covered_by: string | null }>(
    `SELECT covered_by FROM companies c
      WHERE c.id = $1
        AND EXISTS (SELECT 1 FROM users u WHERE u.id = c.covered_by AND u.disabled_at IS NULL)`,
    [companyId],
  );
  const coveredBy = rows[0]?.covered_by;
  return coveredBy ? [coveredBy] : everyone();
}

// ------------------------------------------------------------------------------------------------
// Evaluators
// ------------------------------------------------------------------------------------------------

export interface EvaluateResult {
  considered: number;
  raised: number;
}

/**
 * Match filings against the category rules.
 *
 * **Asks "what has no alert yet", not "what arrived recently."** The first version used a rolling
 * time window and silently dropped two AERON resignation filings that landed one day outside it —
 * the same class of failure the agent sweep exists to avoid. Dedup is already on
 * (rule_key, subject_ref), so a window buys nothing and can only lose things.
 *
 * `maxAgeDays` is a floor on history, not a cursor: it stops adding a company from dredging up
 * years of its old announcements. Anything inside it is considered on every run until it has been
 * matched or ruled out, so nothing can fall through a gap between runs.
 *
 * Only filings belonging to a followed company are considered. The feed carries every listed
 * company's filings, and alerting on all of them would be a stream nobody reads.
 */
export async function evaluateFilings(maxAgeDays = 60): Promise<EvaluateResult> {
  return serviceTxn('system:alerts', async (c) => {
    const { rows: rules } = await c.query<{
      key: string; severity: Severity; patterns: string[]; company_id: string | null;
    }>(
      `SELECT key, severity, patterns, company_id FROM alert_rules
        WHERE active AND kind = 'filing_category'`,
    );

    const { rows: filings } = await c.query<{
      id: string; company_id: string; symbol: string; category: string | null; subject: string | null;
    }>(
      `SELECT f.id, f.company_id, f.symbol, f.category, f.subject
         FROM filings f
        WHERE f.company_id IS NOT NULL
          AND f.announced_at > now() - ($1 || ' days')::interval
          AND NOT EXISTS (SELECT 1 FROM alerts a WHERE a.subject_ref = f.id)
        ORDER BY f.announced_at DESC`,
      [String(maxAgeDays)],
    );

    let raised = 0;
    for (const f of filings) {
      const haystack = `${f.category ?? ''} ${f.subject ?? ''}`.toLowerCase();
      for (const rule of rules) {
        if (rule.company_id !== null && rule.company_id !== f.company_id) continue;
        if (!rule.patterns.some((p) => haystack.includes(p.toLowerCase()))) continue;
        const ok = await raiseAlert(c, {
          ruleKey: rule.key,
          subjectRef: f.id,
          companyId: f.company_id,
          severity: rule.severity,
          title: `${f.symbol}: ${f.category ?? 'filing'}`,
          detail: f.subject,
        });
        if (ok) raised++;
        // First matching rule wins. A pledge disclosure that also mentions an auditor should
        // raise once, at the higher severity, rather than twice.
        break;
      }
    }
    return { considered: filings.length, raised };
  });
}

/** A close that moved more than the rule's threshold against the previous close held. */
export async function evaluatePrices(): Promise<EvaluateResult> {
  return serviceTxn('system:alerts', async (c) => {
    const { rows: rule } = await c.query<{ key: string; severity: Severity; config: { percent?: number } }>(
      "SELECT key, severity, config FROM alert_rules WHERE key = 'price_move' AND active",
    );
    const r = rule[0];
    if (!r) return { considered: 0, raised: 0 };
    const threshold = r.config.percent ?? 10;

    const { rows: moves } = await c.query<{
      company_id: string; symbol: string; on_date: string; close: string; prev: string; pct: string;
    }>(
      `WITH ranked AS (
         SELECT c.id AS company_id, c.symbol, p.on_date, p.close,
                lag(p.close) OVER (PARTITION BY c.id ORDER BY p.on_date) AS prev
           FROM prices p
           JOIN companies c ON (p.isin IS NOT NULL AND p.isin = c.isin) OR p.symbol = c.symbol
       )
       SELECT company_id, symbol, on_date, close::text, prev::text,
              round(((close - prev) / prev * 100)::numeric, 2)::text AS pct
         FROM ranked
        WHERE prev IS NOT NULL AND prev > 0
          AND abs((close - prev) / prev * 100) >= $1
          AND on_date > current_date - 7`,
      [threshold],
    );

    let raised = 0;
    for (const m of moves) {
      const ok = await raiseAlert(c, {
        ruleKey: r.key,
        subjectRef: `${m.company_id}:${m.on_date}`,
        companyId: m.company_id,
        severity: r.severity,
        title: `${m.symbol} moved ${m.pct}%`,
        detail: `${m.prev} to ${m.close} on ${m.on_date}`,
      });
      if (ok) raised++;
    }
    return { considered: moves.length, raised };
  });
}

// ------------------------------------------------------------------------------------------------
// The desk
// ------------------------------------------------------------------------------------------------

export interface DeskItem {
  id: string;
  kind: 'alert' | 'reminder';
  severity: Severity;
  title: string;
  detail: string | null;
  symbol: string | null;
  at: Date;
}

/**
 * What changed since yesterday, ordered the way the desk reads it.
 *
 * **Severity first, then time within severity.** Reusing `alert_rules.severity` is what keeps the
 * desk, the mail routing and the rail badge from disagreeing about what is urgent — an auditor
 * resignation can never sit below a reminder just because the reminder is older.
 */
export async function desk(): Promise<DeskItem[]> {
  return readTxn(async (c) => {
    const { rows } = await c.query<DeskItem>(
      // The union is wrapped rather than ordered in place: Postgres only accepts simple output
      // column references in a set operation's ORDER BY, not an expression over them.
      `SELECT * FROM (
         SELECT a.id, 'alert' AS kind, a.severity, a.title, a.detail, co.symbol,
                a.raised_at AS at
           FROM alerts a LEFT JOIN companies co ON co.id = a.company_id
          WHERE a.acknowledged_at IS NULL
            AND (a.snoozed_until IS NULL OR a.snoozed_until < now())
         UNION ALL
         SELECT r.id, 'reminder', 'normal', r.body, NULL::text, co.symbol,
                r.due_on::timestamptz
           FROM reminders r LEFT JOIN companies co ON co.id = r.company_id
          WHERE r.completed_at IS NULL AND r.due_on <= current_date
       ) items
        ORDER BY CASE severity
                   WHEN 'critical' THEN 0 WHEN 'high' THEN 1
                   WHEN 'normal' THEN 2 ELSE 3 END,
                 at DESC`,
    );
    return rows;
  });
}

export async function acknowledge(alertId: string, actorId: string): Promise<void> {
  await writeTxn(actorId, async (c) => {
    await c.query(
      'UPDATE alerts SET acknowledged_at = now(), acknowledged_by = $1 WHERE id = $2 AND acknowledged_at IS NULL',
      [actorId, alertId],
    );
  });
}

export async function snooze(alertId: string, until: string, actorId: string): Promise<void> {
  await writeTxn(actorId, async (c) => {
    await c.query('UPDATE alerts SET snoozed_until = $1 WHERE id = $2', [until, alertId]);
  });
}

/** The next fortnight: what the fund already knows is coming. */
export async function upcoming(days = 14): Promise<
  { id: string; kind: string; title: string; onDate: string; symbol: string | null }[]
> {
  return readTxn(async (c) => {
    const { rows } = await c.query<{
      id: string; kind: string; title: string; onDate: string; symbol: string | null;
    }>(
      `SELECT e.id, e.kind, e.title, e.on_date AS "onDate", co.symbol
         FROM calendar_events e LEFT JOIN companies co ON co.id = e.company_id
        WHERE e.on_date BETWEEN current_date AND current_date + ($1 || ' days')::interval
        ORDER BY e.on_date, co.symbol`,
      [String(days)],
    );
    return rows;
  });
}
