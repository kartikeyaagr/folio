import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:net';

import { smtpSender } from './notify.ts';

/**
 * The hang this module was rewritten to remove.
 *
 * Until 18-Sep-2026 the SMTP dialogue resolved its reply waiters only from the socket's `data`
 * event, and attached no `error` or `close` handler once connected. A relay that accepted the
 * connection and then said nothing left the send pending for the life of the process — and it was
 * awaited inside the outbox claim transaction, so it held a pooled connection and a row lock with
 * it. There was no timeout anywhere in the path.
 *
 * A silent server is exactly that relay.
 */
function silentRelay(): Promise<{ port: number; close: () => void }> {
  return new Promise((resolve) => {
    // Accepts the connection and never sends the 220 banner.
    const server: Server = createServer(() => {});
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      const port = typeof addr === 'object' && addr ? addr.port : 0;
      resolve({ port, close: () => server.close() });
    });
  });
}

test('a relay that accepts and then goes silent fails the send rather than hanging', async () => {
  const relay = await silentRelay();
  try {
    const send = smtpSender({
      host: '127.0.0.1',
      port: relay.port,
      from: 'desk@folio.test',
      timeoutMs: 750,
    });
    const started = Date.now();
    await assert.rejects(
      send({ to: 'a@folio.test', subject: 'x', body: 'y' }),
      'a silent relay must reject, not hang',
    );
    assert.ok(Date.now() - started < 10_000, 'it must reject on the timeout, not eventually');
  } finally {
    relay.close();
  }
});

test('a refused connection fails the send', async () => {
  // Port 1 on loopback refuses; the outbox records an attempt and moves on.
  const send = smtpSender({ host: '127.0.0.1', port: 1, from: 'desk@folio.test', timeoutMs: 750 });
  await assert.rejects(send({ to: 'a@folio.test', subject: 'x', body: 'y' }));
});
