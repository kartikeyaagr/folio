# Folio

Investment research and portfolio management for a three-person SEBI Category III AIF running a
long-only Indian small/mid-cap book. Internal tool, behind a private network, no public signup, no
guest access. The people using it open it before the market opens and after it closes; the work is
reading and judgement, not reacting.

**Folio is the system; Trisula Capital is the firm.** The system was called Trisula until
28-Sep-2026. That name correctly remains wherever it means the fund (its forensic checklist, its
severity calibration, its email domain). It also remains wherever it cannot move. That covers v2 at
`../trisula` and v2's Python module names. It covers every file in `db/migrations/`, which is
sha256-checksummed, comments included, and with it the `trisula_content` channel migration 0052's
trigger sends on, which `jobs/index-content.ts` must go on listening to. It also covers the AWS
resources `ops/provision.sh` pins. None of those are missed renames.

**This tree is v3, extended by v4.** v3 is what is built and running; **v4 is the retrieval, chat
and learning layer being added on top of it**, and it does not replace v3 — `v4.md` §2 describes the
v3 system as its own foundation. The system before both lives at `../trisula` and is not being
extended. Read nothing from it as evidence about this one: several of its subsystems were
deliberately not carried forward.

## The documents

**`ARCHITECTURE.md` is tracked in git and describes the system as built** — layout and the enforced
boundaries, the data model, ingestion, the content store, the agents, chat, the learning loop, and
the jobs. It is the fastest way to orient, and its numbers are counted rather than remembered. The
files below are the private record of *why* each of those decisions was made, and they stay
authoritative for intent.

**Four tracked rulebooks sit beside it. Read the one that matches the change before making it:**

- `SECURITY.md` for authentication, a server action, a route handler, an env var, or a secret;
- `DATABASE.md` for the schema, a migration, or a new table;
- `API.md` for a new action, route handler, job, or outbound integration;
- `CODE_STYLE.md` for anything.

Each states the rule and names the file that holds the reason. When the code and a rulebook
disagree, say so before changing either.

`docs/specs/` and `docs/plans/` (gitignored, private):

| File | What it settles |
|---|---|
| `v4.md` | **Current.** The whole system: what v3 built (§2) and what v4 adds — retrieval, chat, the learning loop, agent 8 |
| `capabilities.md` | v3's *what*: capability list A1–A8, B, C1–C8, D1–D6, E, and what was explicitly cut |
| `design.md` | v3's *how*: schema, the seven agents, error handling, build order P0–P7 |
| `forensic-checklist.md` | The fund's own 14-item checklist, worked by agent 7 |
| `agent-specs.md` | Purposes, schemas, verifiers and sweep predicates for every agent, extracted before `lib/agents/` is rebuilt |
| `v2-system-map.md` | What the system before v3 did, for reference only |
| `plans/2026-09-10-v4-retrieval.md` | R0–R2: the content store, the embedder, hybrid search |
| `plans/2026-09-11-v4-chat.md` | R3: `/chat`, the tool loop, agent 8 |
| `plans/2026-09-11-v4-write-paths.md` | R4: `run_agent` and `draft_document`, both landing in the gate |
| `plans/2026-09-11-v4-learning-measurable.md` | R5a: edit-before-accept, edit distance, exemplar capture |
| `plans/2026-09-11-v4-learning-retrieval.md` | R5b: the embed queue, retrieval into prompts — **carries the 11-Dec-2026 review condition**, amended 11-Sep |
| `plans/2026-09-11-v4-rules.md` | R6: `prompt_rules`, distillation, `/rules` and the approval gate |
| `plans/2026-09-11-v4-nested-editing.md` | A correction reaches inside a draft: the path grammar, shape-weighted distance, `/review`'s renderers |

**The UI's standing rules are `.interface-design/system.md`** — tracked in git, and the only copy.
A stale 105-line duplicate lived at `docs/specs/design-system.md` and was deleted 11-Sep-2026; this
table pointed at it, so every session that consulted a design document read the one missing the v3
amendments.

**Open engineering items live in `tasks/open-items.md`**, consolidated 11-Sep-2026 from four
superseded audit documents.

**A gap against something the specs deliberately cut is not a gap.** Check before "fixing" it.
D2 cut `/returns`, `/attribution`, `/thesis`, `/memo` and `/pipeline`. C7 declines clustering.
C8 declines a news vendor. The investor-letter agent was cut and its number not reused.

## Running it

```bash
export DATABASE_URL=postgres:///folio_dev
pnpm exec tsx db/migrate.ts      # migrations are one transaction each, checksummed
pnpm check                       # lint + typecheck + 946 tests
pnpm dev                         # port 3100
```

Tests create and drop their own databases; they need `createdb`/`dropdb` on PATH. Jobs run under
`pnpm exec tsx jobs/<name>.ts` and each writes an `ingestion_runs` row.

## Boundaries that are enforced, not suggested

