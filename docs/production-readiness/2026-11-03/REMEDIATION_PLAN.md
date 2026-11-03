# Bunqsy remediation plan

All work below is **future work**, not execution evidence. Start with synthetic data and a fake provider; any sandbox account access or deployment requires prior owner approval. Real-money actions require separate explicit approval. See [review](REVIEW.md).

## Roadmap and dependency map

| Phase / entry | Task | Prerequisites | Exit |
|---|---|---|---|
| Baseline: isolated synthetic environment | BQ-T1 | Owner provides scope, no sandbox required | Effect paths and untraced boundaries recorded |
| Correctness | BQ-T2, BQ-T7 | BQ-T1 | Identity, registration and execution safety tested against fakes |
| Security | BQ-T3, BQ-T4 | BQ-T1 | Boundary, webhook, secret and dependency evidence produced |
| Automation and UX | BQ-T5 | BQ-T2–T4, BQ-T7 | Negative controls and consent behavior observed |
| Recovery / sandbox | BQ-T6 | BQ-T5 and prior owner sandbox approval | Pinned sandbox release, provider semantics and restore observed, or explicitly blocked |
| Independent acceptance | BQ-T8 | BQ-T3–T7 including BQ-T6 evidence | Independent reviewer accepts SHA-linked evidence or records blockers; no implicit real-money approval |

### BQ-T1 — Trace the action and trust paths (BQ-01–09)

Prerequisite: owner-defined scope and isolated synthetic environment, not a bank account. Observed paths: `packages/daemon/src/index.ts`, `packages/daemon/src/routes/`, `packages/daemon/src/bunq/`.
1. Inventory route registration, inherited Fastify hooks, WebSocket paths, plan creation/confirmation, execution and provider calls; explicitly mark anything not traced.
2. Map account ownership, data and secret locations, proxy/network boundaries, and simulator versus live paths.
3. With fake provider and synthetic rows, reproduce registration failure and account-selection behavior; record available scripts rather than assuming a test command exists.

Deliverable: call/data-flow map and baseline. Verification: cross-check every identified effectful entry point against a provider call or explicit unresolved boundary.
- [ ] Effectful routes, hooks and provider calls mapped or marked unresolved.
- [ ] Simulator, synthetic and real-money boundaries distinguished.

### BQ-T2 — Correct retries and account identity (BQ-03, BQ-04)

Prerequisite: BQ-T1. Observed `packages/daemon/src/index.ts`; focused tests are proposed.
1. Set registration success only after provider confirmation; add bounded retries and investigate provider-supported idempotent registration.
2. Derive the primary account identifier from authoritative authenticated account data; reject missing or ambiguous identity.
3. Exercise transient failures, duplicate notifications, foreign counterparties and absent account data with synthetic rows and a stub provider.

Deliverable: corrected behavior and focused tests. Verification: restoring the early-success flag or counterparty lookup makes its relevant test fail.
- [ ] A transient registration failure can recover without uncontrolled retries.
- [ ] Exports reject unknown identity rather than using a counterparty or placeholder.

### BQ-T3 — Secure action and webhook boundaries (BQ-01, BQ-07, BQ-09)

Prerequisite: BQ-T1. Observed `packages/daemon/src/index.ts`, `packages/daemon/src/routes/api.ts` and `packages/daemon/src/bunq/webhook.ts`.
1. Trace all inherited hooks and route modules, including WebSockets; define trusted origins and bind address, authenticate direct and browser clients, and fail closed on missing production configuration.
2. Require actor and account/card ownership at plan creation, confirmation and execution. Bind explicit approval to the exact immutable action, target, amount where applicable, actor and expiry; reject absent, replayed or altered approvals.
3. Make production webhook verification fail closed on missing key, invalid/missing signature and verifier exception. Verify provider-defined signed raw bytes before parsing, configure an explicitly trusted proxy chain that strips untrusted forwarded headers, and implement replay handling based on verified provider semantics.
4. Through the real API boundary with a fake provider and synthetic signed requests, test anonymous, cross-account, altered-action, absent/expired approval and hostile-origin cases; test missing key/signature, invalid signature, thrown verifier, tampered raw body, spoofed forwarded header and replay. Confirm legitimate requests still work.

Deliverable: threat model, enforced controls and boundary tests. Verification: intact guards reject invalid requests with zero fake-provider mutations or webhook processing; neutralize each required guard in turn and show its targeted test fails, isolating the guard's seam where another layer masks the mutation. Separately test intended defense in depth through the full boundary—another layer blocking an attack must not be mistaken for proof that the removed guard works.
- [ ] Actor, ownership and exact-action approval enforced at all identified effectful boundaries.
- [ ] Proxy trust, raw-body verification and production fail-closed/replay behavior demonstrated with synthetic requests.
- [ ] Each guard has a non-tautological failing negative control and intact positive case.

### BQ-T4 — Protect credentials and dependency provenance (BQ-02, BQ-05)

Prerequisite: BQ-T1. Observed `packages/daemon/src/index.ts`, `package.json` and `packages/daemon/package.json`; build and scanning steps are proposed future work.
1. Inventory keys, tokens, SQLite files, logs, environment and backups without printing secret values; specify owner-approved custody, least privilege, encryption and rotation.
2. Pin development tools, review the resolved dependency graph and lockfile, and define an isolated reproducible build and advisory-review process.
3. Inject distinct synthetic canaries through each relevant build configuration and confirm build input consumption without exposing real credentials; deliberately produce a controlled leak and prove the scanner detects it before scanning normal artifacts and logs.
4. Check public assets, ordinary logs and restored synthetic backups for leaks and access controls; record scanner coverage and exclusions.

