# Changelog

All notable changes to `@argosvix/mcp-server` are documented in this file.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.30.0-alpha.2] - 2026-06-20

### Added

- `mcpName: com.argosvix/server` package metadata so the server can be listed in the official MCP Registry (DNS-namespace authentication on argosvix.com).

### Fixed

- Synced `src/version.ts` `MCP_VERSION` with `package.json` (`version`). Prior 0.28–0.30 alpha bumps updated `package.json` only, so the runtime and `User-Agent` header reported `0.29.0-alpha.1` while the published version was `0.30.0-alpha.1`. The `tools.test.ts` drift guard now passes again.

### Changed

- Documented the current **76-tool** surface (72 generally available + 4 founder-ops scoped), consolidating the golden eval-dataset tools (`list` / `get` / `create` / `run` / `delete_eval_dataset`) added across the 0.28–0.30 alpha line. README, package description, and the `ARGOSVIX_API_KEY` examples (now `argk_...`) updated to match.

## [0.27.0-alpha.1] - 2026-06-11

### Added — runtime control plane + Team read + Tier 2 第三弾

- **Runtime budget gate tools (4)**: `get_budget_gate` / `create_budget_gate` / `update_budget_gate` / `delete_budget_gate` — pre-flight spend gates the agent itself checks before issuing LLM calls. Limits validated to the 0.01–1,000,000 USD range, non-finite values rejected.
- **Policy gate tools (4)**: `get_policy_gate` / `create_policy_gate` / `update_policy_gate` / `delete_policy_gate` — declarative allow/deny policies (model / provider / tag scoping) evaluated alongside budget gates.
- **Human-approval gate tools (3)**: `request_approval` / `get_approval` / `list_approvals` — agents request human sign-off for gated operations and poll the decision.
- **Team read tool (1)**: `list_members` — read-only membership listing (`GET /v1/memberships`).
- **axis 4 Tier 2 第三弾 (2, founder-ops scoped)**: `extend_customer_trial` / `apply_promo_code_to_customer` — Stripe subscription mutations; restricted to the founder dogfood account (other accounts receive 403) until the v1.8 paid expansion.
- **Tool count: 57 → 71** (67 generally available + 4 founder-ops scoped: the two Tier 2 第三弾 tools above plus `purge_expired_plaintext` / `retry_failed_webhook`). Backwards compatible.

### Intermediate releases (= 0.25.0-alpha.1 through 0.26.2-alpha.1, published 2026-06-06)

- 0.25.0-alpha.1: axis 4 Tier 2 第一弾 = `purge_expired_plaintext` + `retry_failed_webhook` (54 → 56).
- 0.26.0-alpha.1: axis 4 Tier 2 第二弾 = `auto_silence_noisy_alert` (56 → 57).
- 0.26.1 / 0.26.2-alpha.1: alert narrative fixes (alertType enum drift, windowMinutes default) + 403 narrative expansion and MCP error body surfacing.

## [0.24.0-alpha.1] - 2026-06-05

### Added — axis 4 Tier 1 closing (= 自律 AI ops 完走)

- **5 axis 4 Tier 1 tools** = the autonomous-AI-ops candidate set (T1-1 through T1-5) shipped across this and prior alpha cuts:
  - `get_account_health(window)` — fan out to 4 endpoints (aggregate / percentiles / llm-budget / audit-log) and return one summary with `ok / warn / critical` verdict. Partial endpoint failures land in `partialFailures`.
  - `detect_anomaly(window, threshold)` — current vs baseline window across cost / latency / error_rate / call_volume with sensitive (1.5×) / normal (2×) / conservative (3×) thresholds. error_rate evaluated in percent (0-100).
  - `propose_alert_rules(lookbackDays)` — analyzes the past `lookbackDays` (7-30, default 14) and proposes alert rules in JSON. Proposal-only (zero side effects); existing alert types land in `skipped`.
  - `classify_calls_batch(maxRecords)` — first axis 4 backend POST endpoint (`/v1/safety-assessments/scan-batch`). Pro+ plan required, OpenAI Moderation, `source='mcp'`. Rate limit 30 req / 60 s sliding window.
  - `propose_eval_criteria(useCaseHint, sampleCallIds?, maxCriteria?)` — Tier 1 closing tool. LLM judge (gpt-4o-mini) proposes evaluation criteria from a use-case hint and optional sample calls. Pro+ only; emits `eval.propose_criteria`. Rate limit 30 req / 60 s sliding window.