1. **`lib/` never imports Next.** It is imported by both the app and the standalone `tsx` jobs; a
   `next/*` import compiles for the web and dies in a job. An eslint rule replaces the guarantee
   that v2 got for free by having its services in Python.
2. **`app/` may import `lib/`; `lib/`, `jobs/` and `db/` may never import `app/`.** The backend has
   to stay provable without the frontend.
3. **Web-only helpers live in `app/_lib/`**, never in `lib/`. Cookies, sessions, server actions.
4. **300-line cap on files in `lib/`** (a warning). v2's `pipeline.ts` reached 2,007 lines because
   nothing separated fetching from rendering.

## House standards

- **Every write is attributed.** `writeTxn(actorId, …)` for a person, `serviceTxn(principal, …)`
  for a job. Postgres RAISES on an unattributed write and on an unknown actor — service principals
  are seeded in migrations, and `ServicePrincipal` in `lib/db.ts` is the same closed set.
- **A feed or job that returns zero items is a failure, not a quiet day.** A dead feed must never
  look like a quiet one. Six documented exemptions, each stated in its own file and listed here so
  the count stays in one place: no bhavcopy on a non-trading day (`ingest-eod`), the news gate's
  empty queue, the content indexer's two empty queues, a distillation run that raised no rule, an
  agent sweep that queued nothing, and a company backfill with nothing left to claim
  (`backfill-company`, added 19-Sep-2026). The files describe their own case and do not number it —
  ordinals in five headers drifted, and two of them both claimed to be the fourth.
- **A news feed whose newest item is more than 21 days old is a failure too**, however it answers.
  Five Moneycontrol feeds served an April-2024 history as "ok" for five months before this was
  measured on 28-Sep-2026 (`STALE_DAYS`, `lib/news/poll.ts`); a full, frozen feed is not a quiet one
  either.
- **Ask "what has no run yet", never "what is new since I last looked."** Sweeps and evaluators use
  `NOT EXISTS`, not a watermark or a rolling window. A window can only lose things — it already
  cost this system two real alerts.
- **Where the system declines to answer, render `<Blank why="…" />`.** Never a zero: an empty cell
  reads as broken, a dash reads as not-applicable, and a zero reads as a measured fact, which is
  the most dangerous of the three.
- **Nothing an agent writes enters the record without a person accepting it**, and every draft
  shows where it came from before and after that decision. **One exception, dated 28-Sep-2026:** the
  news brief, by the fund's own decision, publishes itself the moment it is written and is mailed to
  everyone with nobody reviewing it first. It is held to exactly one agent by the database, not only
  by the code — `only_the_brief_skips_review` and `nobody_signed_a_published_draft` on `ai_drafts`
  (migration `0067`) — so widening it takes a migration, not a one-line change.
- **Cost is visible and true.** `costUsd` returns null for an unknown model, never zero. v2's
  dashboard confidently reported `$0.00` because nothing seeded its price table.
- **State lives in the URL** — `?tab=`, `?filter=`, `?scope=` and plain links. Pages stay server
  components; a refresh lands where you were.

## Writing code here

Node runs TypeScript in **strip-only mode**: no parameter properties, no enums, no namespaces —
they are runtime syntax errors, not just style. Relative imports inside `lib/` carry the `.ts`
extension.

Comments explain **why**, and record what was measured. The valuable comments in this tree name a
trap and the evidence for it — "NSE's year-to-date context declares the quarter's dates while
carrying nine months of figures; verified on 24 live filings, all 24 disagreed". Do not restate
what the code does.

Before adding a UI control, check `components/ui.tsx` and the classes in `app/globals.css`. Styling
is by class, never inline `style` objects — an inline style cannot express `:hover`, `:focus-visible`,
`:active` or `:disabled`, and a control with no hover state is the fastest way to look unfinished.

## Skill routing

When the user's request matches an available skill, invoke it. When in doubt, invoke the skill.

- Product ideas or brainstorming → `/office-hours`
- Strategy and scope → `/plan-ceo-review`
- Architecture → `/plan-eng-review`
- Design system or plan review → `/design-consultation`, `/plan-design-review`
- Bugs and errors → `/investigate`
- QA of site behaviour → `/qa` or `/qa-only`
- Code review of a diff → `/review`
- Visual polish → `/design-review`
- Ship or deploy → `/ship`, `/land-and-deploy`

<!-- BEGIN AWS Agent Toolkit rules -->

# AWS Guidance for the new AWS experience

This user has signed up for the new AWS experience. This experience lets you sign into AWS using a social provider and requires the following additional context.

Where this guidance conflicts with the project's own instructions, the project's instructions take precedence.

## Context

### Terminology:

