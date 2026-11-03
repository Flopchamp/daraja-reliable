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

const TERMINAL: ReadonlySet<State> = new Set(['settled', 'failed']);
const QUERY_FAILURE_LIMIT = 3;

/** Returns the next state, or null when the event must not change state (audit only). */
export function next(state: State, e: Event): State | null {
  if (TERMINAL.has(state)) return null;               // forward-only

  switch (e.type) {
    case 'push_accepted':  return state === 'pending' ? 'awaiting_callback' : null;
    case 'push_rejected':  return state === 'pending' ? 'failed' : null;
    case 'push_ambiguous': return state === 'pending' ? 'push_unknown' : null;

    case 'callback':
      // A callback can only be bound to a charge whose checkoutRequestId we stored.
      return state === 'awaiting_callback' || state === 'unresolved'
        ? (e.resultCode === 0 ? 'settled' : 'failed')
        : null;

    case 'query_result':
      if (state !== 'awaiting_callback') return null;
      if (e.resultCode === 'processing') return null;
      return e.resultCode === 0 ? 'settled' : 'failed';

    case 'query_failed':
      return state === 'awaiting_callback' && e.consecutiveFailures >= QUERY_FAILURE_LIMIT
        ? 'unresolved' : null;

    case 'deadline_passed':
      return state === 'push_unknown' ? 'unresolved' : null;

    case 'manual_resolve':
      return state === 'unresolved' ? e.to : null;
  }
}
```

Note `unresolved` accepts a real callback: if the customer's payment completes late and the callback carries a stored `checkoutRequestId`, that is evidence from Safaricom, and it is allowed to resolve the charge. It is the only non-terminal state that can be resolved by an event rather than a human.

## Property tests to write first (Weekend 1)

1. For every state `s` in `{settled, failed}` and every event `e`: `next(s, e) === null`.
2. For any event sequence, rank never decreases, with rank: `pending`=0, `push_unknown`=`awaiting_callback`=1, `unresolved`=2, `settled`/`failed`=3.
3. `push_unknown` is never reachable to `settled`/`failed` by any automatic event (only via `unresolved` + callback/manual).
4. No event sequence from `pending` produces two `push_accepted` effects (the effect "send push" fires only on the `pending` row's first CAS).

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

Drop the old row "Transaction Status ..." wording; every occurrence means **STK Push Query**.

## Other corrections surfaced by the source

- Dedupe key: failed callbacks have no `MpesaReceiptNumber`; use `CheckoutRequestID` as the primary key, receipt as a secondary uniqueness check on success only.
- `parseStkCallback` already exists in the SDK: your adapter should call it instead of re-parsing (and keep your own raw-payload retention).
- The SDK's default `maxNetworkRetries` does not retry the push, so your adapter must not add retries around `stkPush` either.
- kepas README gotcha #9 ("Pull Transaction recovery") covers **C2B** only; the STK recovery path is the STK query above, so your reconciler is not duplicated by it.
- kepas is Apache-2.0 and its client needs `passkey` + `shortcode`; the adapter's peer-dependency range should be `^1.6`.
