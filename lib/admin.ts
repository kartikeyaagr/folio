/**
 * What an admin can change, and the reads behind the panel that shows it.
 *
 * Everything here is a *setting* rather than a record of what happened: which agents run, which
 * feeds are polled, which rules raise alerts, who has access. The things this system observes are
 * never editable from a screen — a filing says what it says.
 *
 * Three guards exist because the panel is the only way back in: you cannot revoke your own admin,
 * cannot disable your own account, and cannot remove the last admin. Each of those is one click
 * away from a system nobody can administer, recoverable only by someone with shell access.
 */

import { readTxn, writeTxn } from './db.ts';

export class WouldLockYouOut extends Error {}

// ------------------------------------------------------------------------------------------------
// People
// ------------------------------------------------------------------------------------------------

export interface AdminUser {
  id: string;
  email: string;
  name: string;
  isAdmin: boolean;
  disabledAt: Date | null;
  hasPassword: boolean;
}

export async function listUsers(): Promise<AdminUser[]> {
  return readTxn(async (c) => {
    const { rows } = await c.query<{
      id: string;
      email: string;
      name: string;
      is_admin: boolean;
      disabled_at: Date | null;
      has_password: boolean;
    }>(
      `SELECT id, email, name, is_admin, disabled_at, (password_hash IS NOT NULL) AS has_password
         FROM users ORDER BY disabled_at NULLS FIRST, email`,
    );
    return rows.map((r) => ({
      id: r.id,
      email: r.email,
      name: r.name,
      isAdmin: r.is_admin,
      disabledAt: r.disabled_at,
      hasPassword: r.has_password,
    }));
  });
}

/** Count of live admins, used to refuse removing the last one. */
async function liveAdmins(): Promise<number> {
  return readTxn(async (c) => {
    const { rows } = await c.query<{ n: string }>(
      'SELECT count(*)::text AS n FROM users WHERE is_admin AND disabled_at IS NULL',
    );
    return Number(rows[0]?.n ?? 0);
  });
}

export async function setUserAdmin(
  userId: string,
  isAdmin: boolean,
  actorId: string,
): Promise<void> {
  if (!isAdmin) {
    if (userId === actorId) {
      throw new WouldLockYouOut('You cannot revoke your own admin — you would lose this page.');
    }
    if ((await liveAdmins()) <= 1) {
      throw new WouldLockYouOut('That is the last admin. Grant another one first.');
    }
  }
  await writeTxn(actorId, async (c) => {
    await c.query('UPDATE users SET is_admin = $2 WHERE id = $1', [userId, isAdmin]);
  });
}

/**
 * Disabling is reversible and revokes their sessions; deleting a user is not offered at all.
 * `audit_log`, `agent_runs` and every attributed write reference them, and a person who has left
 * still wrote what they wrote.
 */
export async function setUserDisabled(
  userId: string,
  disabled: boolean,
  actorId: string,
): Promise<void> {
  if (disabled && userId === actorId) {
    throw new WouldLockYouOut('You cannot disable your own account.');
  }
  await writeTxn(actorId, async (c) => {
    await c.query('UPDATE users SET disabled_at = CASE WHEN $2 THEN now() ELSE NULL END WHERE id = $1', [
      userId,
      disabled,
    ]);
    if (disabled) {
      await c.query(
        'UPDATE sessions SET revoked_at = now() WHERE user_id = $1 AND revoked_at IS NULL',
        [userId],
      );
    }
  });
}

// ------------------------------------------------------------------------------------------------
// Agents — D1 says an agent is a record, so the registry is data and this edits it
// ------------------------------------------------------------------------------------------------

export interface AdminAgent {
  key: string;
  label: string;
  trigger: string;
  model: string;
  effort: string | null;
  enabled: boolean;
  minInterval: number | null;
}

export async function listAgents(): Promise<AdminAgent[]> {
  return readTxn(async (c) => {
    const { rows } = await c.query<{
      key: string;
      label: string;
      trigger: string;
      model: string;
      effort: string | null;
      enabled: boolean;
      min_interval_minutes: number | null;
    }>(
      `SELECT key, label, trigger, model, effort, enabled, min_interval_minutes
         FROM agents ORDER BY label`,
    );
    return rows.map((r) => ({
      key: r.key,
      label: r.label,
      trigger: r.trigger,
      model: r.model,
      effort: r.effort,
      enabled: r.enabled,
      minInterval: r.min_interval_minutes,
    }));
  });
}

