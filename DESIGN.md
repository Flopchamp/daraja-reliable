# Charge state machine v2 (fixes review point 1)

Basis: `@kepas/daraja-js@1.6.3` source, read 2026-11-01.

## What the source confirmed

| Question | Finding (from `dist/index.js`, `index.d.ts`) |
|---|---|
| Which endpoint does the reconciler use? | `status.stkPush` -> `/mpesa/stkpushquery/v1/query`, **synchronous**, keyed by `CheckoutRequestID`, passkey auth. NOT `status.transaction`. |
| What is Transaction Status? | `/mpesa/transactionstatus/v1/query`, **async** (result posted to your `resultUrl`), needs initiator + security credential, keyed by receipt or `OriginatorConversationID`. Wrong tool for STK reconciliation. |
| Can a lost push be queried without a `CheckoutRequestID`? | No. `StkStatusInput` is only `{ checkoutRequestId }`. STK Push has no caller-supplied id (`OriginatorConversationID` exists only for B2C v3 / Transaction Status). |
| Does the SDK retry the push? | No, with one exception. `stkPush` calls `http.post` without `retryable`, so 5xx, timeouts and network errors are never re-sent. The exception: a 401 triggers one token refresh and a re-send (safe, since a 401 means nothing was processed). It throws `DarajaConnectionError` on timeout, and that is exactly the ambiguous case. |
| How does a "still processing" STK query surface? | **Not verified.** The SDK has no representation for it: `StkStatusResult.resultCode` is a *string* and `success` is only `ResultCode === "0"`. From my knowledge of Daraja (not in this source), a query made while the transaction is in flight tends to come back as an HTTP 5xx error, which the SDK retries and then throws as `DarajaHttpError`. Confirm in the sandbox before relying on it. |
| Does the SDK dedupe or persist? | No. Its README: "keeps no replay cache". Confirms the gap. |

Consequence: the v1 claim "crash between intent write and push: intent recoverable; reconciler resolves it" is **false**. If the push result is lost there is no id to query, so no one (library, SDK, Safaricom) can say whether a prompt reached the customer.

## The fix: add an explicit `push_unknown` state and make "exactly once" honest

Guarantee, restated: **at most one push per idempotency key, unless the integrator explicitly authorises a re-push after an ambiguous outcome.** The library never silently re-pushes.

```
pending --(push returns ResponseCode 0)--------> awaiting_callback
pending --(push returns rejection, e.g. bad msisdn/amount)--> failed        [definitive: Safaricom said no]
pending --(timeout / network error / crash, no response)----> push_unknown  [ambiguous]
awaiting_callback --(callback ResultCode 0)----> settled
awaiting_callback --(callback ResultCode != 0)-> failed
awaiting_callback --(deadline passes)----------> [reconciler: stkPush query]
     query ResultCode 0 ---------> settled
     query ResultCode != 0 ------> failed        (1032 cancelled, 1037 timeout, ...)
     query "still processing" ---> stay awaiting_callback, attempts++, retry next sweep
     query throws (5xx / network) -> counts as "unavailable"; 3 consecutive sweeps -> unresolved
       (CAUTION: if in-flight queries really surface as 5xx, a slow-but-live charge looks identical
        to an outage. Mitigation: only count failures after the callback deadline + grace period,
        and make the failure threshold time-based, not sweep-count based. Verify in sandbox.)
push_unknown --(deadline passes)---------------> unresolved   [nothing to query]
unresolved --(human/integrator action)---------> settled | failed   [only via explicit resolve(), audited]
settled / failed: terminal. Late callbacks are logged to raw_payloads, state unchanged.
```

Rules:

1. **`push_unknown` is never auto-resolved and never auto-retried.** Why: a retry may produce a second prompt; a "failed" guess may hide a payment. Because the customer pays against a prompt they saw, a late callback for the original push can still arrive, and it may carry a `CheckoutRequestID` we never stored.
2. **Late callback for a `push_unknown` charge:** match on `MerchantRequestID`/`CheckoutRequestID` is impossible (unknown), so match on `(phone, amount, accountRef)` within the push window is a heuristic, not proof. Do **not** auto-settle on it. Record the payload, surface it in the `unresolved` event with the candidate charge id.
3. **Re-push is an explicit API:** `pesa.chargeAgain(id, { acknowledgeDuplicateRisk: true })` creates a new attempt row linked to the same charge. Default `charge()` with the same key on a `push_unknown`/`unresolved` charge returns the existing charge, never pushes.
4. **Transitions are compare-and-set on `(id, expected_state)`** in one SQL statement (`UPDATE ... WHERE id=$1 AND state=$2`). No read-then-write.
5. **Intent row is written first**, with `attempt = 1`, `push_started_at`, and the request fingerprint (`sha256(phone|amount|accountRef)`). Same key + different fingerprint = `IdempotencyConflictError`, not the original charge.