- **Tool count: 53 → 54** (= 28 read + 26 write). Backwards compatible.

### Changed

- `package.json` description mentions `eval-criteria-propose` path.
- Tool descriptions for safety / propose tools clarified to include the rate limit narrative and (for propose_eval_criteria) the explicit reminder that sample content is sent to OpenAI gpt-4o-mini for proposal generation.

### Notes

- Backwards compatible with the v0.13–v0.23 stdio + HTTP transports.
- Backend dependency: `argosvix-ingest` worker version `98dd3d9f` or later, with migration 0057 (`safety_assessments` UNIQUE INDEX) applied to production D1 for full structural defense against duplicate INSERTs (see `docs/handoff/deploy-runbook.md` section 13).
- Cumulative Codex review on the axis 4 Tier 1 chain: 3 rounds (R20 / R21 / R22), 0 ship blockers across all rounds.

### Intermediate releases (= 0.14.0-alpha.1 through 0.23.0-alpha.1)

Detailed entries for the 0.14–0.23 releases (= annotations CRUD, eval criterion CRUD, alert update / delete, test_webhook, budget_raise, prompt CRUD, axis 1 続編 +13 tools, axis 4 Tier 1 +4 tools) are tracked in `docs/handoff/roadmap.md` under the "MCP server 詳細" table and in `docs/handoff/v1.6-backlog.md` under #13. The progression: 16 → 23 → 26 → 30 → 33 → 36 (= v1.5 closure) → 49 (= axis 1 続編) → 53 (= axis 4 T1-1〜T1-4) → 54 (= axis 4 T1-5 closing).

## [0.13.0-alpha.1] - 2026-06-02

### Added
- **2 new prompt registry tools** (= v1.5 Round F prompt management):
  - `list_prompts(label?, name?, limit?)` — list saved prompt templates with optional
    label or name filter (limit 1–200).
  - `get_prompt(promptId)` — fetch a single prompt by AUTOINCREMENT id.
- **`argosvix://prompts/{id}` resource template** — AI agents can fetch a prompt
  template (name + version + template body + variables + labels + description)
  directly via URI. Backend `GET /v1/prompts/:id` (= migration 0038 prompt_registry
  table, applied 2026-06-02) was shipped in the same release. Projection drops
  `accountId` and `createdByUserId`; `template`, `name`, `description` are passed
  through `sanitizeText` (50000 / 64 / 500 char caps).
- New helpers `assertPromptShape`, `projectPromptForMcp`.

### Changed
- Tool count: 14 → 16. Resource template count: 5 → 6.
- `package.json` description updated to mention prompts surface.

### Notes
- Backwards compatible with v0.12.x stdio + HTTP transports.
- Backend dependency: `argosvix-ingest` worker must include `/v1/prompts/*` CRUD
  (= commit shipping this release, deployed Worker version `4be09f85`).

## [0.12.1-alpha.1] - 2026-06-02

### Added
- **`create_alert` accepts `conditions` (= v1.5 multi-condition rule)** — JSON schema
  for AND/OR aggregation of 1-8 sub-conditions, each carrying its own `metric` /
  `threshold` / `windowMinutes` / `comparator`. When present, the backend evaluator
  switches from the single-metric path to the multi-condition path. When omitted /
  null, the existing single-metric `alertType` + `thresholdValue` semantics stay
  intact. Backend validation in `parseConditionsJson` rejects malformed shapes with
  a 400 narrative.

