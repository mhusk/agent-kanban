# Implementation Plan: Readable schedule cadence

- **Date:** 2026-11-27
- **Status:** Complete
- **Scope:** Schedule tab display only (`Upcoming` and `All Recurring`)

## Goal

Replace the raw cron under a schedule card title (for example `0 5 * * 0`) with the sentence the card editor already produces: **Every Sunday at 5:00 AM**. Interval rules use that same helper, so `every 30 days` becomes **Every 30 days after completion**.

## Assumptions & Open Decisions

- Both Schedule modes change.
- Wording comes from `describeRecurrence` in `apps/web/src/lib/recurrenceUi.ts`. Cron that helper cannot parse stays `Custom schedule (0 8 1 */3 *)`.
- Cards with no recurrence keep no cadence line. The Schedule tab does not show "Does not repeat".
- `describeRecurrenceCadence` in `apps/api/src/handlers/cards.ts` still returns the raw expression for `type: 'cron'`. REST and MCP `cadence` stay machine-readable.
- This is not a milestone step and does not move the M6.3 `[HUMAN]` gate.

## Phases & Validation Gates

### Phase 1: Render editor sentences on both Schedule modes

**Changes:**

- [x] Add `formatScheduleCadence(recurrence)` in `apps/web/src/lib/scheduleUi.ts`. Return `null` when `recurrence` is `null`; otherwise return `describeRecurrence(recurrence)`.
- [x] In `apps/web/src/pages/SchedulePage.tsx`, Upcoming and All Recurring render that helper instead of the API `cadence` string.
- [x] `apps/web/src/__tests__/scheduleUi.test.ts` locks `{ type: 'cron', expression: '0 5 * * 0' }` to `Every Sunday at 5:00 AM`, an interval case, and `null`.

**Validation Gate 1:**

- Command / check: `pnpm --filter @agent-kanban/web test && pnpm --filter @agent-kanban/web typecheck`
- Expected result: exit code 0.
- Result: passed on 2026-11-27 (32 web tests, typecheck clean).

### Phase 2: Documentation

**Changes:**

- [x] This file records the plan and the completed gates.
- [x] `docs/IMPLEMENTATION_PLAN.md` links here and marks this item specified.
- [x] `docs/PRD.md` notes that both Schedule modes show the card-editor cadence sentences, and that the API `cadence` field remains the raw rule.

**Final Validation Gate:**

- Command / check: `pnpm lint && pnpm -r typecheck && pnpm hygiene:check && pnpm --filter @agent-kanban/web test`
- Expected result: exit code 0.
- Result: passed on 2026-11-27. Lint, workspace typecheck, hygiene (167 tracked files), and 32 web tests all exited 0.
- Browser: the local app was not running (hosting `5050` and Vite `5173` were not listening), so the Schedule tab was not opened. The unit test covers `0 5 * * 0` → `Every Sunday at 5:00 AM`.