export async function setAgentEnabled(
  key: string,
  enabled: boolean,
  actorId: string,
): Promise<void> {
  await writeTxn(actorId, async (c) => {
    await c.query('UPDATE agents SET enabled = $2 WHERE key = $1', [key, enabled]);
  });
}

/**
 * Effort is the dial the design uses instead of model choice — routing is quality-first, and the
 * criterion is whether the agent has a safety net under it. Model is left alone here on purpose:
 * `PRICING` is a code constant, so a model set from a screen would be a model whose cost cannot be
 * known, and `costUsd` would start returning null for every run.
 */
export async function setAgentEffort(
  key: string,
  effort: string | null,
  actorId: string,
): Promise<void> {
  await writeTxn(actorId, async (c) => {
    await c.query('UPDATE agents SET effort = $2 WHERE key = $1', [key, effort]);
  });
}

// ------------------------------------------------------------------------------------------------
// Operations
// ------------------------------------------------------------------------------------------------

export interface Run {
  id: string;
  source: string;
  status: string;
  items: number | null;
  detail: string | null;
  startedAt: Date;
  finishedAt: Date | null;
}

/**
 * The last runs of every ingest job.
 *
 * Nothing in the application read `ingestion_runs` before this. The audit's finding was blunt: a
 * failed job reached no human by any path — `report-failure.ts` wrote a row and nothing selected
 * from the table. This is that path, and it is a screen rather than a mail because there is no
 * relay configured.
 */
export async function recentRuns(limit = 40): Promise<Run[]> {
  return readTxn(async (c) => {
    const { rows } = await c.query<{
      id: string;
      source: string;
      status: string;
      items: number | null;
      detail: string | null;
      started_at: Date;
      finished_at: Date | null;
    }>(
      `SELECT id, source, status, items, detail, started_at, finished_at
         FROM ingestion_runs ORDER BY id DESC LIMIT $1`,
      [limit],
    );
    return rows.map((r) => ({
      id: r.id,
      source: r.source,
      status: r.status,
      items: r.items,
      detail: r.detail,
      startedAt: r.started_at,
      finishedAt: r.finished_at,
    }));
  });
}

// A retrieval-health question, not an administrative one, so the query itself lives in
// lib/retrieval/health.ts — re-exported here because the ops tab renders it beside these runs.
export { indexingLag } from './retrieval/health.ts';

// ------------------------------------------------------------------------------------------------
// Alert rules and news sources
// ------------------------------------------------------------------------------------------------

export interface AdminRule {
  key: string;
  label: string;
  kind: string;
  severity: string;
  active: boolean;
}

export async function listAlertRules(): Promise<AdminRule[]> {
  return readTxn(async (c) => {
    const { rows } = await c.query<AdminRule>(
      'SELECT key, label, kind, severity, active FROM alert_rules WHERE company_id IS NULL ORDER BY severity, key',
    );
    return rows;
  });
}

export async function setAlertRule(
  key: string,
  patch: { active?: boolean; severity?: string },
  actorId: string,
): Promise<void> {
  await writeTxn(actorId, async (c) => {
    await c.query(
      `UPDATE alert_rules
          SET active = COALESCE($2, active),
              severity = COALESCE($3, severity)
        WHERE key = $1 AND company_id IS NULL`,
      [key, patch.active ?? null, patch.severity ?? null],
    );
  });
}

export interface AdminSource {
  key: string;
  label: string;
  tier: number;
  active: boolean;
  lastPolledAt: Date | null;
  lastStatus: string | null;
  lastError: string | null;
}

export async function listNewsSources(): Promise<AdminSource[]> {
  return readTxn(async (c) => {
    const { rows } = await c.query<{
      key: string;
      label: string;
      tier: number;
      active: boolean;
      last_polled_at: Date | null;
      last_status: string | null;
      last_error: string | null;
    }>(
      `SELECT key, label, tier, active, last_polled_at, last_status, last_error
         FROM news_sources ORDER BY active DESC, tier, key`,
    );
    return rows.map((r) => ({
      key: r.key,
      label: r.label,
      tier: r.tier,
      active: r.active,
      lastPolledAt: r.last_polled_at,
      lastStatus: r.last_status,
      lastError: r.last_error,
    }));
  });
}

export async function setNewsSourceActive(
  key: string,
  active: boolean,
  actorId: string,
): Promise<void> {
  await writeTxn(actorId, async (c) => {
    await c.query('UPDATE news_sources SET active = $2 WHERE key = $1', [key, active]);
  });
}