### Notes
- Backwards compatible with v0.12.0 stdio + HTTP transports.
- Backend dependency: `argosvix-ingest` worker ≥ commit `40a572f` (= Round C 第2段、
  handler.ts accepts conditions in POST/PATCH).

## [0.12.0-alpha.1] - 2026-06-02

### Added
- **2 new eval criteria tools** (= v1.5 LLM-as-judge surface expansion):
  - `list_eval_criteria()` — list global default 5 軸 (helpfulness / accuracy / relevance / safety / conciseness) + own-account custom criteria.
  - `get_eval_criterion(criterionId)` — fetch a single criterion by AUTOINCREMENT id (Free plan can read, custom create/edit is Pro+ only).
- **`argosvix://eval-criteria/{id}` resource template** — AI agents can fetch a single criterion's rubric directly. Backend `GET /v1/eval-criteria/:id` was added in the same release. `rubric` is sanitized through `sanitizeText` with a 4000 char cap (judge instructions can be long); `accountId` is dropped from the projection (= internal scope).
- New helpers `assertCriterionShape`, `projectCriterionForMcp`.

### Changed
- Tool count: 12 → 14. Resource template count: 4 → 5.
- `package.json` description updated to mention eval-criteria.

### Notes
- Backwards compatible with v0.11.x stdio + HTTP transports.
- Backend dependency: `argosvix-ingest` worker must include `GET /v1/eval-criteria/:id` (= same release).

## [0.11.0-alpha.1] - 2026-06-02

### Added
- **3 new annotation tools** (= v1.5 annotation MCP carry):
  - `list_annotations_for_call(callId)` — list all annotations attached to a single LLM call.
  - `list_annotations_by_label(label, limit?)` — list annotations by label across the account (limit 1–100, default 20).
  - `get_annotation(annotationId)` — fetch a single annotation by AUTOINCREMENT id.
- **`argosvix://annotations/{id}` resource template** — AI agents can fetch a single annotation via URI directly. Backend `GET /v1/annotations/:id` was added to the backend in the same release. Projection drops `accountId` (= internal scope) and `createdByUserId` (= internal user sub); `annotationText` and `label` are passed through `sanitizeText` (= control-char strip + 2000 / 64 char caps) to harden the prompt surface.
- New helpers `validateCallId`, `validateAnnotationId`, `validateAnnotationLabel`, `assertAnnotationShape`, `projectAnnotationForMcp`.

### Changed
- Tool count: 9 → 12. Resource template count: 3 → 4.
- `package.json` description updated to reflect the new annotation surface.

### Notes
- Backwards compatible with v0.10.x stdio + HTTP transports.
- Backend dependency: `argosvix-ingest` worker must include `GET /v1/annotations/:id` (= same release).

## [0.10.0-alpha.5] - 2026-06-01

### Added
- **PagerDuty channel kind** in `ALLOWED_CHANNEL_KINDS` allowlist (`resources.ts`). MCP clients (Claude Desktop / Cursor / etc.) can now observe PagerDuty channels in alert resource projections; previously the channel kind was silently dropped via `filterChannelKinds`.
- **`__skipped_by_plan__` sentinel pass-through** in `filterChannelKinds`. Alert events that the backend deferred due to plan-based channel filtering (`channelsSent = ["__skipped_by_plan__"]`) are now preserved end-to-end, letting AI agents accurately distinguish "skipped by plan" from "dispatch failed" via the `argosvix://alerts/{id}` resource template.
- **Drift-gate regression test** updated to 6 channel kinds (`discord`, `email`, `pagerduty`, `slack`, `teams`, `webhook`) so a future addition to the backend `ChannelKind` enum without matching MCP allowlist update will be caught in CI.

### Fixed
- Round 6 adversarial review MEDIUM 2 (= MCP / backend channel allowlist drift). Backend shipped PagerDuty channel + `__skipped_by_plan__` sentinel in v1.5 carry chain; MCP server did not update its allowlist, so PagerDuty alerts and plan-skipped events were invisible through MCP. This release closes the drift.

