import { NextResponse } from 'next/server';

import { readTxn } from '@/lib/db.ts';

/**
 * Reachability, for the uptime monitor.
 *
 * The one route the middleware lets through unauthenticated, because a monitor cannot sign in and
 * gating this would mean it only ever proved that the login page renders.
 *
 * It touches the database on purpose. A health check that answers 200 from the web process alone
 * says the web process is up, which is the least likely thing to be broken — v2's said exactly
 * that and stayed green through an outage. It reports **nothing** about what it found beyond
 * reachable or not: an unauthenticated endpoint should not describe the inside of the system.
 */
export const dynamic = 'force-dynamic';

export async function GET(): Promise<NextResponse> {
  try {
    await readTxn(async (c) => c.query('SELECT 1'));
    return NextResponse.json({ ok: true }, { status: 200 });
  } catch {
    return NextResponse.json({ ok: false }, { status: 503 });
  }
}
