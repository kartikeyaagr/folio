/**
 * Which backend a given environment selects.
 *
 * This has a test because the thing it replaced did not, and was wrong: `model.ts` carried a
 * comment saying the workspace id chose Claude Platform on AWS while the code below it constructed
 * a plain first-party client, and nothing in the tree read `ANTHROPIC_AWS_WORKSPACE_ID` at all. A
 * comment cannot be run. The assertions below are on the endpoint the client actually points at.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { chosenBackend, clientFor, NoModelCredentials } from './client.ts';

const AWS = {
  ANTHROPIC_AWS_WORKSPACE_ID: 'wrkspc_01ExampleNotReal',
  AWS_REGION: 'ap-south-1',
};

test('a workspace id selects Claude Platform on AWS, and the region is in the hostname', () => {
  assert.equal(chosenBackend(AWS), 'claude-platform-on-aws');
  const client = clientFor(AWS);
  assert.equal(client.baseURL, 'https://aws-external-anthropic.ap-south-1.api.aws');
});

test('the workspace id travels as a header, which is what the gateway routes on', () => {
  const client = clientFor(AWS) as { workspaceId?: string };
  assert.equal(client.workspaceId, AWS.ANTHROPIC_AWS_WORKSPACE_ID);
});

test('a workspace id with no region refuses to build rather than pointing at nowhere', () => {
  // Left to resolve itself the SDK reads ~/.aws/config asynchronously and reports an undefined
  // base URL until the first request — a missing setting surfacing one layer away from its cause.
  assert.throws(
    () => clientFor({ ANTHROPIC_AWS_WORKSPACE_ID: 'wrkspc_01ExampleNotReal' }),
    (err: unknown) => err instanceof NoModelCredentials && /AWS_REGION/.test(String(err)),
  );
});

test('a key alone still selects the first-party API', () => {
  // The laptop case. `pnpm dev` on a machine with no AWS credentials must keep working.
  assert.equal(chosenBackend({ ANTHROPIC_API_KEY: 'sk-ant-not-a-real-key' }), 'anthropic-api');
  assert.equal(
    clientFor({ ANTHROPIC_API_KEY: 'sk-ant-not-a-real-key' }).baseURL,
    'https://api.anthropic.com',
  );
});

test('the workspace id wins over a key left lying about in a shell profile', () => {
  // ops/SETUP.md §10 says one or the other and never both. An ANTHROPIC_API_KEY exported in
  // somebody's ~/.zshrc is a real thing, and it must not quietly outrank the box's own config.
  assert.equal(chosenBackend({ ...AWS, ANTHROPIC_API_KEY: 'sk-ant-stale' }), 'claude-platform-on-aws');
});

test('neither configured is a named failure at construction, not a 401 later', () => {
  assert.equal(chosenBackend({}), null);
  assert.throws(() => clientFor({}), NoModelCredentials);
});