### Notes
- Backwards compatible with v0.10.0-alpha.4 stdio + HTTP transports, 9 tools, 4 resources (account + alerts/active + cost/today + 3 templates), 3 prompts, subscribe capability.
- No backend API contract change required.

## [0.10.0-alpha.4] - 2026-05-31

### Added
- **`resources.subscribe` capability (stdio only)** — clients can subscribe to any of 3 static resources (`argosvix://account`, `argosvix://alerts/active`, `argosvix://cost/today`); the server polls each at 60-second intervals and emits `notifications/resources/updated` when the content hash changes.
- **Wire-level regression test** for JSON-RPC `-32602` mapping when a non-subscribable URI is requested via `resources/subscribe` (via `InMemoryTransport` + Client / Server pair).
- **Overlap single-flight test** that proves slow polling cycles do not overlap.

### Changed
- HTTP transport (`argosvix-mcp --http`) intentionally does **not** declare `subscribe` capability; subscribe requests are rejected with SDK default `-32601 Method not found`.
- `listChanged` is intentionally **not** declared (resource list is fixed for the server lifetime).
- Debug logging (`ARGOSVIX_MCP_DEBUG=1`) logs `{ uri, errorClass }` instead of full error messages to avoid leaking upstream payload text.

### Fixed
- **Single-flight polling guard** (`pollInFlight`) prevents slow cycles from starting concurrent next cycles.
- **Shutdown / unsubscribe race** — `isShuttingDown` flag plus per-URI re-check before fetch and before notify suppresses notifications for URIs removed mid-cycle.
- Invalid subscribe URIs now throw `McpError(InvalidParams)` (was raw `Error` → SDK mapped to internal error).
- Test scaffolding hardened against schema-identity drift (handlers fetched by `SubscribeRequestSchema` reference, not array index).

### Internal
- `setupSubscribe()` module factory with explicit `SubscribeManager` interface (subscribe / unsubscribe / shutdown / pollNow / snapshot).
- `pollIntervalMs` override for unit tests; production default = 60 s.
- `unref()` on the polling timer so the server process can exit when nothing else holds the event loop.

### Notes
- `@argosvix/mcp-server@alpha` dist-tag now points to `0.10.0-alpha.4`.
- npm publish was performed locally because the GitHub Actions workflow (`publish-mcp.yml`) requires either an `NPM_TOKEN` repo secret or OIDC trusted-publisher setup, neither of which is configured yet. See workflow header for the setup paths.

## [0.2.0-alpha.1] - 2026-05-29

### Added
- **Write tools**: `silence_alert` and `unsilence_alert` for AI agents to mute / resume specific alerts directly from conversation.
  - `silence_alert(alertId, until?)` — defaults to 24 hour mute; `until` accepts any ISO-8601 timestamp.
  - `unsilence_alert(alertId)` — immediately resumes notifications.

### Security
- `alertId` is validated against the backend regex `[A-Za-z0-9-]{1,64}` and URL-encoded before being inserted into the request path, defending against path injection from prompt-injected agents.
- `204 No Content` responses from the backend are normalized to `{ ok: true, status: 204 }` so MCP clients always receive a well-formed result body.

## [0.1.0-alpha.1] - 2026-05-29

### Added
- Initial alpha release with stdio transport and 3 read-only tools:
  - `query_calls` — recent LLM call records, filterable by provider / model / range.
  - `get_cost_summary` — aggregate cost / calls / tokens by provider or model.
  - `list_alerts` — configured alerts plus recent trigger status.
- Argument allowlist + `additionalProperties: false` on every input schema to defend against prompt-injected extra parameters reaching the Argosvix backend.
- `ARGOSVIX_API_KEY` env var auth; `ARGOSVIX_API_BASE` for self-hosted instances or local development.