## Pure transition function (TypeScript)

```ts
export type State =
  | 'pending' | 'push_unknown' | 'awaiting_callback'
  | 'settled' | 'failed' | 'unresolved';

export type Event =
  | { type: 'push_accepted'; checkoutRequestId: string }
  | { type: 'push_rejected'; reason: string }
  | { type: 'push_ambiguous' }                       // timeout, network error, crash recovery
  | { type: 'callback'; resultCode: number }
  | { type: 'query_result'; resultCode: number | 'processing' }
  | { type: 'query_failed'; consecutiveFailures: number }
  | { type: 'deadline_passed' }
  | { type: 'manual_resolve'; to: 'settled' | 'failed' };

/** The part of a charge the rules depend on; the `Charge` row satisfies it structurally. */
export interface ChargeView {
  state: State;
  checkoutRequestId: string | null;
}

const TERMINAL: ReadonlySet<State> = new Set(['settled', 'failed']);
const QUERY_FAILURE_LIMIT = 3;

// Events that are Safaricom's evidence about one specific charge. They require an id.
const NEEDS_CHECKOUT_ID = new Set<Event['type']>(['callback', 'query_result', 'query_failed']);

/** Returns the next state, or null when the event must not change state (audit only). */
export function next(c: ChargeView, e: Event): State | null {
  if (TERMINAL.has(c.state)) return null;             // forward-only
  if (c.checkoutRequestId === null && NEEDS_CHECKOUT_ID.has(e.type)) return null;

  switch (e.type) {
    case 'push_accepted':  return c.state === 'pending' || c.state === 'push_unknown'
                                  ? 'awaiting_callback' : null;   // see "Identity is not state"
    case 'push_rejected':  return c.state === 'pending' ? 'failed' : null;
    case 'push_ambiguous': return c.state === 'pending' ? 'push_unknown' : null;

    case 'callback':
      return c.state === 'awaiting_callback' || c.state === 'unresolved'
        ? (e.resultCode === 0 ? 'settled' : 'failed')
        : null;

    case 'query_result':
      if (c.state !== 'awaiting_callback') return null;
      if (e.resultCode === 'processing') return null;
      return e.resultCode === 0 ? 'settled' : 'failed';

    case 'query_failed':
      return c.state === 'awaiting_callback' && e.consecutiveFailures >= QUERY_FAILURE_LIMIT
        ? 'unresolved' : null;

    case 'deadline_passed':
      return c.state === 'push_unknown' ? 'unresolved' : null;

    case 'manual_resolve':
      return c.state === 'unresolved' ? e.to : null;
  }
}
```

### Why `next` takes the charge and not just the state

`unresolved` is reached by two routes, and they are not equally trustworthy.

From `awaiting_callback`, after repeated query failures, the `CheckoutRequestID` is
stored — so a late callback is genuine evidence from Safaricom and may resolve the
charge. From `push_unknown` no id was ever stored, because STK Push returns the only
correlation id in the response that was lost. Nothing can honestly bind there, and
matching on `(phone, amount, accountRef)` is a heuristic, not proof: two customers can
pay the same amount against the same reference in the same minute.

The state alone cannot tell those apart, so a `next(state, event)` signature pushes the
guard out into the callback-lookup code, where the exhaustive property test cannot reach
it — a test that passes while the hazard lives elsewhere. `checkoutRequestId === null`
puts it back inside the function. An unidentified charge is therefore resolvable only by
`manual_resolve`, which is the intended guarantee.

## Identity is not state (Weekend 2 fix)

Weekend 2's `apply()` read a charge, decided with `next()`, then compare-and-set. On a CAS
miss it recorded `ignored` and stopped. That is wrong, and it cost money twice:

- **`recover()` sweeping a push still in flight.** The sweep moves the row to
  `push_unknown`; the push then succeeds; the CAS expecting `pending` misses, and the
  `CheckoutRequestID` riding in its patch is discarded. The customer has paid, and the
  callback arrives as `unknown_charge` — unbindable for good.
- **A callback landing as the reconciler gives up.** `query_failed` moves the row to
  `unresolved`; the in-flight callback's CAS misses. `next(unresolved, callback)` returns
  `settled`, so it *was* applicable — but it is thrown away and a person has to resolve a
  charge Safaricom already confirmed. The two timers are deliberately set to the same
  window, so this is not an edge case.