- Say "project" instead of "account" — a project contains an AWS account and settings for sharing with other collaborators
- Say "team member" instead of "IAM user" — users are invited by email, not created or federated in IAM
- Say "AWS Settings" when referring to management tasks at [settings.aws.com](https://settings.aws.com/) (project management, billing, team members, spend limits). Users view their actual AWS resources in the AWS Management Console.
- Say "selected Region" when referring to the user's Region — not "home Region"
- The user has a managed IAM experience. This includes a managed service control policies (SCP) and resource control policies (RCP) that govern the use of AWS. They will still need to use IAM to create policies to let services work with each other. If there are questions about the SCPs or RCPs, go to the documentation at https://docs.aws.amazon.com/accounts/latest/reference/scps-and-rcps-for-projects.html

### Constraints:

- All projects share a single AWS Region determined by the user's contact address. Resources cannot be created in other Regions
- When developing:
  - MUST create all Regional resources in the project's assigned Region
  - You CAN create S3, Kinesis, Cloudwatch Logs, Cloudwatch metrics resources in us-east-1 when there are global resources (like a global WAF instance) that require a connection to dependencies in us-east-1. You should not use these for any other reason, because resources in the selected Region will provide lower cost (due to no cross-Region traffic), increased availability (due to no cross-Region traffic), and easier manageability (due to not needing to look in another Region). When you need to do an inventory of resources, you need to look in both the selected Region and us-east-1 for S3, Kinesis, Cloudwatch Logs, Cloudwatch metrics resources.
  - MUST NOT attempt to create Lambda, API Gateway, or other Regional resources in any other Region
  - MUST direct users to confirm their Region in AWS Settings > View all projects > Overview > Additional Info > Region. If the user cannot confirm their Region, check in ~/.aws/config
  - MUST NOT use Lambda@Edge — excluded from both Lambda and CloudFront
  - MUST NOT use CloudFormation StackSets — no multi-account or multi-Region deployments
  - MUST NOT attempt cross-Region actions — no cross-Region replication for DynamoDB/S3/RDS, no multi-Region KMS keys
  - MUST NOT use Route 53 cross-Region routing — geolocation, latency-based, and failover routing policies are not available
  - CloudFront is a global service and its actions ARE allowed in `us-east-1`. A user can create a CloudFront distribution pointing to their project-region Lambda function URL or API Gateway. However, Lambda and API Gateway themselves MUST NOT be created in `us-east-1` — they must be in the project Region.
  - Reduced availability in `eu-north-1` specifically: Amazon Rekognition, Amazon Textract, Amazon Personalize, AWS App Runner are not available in that Region.
- IAM permissions for human access are managed by AWS. Don't assign roles to team members unless absolutely necessary
- The user may have a spend limit if they are on the paid plan. The limit that pauses their project if it's exceeded. If resources suddenly become inaccessible, ask if they have a spend limit configured. Only project owners can modify a spend limit.
- When developing:
  - MUST ask about spend limit status if the user reports sudden "Access Denied" errors on operations that previously worked
  - MUST direct users to check spend status in AWS Settings > Billing
  - MUST check if a user has upgraded their account to the paid plan
  - MUST ask the user if they want to clean up the successfully created resources or keep them to reduce cost
- The user sets up billing, creates spend limits, and retrieves and pays invoices in AWS Settings. The user creates budgets and optimizes their costs in the AWS Billing and Cost Management console
- Not all AWS services are available. If a service isn't working, do the following:
  1. Run the command `aws freetier get-account-plan-state`
  2. If accountPlanType": "FREE", check the [Free Tier supported services list](https://docs.aws.amazon.com/accounts/latest/reference/supported-services-sign-up-new.html#supported-services-free-tier) next,
  3. If accountPlanType": "PAID", check the [Paid Tier supported services list](https://docs.aws.amazon.com/accounts/latest/reference/supported-services-sign-up-new.html#supported-services-paid-plan).
  4. If neither list shows the service, check the [Not supported for this experience list](https://docs.aws.amazon.com/accounts/latest/reference/supported-services-sign-up-new.html#unsupported-services). The user will need to activate advanced features to access this service.
- Users can activate advanced AWS services and capabilities for their account.
- Before starting a task, check whether a relevant AWS skill is available. Load the skill with retrieve_skill and prefer its guidance over general knowledge.

### Help level

- help_level (required): LOW, MEDIUM, or HIGH. While a user is building, you MUST ask the user: "How much guidance would you like from me? Low (I only flag security risks), medium (I ask a couple of clarifying questions if something seems off), or high (I explain what I'm doing, suggest alternatives, and flag best practices)."

You CAN update this rule file to save a user's help_level.

Constraints for each level:

**LOW:**

- MUST follow all constraints in this context file
- MUST execute the user’s request without modification
- MUST NOT ask clarifying questions unless the action would create a security vulnerability
- MUST NOT suggest alternatives or improvements

**MEDIUM:**

- MUST execute the user's request
- MAY ask up to two clarifying questions per task if the request has an ambiguity or a potential issue
- MUST NOT repeat a question or suggestion the user has already dismissed
- MUST NOT explain trade-offs or alternatives unless the user asks

**HIGH:**

- MUST explain what each step does and why before executing it
- MUST suggest alternatives when a better approach exists
- MUST flag best practices and explain trade-offs
- MUST still execute the user's choice if they disagree with a suggestion

<!-- END AWS Agent Toolkit rules -->

