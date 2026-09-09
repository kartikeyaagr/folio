/**
 * Which backend the model calls go to, and what picks it.
 *
 * `model.ts` owns *how* a call is made and what its failures are called. This file owns the one
 * question before that: **which endpoint, with whose credentials.** It is separate because it is
 * the part that is configured rather than written, and the part that was, until now, a comment
 * describing a mechanism the code did not have — `anthropic()` said the workspace id selected
 * Claude Platform on AWS while constructing a plain first-party client, and
 * `ANTHROPIC_AWS_WORKSPACE_ID` was read by nothing in the tree. A box provisioned by following
 * `ops/SETUP.md` top to bottom had no credential the SDK could resolve.
 *
 * **The presence of a workspace id is what selects the backend.** There is deliberately no second
 * "which backend" setting: a setting can disagree with the credentials actually present, and that
 * failure arrives as a 401 from the far end rather than as the misconfiguration it is.
 *
 * **Claude Platform on AWS, deliberately not Amazon Bedrock.** They are different products.
 * Bedrock is AWS-operated, takes `anthropic.`-prefixed model ids, and does not carry every feature
 * this system uses. Claude Platform on AWS is Anthropic-operated against
 * `aws-external-anthropic.{region}.api.aws`, takes the bare model ids already in `PRICING`, and
 * supports structured outputs — which every agent here depends on, because every agent passes a
 * schema and `askModel` parses the reply as JSON.
 *
 * On the box the credentials are the instance role, resolved through the ordinary AWS chain, so
 * **no model secret is ever written to disk there.** That is the point of using it.
 */

import Anthropic from '@anthropic-ai/sdk';
import AnthropicAws from '@anthropic-ai/aws-sdk';

export type Backend = 'claude-platform-on-aws' | 'anthropic-api';

/** Neither backend is configured. Raised at construction, so no request is ever sent half-set-up. */
export class NoModelCredentials extends Error {}

type Env = Record<string, string | undefined>;

/**
 * The backend this environment selects, or null if it selects none.
 *
 * Answerable without constructing anything, so a preflight check can ask it and a test can ask it
 * about an environment that is not this process's.
 */
export function chosenBackend(env: Env = process.env): Backend | null {
  // Ordered, not exclusive. `ops/SETUP.md` says one or the other and never both, but an
  // ANTHROPIC_API_KEY exported in somebody's shell profile is a real thing that happens, and it
  // must not quietly win over the box's own configuration.
  if (env['ANTHROPIC_AWS_WORKSPACE_ID']) return 'claude-platform-on-aws';
  if (env['ANTHROPIC_API_KEY']) return 'anthropic-api';
  return null;
}

/**
 * The client an environment asks for. Exported so a test can ask about an environment that is not
 * this process's — the previous version of this code could only be checked by reading it.
 */
export function clientFor(env: Env): Anthropic {
  switch (chosenBackend(env)) {
    case 'claude-platform-on-aws': {
      // Required, and passed explicitly rather than left to the SDK. Left to the SDK it falls
      // through to `~/.aws/config`, which is read *asynchronously* — the client then reports an
      // undefined region and no base URL until the first request, which turns a missing setting
      // into a puzzling failure one layer further away. There is no default region: the region is
      // part of the hostname.
      const region = env['AWS_REGION'] ?? env['AWS_DEFAULT_REGION'];
      if (!region) {
        throw new NoModelCredentials(
          'ANTHROPIC_AWS_WORKSPACE_ID is set, which selects Claude Platform on AWS, but AWS_REGION ' +
            'is not. The region is part of the endpoint hostname and has no default. See ops/SETUP.md §10.',
        );
      }
      return new AnthropicAws({
        awsRegion: region,
        workspaceId: env['ANTHROPIC_AWS_WORKSPACE_ID']!,
      });
    }
    case 'anthropic-api':
      return new Anthropic({ apiKey: env['ANTHROPIC_API_KEY']! });
    case null:
      throw new NoModelCredentials(
        'No model credentials. Set ANTHROPIC_AWS_WORKSPACE_ID (with AWS_REGION) for Claude Platform ' +
          'on AWS, or ANTHROPIC_API_KEY for the first-party API. See ops/SETUP.md §10.',
      );
  }
}

let client: Anthropic | undefined;

/** The process's one client, built on first use. */
export function modelClient(): Anthropic {
  client ??= clientFor(process.env);
  return client;
}