One root cause: **a CAS miss means the state moved, not that the event was inapplicable.**
`next()` was decided against a view that is now stale. Two changes:

1. **Re-read and re-decide on a miss**, bounded by `MAX_CAS_ATTEMPTS`. Exactly-once is
   preserved by the CAS itself, not by deciding only once — a loser that re-reads a
   terminal row gets `null` from `next()` and reports `already_terminal`.
2. **Persist `checkoutRequestId` in its own statement** (`SET checkout_request_id =
   COALESCE(checkout_request_id, $2) WHERE id = $1`), before the transition is attempted.
   It is *identity*, not state: the only correlation id Safaricom ever issues, present
   solely in the push response, and without it no callback can ever bind. It must not be
   able to die with a lost race. Idempotent, state-independent, first write wins.

`push_unknown->awaiting_callback` becomes a legal edge as a consequence: a push response
that arrives after the sweep wrote the charge off carries the id, which is strictly more
information than we had. Learning identity is an upgrade, not a regression. `unresolved`
is deliberately excluded — a charge on a person's desk is not taken back off it behind
their back, though its id is still recorded so a later callback can settle it.

Mutation-checked: disabling the retry, the separate identity write, or the new edge each
fails at least one test. The identity write initially survived, because the retry path
carries the patch into `transition`'s own `COALESCE`; the surviving mutant was the signal
for the missing case — a push response arriving once the charge has already reached
`unresolved`, where no transition is taken to carry the id at all.

## Reconciler and outbox (Weekend 4)

Two pieces, built together because the reconciler is useless without somewhere to put what
it finds.

### The outbox: an event exists iff its transition committed

Fulfilment must happen once per outcome, but "the charge moved" and "tell the application"
are two writes, and any gap between them loses or invents events. `PostgresStore.transition`
therefore does both in **one statement**: a data-modifying CTE updates the charge, and a
second CTE inserts into `dr_outbox` from the rows the first returned.

- A data-modifying CTE always runs to completion even though the outer `SELECT` never
  references it, so the insert cannot be skipped.
- When the compare-and-set matches no row, the update returns nothing and so the insert
  selects nothing. A losing writer writes no event. Twenty callbacks that all read stale
  state produce exactly one `settled` event, and that is tested.
- Only `settled`, `failed` and `unresolved` are announced, and only when the state actually
  changed (`state <> $2`). Moves like `pending -> awaiting_callback` write none.
- `discrepancy` is the exception: it is not a transition, so it goes through
  `appendOutbox` — raised when two sources of truth disagree about a charge that is already
  terminal (a callback vs. the recorded state, or a reconciler query vs. a callback).
  Forward-only means we never overwrite; we say so instead.

### Delivery is at-least-once, on purpose

`dispatch()` claims events with `FOR UPDATE SKIP LOCKED` and a lease (`claimed_until`), runs
the handlers, then sets `delivered_at`. A handler that throws has its event kept and its
lease pushed out by `redeliveryDelayMs`, so redelivery reuses the same column rather than
adding a retry table. `attempts` is incremented on claim and handed to the handler as
`attempt`.

Exactly-once delivery to arbitrary application code is not available: the handler's side
effect and `delivered_at` cannot share a transaction. So the contract is stated rather than
hidden — handlers must be idempotent, keyed on `charge.id`.

Decisions that look arbitrary and are not:

- **No listener, no claim.** `dispatch()` only claims types that have a handler. Claiming
  an event nobody can handle would burn an attempt and delay it; leaving it untouched means
  a process that registers its handler later still receives it.
- **Reconcile ends by dispatching, and ignores dispatch failures.** Delivery trouble must
  not mask a sweep that finished and mutated state.
- **Per-batch lease, not per-sweep.** `reconcile()` claims `min(concurrency, remaining)`
  charges at a time, so a lease covers one batch (about one transport timeout) rather than
  the whole sweep. A charge still in flight keeps its lease, which is also what stops the
  loop re-claiming it forever.
- **An unknown charge is not silently dropped.** If an outbox row's charge no longer exists,
  that is a delivery failure like any other: the event stays and is retried.

### What the reconciler does with each answer

| Situation | Result |
|---|---|
| `push_unknown` past the deadline | `unresolved`. No id, nothing to query, never guessed |
| Query says `processing` | Leave it. Reset the failure streak, since we got an answer |
| Query gives a result code | Same compare-and-set as a callback: `settled` or `failed` |
| Query throws, charge younger than `deadline + grace` | Not counted. A query made while the prompt is live can look like an outage |
| Query throws, older than that | `queryFailures++`; the third failure moves it to `unresolved` |
| Lost the CAS and the row is terminal, answers disagree | `discrepancy` event, no overwrite |
| Lost the CAS and the row is terminal, answers agree | Nothing: a callback got there first |

