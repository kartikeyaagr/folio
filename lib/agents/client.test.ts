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

const FED = {
  ANTHROPIC_FEDERATION_RULE_ID: 'fdrl_01ExampleNotReal',
  ANTHROPIC_ORGANIZATION_ID: '00000000-0000-0000-0000-000000000000',
  ANTHROPIC_SERVICE_ACCOUNT_ID: 'svac_01ExampleNotReal',
  ANTHROPIC_IDENTITY_TOKEN_FILE: '/run/trisula/identity-token',
};

test('a federation rule id selects the first-party API with no key on disk', () => {
  assert.equal(chosenBackend(FED), 'oidc-federation');
  assert.equal(clientFor(FED).baseURL, 'https://api.anthropic.com');
});

test('a key in the environment cannot shadow federation', () => {
  // The trap this branch exists to close. `apiKey` defaults to process.env['ANTHROPIC_API_KEY']
  // and outranks `config`, so without the explicit null the SDK authenticates with the stray key,
  // succeeds, and bills whoever owns it. Asserting on the resolved client, not on the intent.
  const client = clientFor({ ...FED, ANTHROPIC_API_KEY: 'sk-ant-stale' }) as {
    apiKey: string | null;
    authToken: string | null;
  };
  assert.equal(chosenBackend({ ...FED, ANTHROPIC_API_KEY: 'sk-ant-stale' }), 'oidc-federation');
  assert.equal(client.apiKey, null);
  assert.equal(client.authToken, null);
});

test('federation wins over a workspace id left behind by the route that did not work', () => {
  // Claude Platform on AWS bills through AWS Marketplace, which a Sign up for AWS (new) account
  // cannot use. A workspace id sitting in the env alongside a rule id is the stale one.
  assert.equal(chosenBackend({ ...FED, ...AWS }), 'oidc-federation');
});

test('federation missing its other halves refuses to build, and says which half', () => {
  assert.throws(
    () => clientFor({ ANTHROPIC_FEDERATION_RULE_ID: 'fdrl_01ExampleNotReal' }),
    (err: unknown) =>
      err instanceof NoModelCredentials &&
      /ANTHROPIC_ORGANIZATION_ID and ANTHROPIC_IDENTITY_TOKEN_FILE are not/.test(String(err)),
  );
  assert.throws(
    () => clientFor({ ...FED, ANTHROPIC_IDENTITY_TOKEN_FILE: undefined }),
    (err: unknown) =>
      err instanceof NoModelCredentials &&
      /ANTHROPIC_IDENTITY_TOKEN_FILE is not/.test(String(err)),
  );
});