Deliverable: custody, provenance and canary evidence. Verification: a consumed canary plus a detected positive leak control makes a subsequent clean scan meaningful; a missing canary or missed leak blocks the gate.
- [ ] Rotation and compromise response documented and custody approved.
- [ ] Every tested configuration consumes its canary and the positive leak is detected.
- [ ] Normal artifacts and logs pass the defined scan; exclusions are recorded.

### BQ-T7 — Make execution reconcilable (BQ-08)

Prerequisite: BQ-T1. Observed `packages/daemon/src/bunq/execute.ts`; schema and tests require inspection before changes.
1. Design conditional confirmation and an atomic durable claim for each plan, including crash recovery; only one caller may own execution, and uncertain claims must not silently become retryable.
2. Persist per-step intent and outcomes, including success, failure and unknown response, linked to stable action identifiers. Preserve earlier successes on later failure and reconcile against provider records before any retry; never repeat an ambiguous step automatically.
3. Investigate provider-supported idempotency for each relevant operation; use stable keys where supported, otherwise document a safe stop/manual reconciliation policy rather than claiming exactly-once effects.
4. With a fake provider, race concurrent callers, fail a later step after an earlier success, and simulate a provider effect followed by a lost response and process restart. Assert exact provider calls and durable states; deliberately bypass the claim or reconciliation gate and show the relevant test fails.

Deliverable: execution state design, implementation and evidence. Verification: only the claimed caller acts, successful steps are not repeated, and unknown results remain blocked until reconciliation; independently verify actual provider semantics later under BQ-T6.
- [ ] Atomic claim and per-step outcomes survive concurrency and restart.
- [ ] Partial and unknown outcomes are reconciled before retry.
- [ ] Mutation controls detect removed claim and reconciliation safeguards.

### BQ-T5 — Test financial and UX behavior (preventive)

Prerequisite: BQ-T2–T4 and BQ-T7. Existing `packages/daemon/src/bunq/signing.test.ts` is in the tree; other tests and any missing test script are proposed.
1. Define behavioral scenarios for freeze, transfer, webhook replay, timeouts and reconciliation using independent expected effects, not mirrored implementation logic.
2. Define and wire a repeatable test script if absent; run fake-provider tests and retain negative-control evidence from BQ-T3 and BQ-T7.
3. Test keyboard and screen-reader approval, simulator labels, exact account/amount confirmation, cancellation and error states with synthetic data.

Deliverable: test and UX evidence. Verification: tests inspect actual fake-provider effects and approval state, not just status codes or counts; document any untested behavior.
- [ ] Invalid approval causes no provider mutation in intact code.
- [ ] Accessible confirmation, cancellation and error states observed or recorded as blockers.

### BQ-T6 — Stage release, provider checks and restore (preventive)

Prerequisite: BQ-T5 and **prior owner approval for sandbox deployment and account use**. Observed `packages/daemon/src/index.ts`; release and recovery runbook proposed at `docs/release-recovery.md`.
1. Establish account scope, signing, retention, incident response and recovery objectives; obtain explicit sandbox authorization and provider documentation for idempotency and reconciliation.
2. Deploy a pinned artifact to the approved sandbox; independently confirm process identity and configuration, then verify provider semantics with authorized sandbox-only scenarios and no real funds.
3. Restore a synthetic backup, inspect restored data and permissions, exercise rollback without real financial actions, and reconcile recorded state with sandbox provider responses.

Deliverable: SHA-linked sandbox, provider-semantics and restore record. Verification: retain observed outcomes and unresolved discrepancies; a backup file or successful deploy alone is insufficient.
- [ ] Sandbox access and deployment explicitly approved before use.
- [ ] Provider idempotency and reconciliation behavior independently observed or marked unresolved.
- [ ] Sandbox rollback and actual synthetic restore observed.

### BQ-T8 — Independent acceptance (preventive)

Prerequisite: BQ-T3–T7 completed, including security evidence and BQ-T6 sandbox and recovery evidence. Acceptance record proposed at `docs/release-acceptance.md`. Acceptance is performed by a named reviewer independent of implementation and test authors; a separate owner makes the release decision.
1. Assemble a release-SHA-linked evidence index covering source changes, test runs and negative controls, canary consumption/leak control, security findings, provider observations, UX and restore.
2. Reviewer checks evidence against the release artifact and requirements, independently repeats or witnesses critical boundary and recovery checks, and records exceptions and unresolved provider uncertainties.
3. Reviewer signs an accept/block decision with rationale and residual risks; owner separately decides whether to authorize any real-money release. Missing evidence blocks acceptance, not merely triggers a checklist waiver.

Deliverable: named independent acceptance record tied to the exact release SHA. Verification: compare artifact identity and evidence to that SHA, inspect actual results and confirm reviewer independence and decision authority.
- [ ] Security, negative-control, canary and recovery evidence is linked to the release SHA.
- [ ] Independent reviewer is named and has recorded accept/block with unresolved risks.
- [ ] Real-money release remains blocked until separately approved by the owner; acceptance alone does not authorize it.

## Acceptance and rollback policy

- [ ] BQ-01–05 and BQ-07–09 resolved, or residual risks explicitly documented for owner decision; BQ-06 remains historical evidence only.
- [ ] Banking permissions, credential custody, retention, privacy and regulatory boundaries approved.
- [ ] Independent acceptance and actual restore evidence correspond to the release SHA.

Real credentials, public hosting, privacy changes and real-money actions require explicit owner approval. During an incident disable effectful operations first, preserve evidence and the known-good artifact, and reconcile provider state before retry or rollback. Code rollback cannot reverse a bank action.