The age rule is the mitigation the table at the top flagged: whether an in-flight query
surfaces as a 5xx is still unverified against the sandbox, so failures are only held against
a charge once its callback is long overdue.

### Known limits

- A handler that runs longer than `leaseMs` can be redelivered while it is still running.
  Keep handlers short or make them hand off to a queue.
- Order is preserved within one claimed batch, not across dispatchers or across redeliveries.
- `chargeAgain()` is still not built.

### How this was checked

32 tests cover the sweep, the outbox invariant, and delivery, including two reconcilers and
two dispatchers racing on one database. Before adding a mutation tool I broke the
reconciler and outbox by hand seven ways; each was caught by a test.

Then Stryker, scoped to only the Weekend 4 lines (`stryker.config.json`), one mutant at a
time because the tests share a database. First run: **80.0%** (167 killed, 36 survived, 6
uncovered). The survivors were real gaps, not noise, and 10 tests were added for them:

- a recorded *failure* contradicted by a successful query raised no discrepancy (only the
  reverse direction was tested);
- an identical duplicate callback was never asserted to raise **no** discrepancy, so a
  mutant that flagged every duplicate passed;
- the `not_applicable` callback result had no coverage at all;
- the exact `deadline + grace` boundary, the per-outcome counters, the `limit` cap when
  `concurrency` is larger, the `receipt_already_used` payload, and unsubscribing one of two
  handlers.

Second run: **90.5%** (189 killed, 1 timeout, 17 survived, 3 uncovered; `reliable.ts` 94.9%,
`pg-store.ts` 67.7%). One more assertion was added afterwards (that `transition()` persists
its `checkoutRequestId` patch); the run was not repeated after it, so the score above does
not include it. The remaining survivors, and why they are left:

| Survivors | Why they survive |
|---|---|
| `claimOutbox` `.sort()` (7, `pg-store.ts`) | Postgres does return `UPDATE ... RETURNING` rows in id order in practice, so no test can observe the sort. It stays as a guard for a guarantee SQL does not give. |
| `types.length === 0` guards (3) | Duplicated in `dispatch()` and `claimOutbox`, and `ANY('{}')` matches nothing anyway. Defence in depth, not a gap. |
| `failures < QUERY_FAILURE_LIMIT` (2) | `next()` enforces the same limit, so the early return is a shortcut. |
| `queryFailures > 0` → `>= 0` or `true` (2) | Only adds a harmless extra write of 0. |
| `if (l)` in unsubscribe (1) | `l` is always defined there; the mutant behaves identically. |
| `payload === undefined` (1) | pg turns an `undefined` parameter into NULL. |
| `handlers.get(e.type) ?? []` (1, uncovered) | `dispatch()` only claims types that have a handler, so the fallback is unreachable. |
| `transition()` patch persistence (1, `checkoutRequestId`) | Real gap, closed by the assertion added after this run. |
| Charge missing when delivering (2 incl. uncovered) | An outbox row cannot outlive its charge under the foreign key, so there is no way to reach it from a test. |

A mutation score is a measure of the tests, not a proof of the code. It says these tests
notice most one-line breakages in this code, and the table says which they do not.

**Test-environment note.** The tests compare the host clock with the database's own `now()`
and allow only about one second between them. A database in a VM whose clock has drifted
(this happened after a WSL restart) fails the sweep tests with `checked: 0`, which looks
like a code bug and is not. Sync the database host's clock before trusting such a failure.

Harness bug found on the way: `freshDb()` ran in every `beforeEach` and opened a new pool of
20 connections each time, closing only the last. Against a Postgres with `max_connections =
100` the suite failed partway with "remaining connection slots are reserved". It now reuses
one pool per file. This probably also explains the single unexplained worker crash seen in
the first run of the new tests, though that was not reproduced to confirm.

## Property tests to write first (Weekend 1)

1. For every terminal state and every event, with or without an id: `next(c, e) === null`.
2. Every transition taken appears in `ALLOWED_EDGES`, an explicit set of legal `from->to`
   pairs. This replaces the earlier monotonic-rank property, which was unsound:
   `push_unknown` and `awaiting_callback` are parallel branches rather than successive
   stages, so no rank orders them, and tying their rank permits illegal sideways moves
   between the two.
