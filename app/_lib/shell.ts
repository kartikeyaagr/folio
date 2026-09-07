import { readTxn } from '@/lib/db.ts';

import type { RailBadges } from '@/components/Rail.tsx';

/**
 * What the rail needs on every page: who this is, and two counts.
 *
 * **A badge shows what the hub itself would show you.** That is the whole definition: the desk
 * badge counts exactly what `desk()` lists, and the agents badge counts exactly what the review
 * queue lists. A badge counting something of its own devising would sooner or later disagree with
 * the page it points at, and a rail saying 19 over a desk showing 22 is worse than either alone.
 *
 * One query, because the layout runs on every navigation.
 */
export async function railData(userId: string): Promise<{ name: string | null; badges: RailBadges }> {
  return readTxn(async (c) => {
    const { rows } = await c.query<{ name: string | null; waiting: string; drafts: string }>(
      `SELECT (SELECT name FROM users WHERE id = $1) AS name,
              (SELECT count(*)::text FROM (
                 SELECT a.id FROM alerts a
                  WHERE a.acknowledged_at IS NULL
                    AND (a.snoozed_until IS NULL OR a.snoozed_until < now())
                 UNION ALL
                 SELECT r.id FROM reminders r
                  WHERE r.completed_at IS NULL AND r.due_on <= current_date
               ) items) AS waiting,
              (SELECT count(*)::text FROM ai_drafts WHERE decided_at IS NULL) AS drafts`,
      [userId],
    );
    const r = rows[0];
    return {
      name: r?.name ?? null,
      badges: { desk: Number(r?.waiting ?? 0), agents: Number(r?.drafts ?? 0) },
    };
  });
}