3. A charge with `checkoutRequestId === null` never reaches `settled`/`failed` by any
   automatic event. (`pending` is excluded: a definitively refused push goes straight to
   `failed` and needs no id, because nothing was queued.)
4. `push_accepted` yields `awaiting_callback` from exactly `pending` and `push_unknown`,
   and `null` everywhere else — including `unresolved`, which a human owns.
5. Safaricom's evidence — `callback`, `query_result`, `query_failed` — cannot move a
   charge with no id, from any state.

The effect-level property — that no event sequence produces two "send push" effects —
needs the store's compare-and-set and belongs to Weekend 2.

Each of these must be mutation-checked: deleting the `NEEDS_CHECKOUT_ID` guard has to
fail tests 3, 5 and the `unresolved` example, or they are decoration.

## Mapping SDK outcomes to events (the adapter's job, and where bugs will hide)

| What `stkPush` does | Event | Why |
|---|---|---|
| Returns, `ResponseCode "0"` | `push_accepted` | Safaricom queued it |
| Throws from `ResponseCode != "0"` (HTTP 200) | `push_rejected` | Definitive: Safaricom said no |
| `DarajaValidationError` (bad phone/amount, thrown before any request) | `push_rejected` | Nothing was sent |
| `DarajaAuthError` (401) | `push_rejected` | Rejected before processing |
| `DarajaHttpError` 4xx other than 401 | `push_rejected` | Request not accepted |
| `DarajaHttpError` 5xx | `push_ambiguous` | Server may have queued it |
| `DarajaConnectionError` (timeout / network) | `push_ambiguous` | Same |

Default to `push_ambiguous` for any error class the adapter does not recognise; a wrongly ambiguous charge costs a manual check, a wrongly rejected one can hide a live prompt.

Type normalisation: `parseStkCallback().resultCode` is a number, `status.stkPush().resultCode` is a string. Convert both to number before calling `next()`.

Weekend 3 note: the callback handler looks a charge up by `CheckoutRequestID`, which
cannot match a `push_unknown` row. When the candidate match on
`(phone, amount, accountRef)` is added, it must only attach the candidate id to the
`unresolved` event for a human to read — never feed that charge to `next()` as if the
payload were proof. The guard makes that safe by construction rather than by discipline.

## Matrix changes (replace/add rows in section 10)

| Failure injected | Required behaviour | Test type |
|---|---|---|
| Push times out (fake hangs 30s) | Charge `push_unknown`; **zero** further pushes; `unresolved` after deadline | integration |
| Crash after intent write, before response stored | On restart, row is `pending` with no `checkoutRequestId` -> recovery marks `push_unknown` (never re-pushes) | integration |
| Push returns 500 | Treated as ambiguous -> `push_unknown` (the SDK also won't retry) | unit |
| Push rejected (invalid msisdn) | `failed` immediately, no callback expected | unit |
| STK query says "still processing" | Stays `awaiting_callback`, attempts++ | unit |
| Same key, different amount | `IdempotencyConflictError`, no push | unit |
| Callback arrives for a `push_unknown` charge's real prompt | Payload retained, `unresolved` event carries candidate id, state not auto-settled | integration |
| `recover()` sweeps a charge whose push is still in flight | Late `push_accepted` keeps its id and rejoins `awaiting_callback`; the callback still settles | integration |
| Callback's CAS misses because the reconciler moved the row to `unresolved` | Re-decided against the fresh state and applied: `settled`, audited `unresolved->settled` | integration |
| Push response arrives when the charge is already `unresolved` | State unchanged (a human owns it), but the id is recorded so a later callback settles it | integration |
| Callback's CAS misses because the row is already terminal | `already_terminal`, `duplicate: true`, and no second transition recorded | integration |

Drop the old row "Transaction Status ..." wording; every occurrence means **STK Push Query**.

## Other corrections surfaced by the source

- Dedupe key: failed callbacks have no `MpesaReceiptNumber`; use `CheckoutRequestID` as the primary key, receipt as a secondary uniqueness check on success only.
- `parseStkCallback` already exists in the SDK: your adapter should call it instead of re-parsing (and keep your own raw-payload retention).
- The SDK's default `maxNetworkRetries` does not retry the push, so your adapter must not add retries around `stkPush` either.
- kepas README gotcha #9 ("Pull Transaction recovery") covers **C2B** only; the STK recovery path is the STK query above, so your reconciler is not duplicated by it.
- kepas is Apache-2.0 and its client needs `passkey` + `shortcode`; the adapter's peer-dependency range should be `^1.6`.
