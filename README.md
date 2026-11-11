# daraja-reliable

Idempotency, replay protection and reconciliation for M-Pesa STK Push, above any Daraja SDK.

STK Push is asynchronous, and three facts about it decide the design:

1. **Safaricom never retries a callback.** If your endpoint is down, restarting, or
   deployed mid-request, the result of that payment is gone. Nothing will resend it.
2. **STK Push accepts no caller-supplied correlation id.** `CheckoutRequestID` exists only
   in the push *response*. Lose the response and you hold a payment prompt on a
   customer's phone that you cannot identify, query, or ever bind a callback to.
3. **A failed callback carries no `MpesaReceiptNumber`.** Any dedupe scheme keyed on the
   receipt silently does nothing for the failure path.

Existing Daraja SDKs wrap the HTTP API correctly and stop there. This library is the layer
above: it owns a charge's lifecycle in Postgres so that a prompt is sent at most once, a
callback is applied exactly once however many times it is delivered, and a payment whose
outcome is genuinely unknowable ends up in front of a person instead of being guessed at.

## Status

**v0, not published to npm.** Usable, but read this list before depending on it.

| | |
|---|---|
| Initiation, idempotency, crash recovery | built, tested |
| Callback handling, replay protection, origin allowlist | built, tested |
| Postgres store with compare-and-set transitions and leases | built, tested |
| Transports: raw `fetch`, `@kepas/daraja-js` adapter | built, tested |
| **The reconciler sweep loop** | **not built.** `claimOverdue()` and `stkQuery()` exist and are tested; the loop that drives them does not. Charges stuck in `awaiting_callback` are not yet resolved automatically. |
| `chargeAgain()` for a deliberate re-push | not built |

93 tests, property tests under [fast-check](https://github.com/dubzzz/fast-check), and the
state machine is mutation-checked — deleting a guard has to fail a named test or the test
is decoration. Integration tests run against a real Postgres, because row locking is the
thing under test and a mock would prove nothing.

## Install

```bash
npm install daraja-reliable pg
```

Requires Node 20+ and PostgreSQL 13+ (the migration uses the built-in `gen_random_uuid()`).

## Usage

```ts
import pg from 'pg';
import { createReliableDaraja, PostgresStore, migrate, fetchAdapter } from 'daraja-reliable';

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
await migrate(pool); // creates dr_charges and dr_audit; idempotent

const pesa = createReliableDaraja({
  store: new PostgresStore(pool),
  transport: fetchAdapter({
    consumerKey: process.env.DARAJA_KEY!,
    consumerSecret: process.env.DARAJA_SECRET!,
    shortcode: process.env.DARAJA_SHORTCODE!,
    passkey: process.env.DARAJA_PASSKEY!,
    callbackUrl: 'https://your.app/mpesa/callback',
    environment: 'production',
  }),
  // Safaricom's current callback source IPs. This library deliberately ships no list,
  // because a stale hardcoded one fails closed at 3am. 'disabled' is allowed, and has
  // to be written out so the choice is visible in your code.
  trustedSourceIps: ['196.201.214.0/24'],
});
```

### Charging

`idempotencyKey` is yours — an invoice id, an order id, anything stable for the payment
you mean to collect. Call it as many times as you like; the customer is prompted once.

```ts
const charge = await pesa.charge({
  idempotencyKey: 'invoice-4821',
  phone: '254712345678',   // E.164 digits, no '+'
  amount: 1500,            // whole KES
  accountRef: 'INV-4821',
});

charge.state;    // 'awaiting_callback' | 'push_unknown' | 'failed'
charge.replayed; // true if this key was already known and nothing was sent
```

Reusing a key with different parameters throws `IdempotencyConflictError` rather than
returning the original charge, because that mismatch is a bug in the caller and silently
returning the wrong charge would hide it.

### The callback route

```ts
app.post('/mpesa/callback', async (req, res) => {
  const result = await pesa.handleCallback({
    rawBody: req.rawBody,  // the EXACT bytes; do not let a body parser touch them first
    sourceIp: req.socket.remoteAddress!,
  });

  res.sendStatus(200); // always 200: Safaricom will not retry, so a 500 loses the payment
  if (result.applied) await fulfilOrder(result.charge!);
});
```

`handleCallback` resolves for every input a real endpoint receives — wrong IP, malformed
body, unknown id, tenth duplicate — so the route can always answer 200. `applied` is true
for exactly one delivery of a given outcome: the one that moved the charge. Do your
fulfilment behind that flag and it runs once.

Two details that matter more than they look:

- **`rawBody` must be the unparsed request bytes.** The raw payload is retained for replay
  and for the audit trail, and a re-serialised body is not what Safaricom sent.
- **`sourceIp` must be the real peer address.** Behind a proxy, `req.ip` is the proxy
  unless trust-proxy is configured correctly — get it wrong and the allowlist either
  rejects every genuine callback or trusts a spoofed `X-Forwarded-For`.

### Crash recovery

A process that dies between writing the intent and recording the push outcome leaves a
`pending` row. `recover()` moves those to `push_unknown`. It never re-pushes.

```ts
// On boot, and on a schedule. olderThanMs MUST exceed your transport's total timeout:
// a charge is `pending` for as long as its push is in flight. Minutes, not seconds.
const stranded = await pesa.recover({ olderThanMs: 5 * 60_000 });
```

## The state machine

Transitions live in one pure function, [`next(charge, event)`](src/state.ts), with the
legal edges as an explicit set. Nothing writes a state the function did not return.

```
                     ┌──────────────────────────────► settled
                     │                                   ▲
  pending ──► awaiting_callback ──────────────┐          │
     │               │                        │          │
     │               └──► unresolved ─────────┼──────────┘
     │                         ▲              │
     └──► push_unknown ────────┘              └────────► failed
              │
              └──► awaiting_callback     (a late push response: identity recovered)
```

| State | Meaning |
|---|---|
| `pending` | Intent is durable; the push has not been accounted for yet |
| `awaiting_callback` | Safaricom accepted the push and we hold the `CheckoutRequestID` |
| `push_unknown` | The push may have reached the customer, but its response was lost — so there is no id to query with |
| `unresolved` | Out of automatic options. A person decides |
| `settled` / `failed` | Terminal. Nothing moves a charge out of these |

Two things it refuses to do, both deliberate:

**It will not settle a charge it cannot identify.** A `push_unknown` charge has no
`CheckoutRequestID`, so matching an incoming payment on `(phone, amount, accountRef)` is a
heuristic, not proof — two customers can pay the same amount against the same reference in
the same minute. Such a charge is resolvable only by `manual_resolve`. This is enforced
inside `next()`, where the property tests can reach it, rather than in calling code.

**It will not treat "accepted" as "paid."** A push Safaricom accepted is a prompt on a
phone, nothing more. Only a callback or a successful STK Push Query settles a charge.

### Identity is not state

The one bug found so far is worth describing, because the fix shaped the design.

`apply()` read a charge, decided with `next()`, then compare-and-set. On a CAS miss it gave
up. But **a CAS miss means the state moved, not that the event was inapplicable** — the
decision was made against a view that had since gone stale. That lost money two ways: a
successful push whose `CheckoutRequestID` was discarded because a recovery sweep had
overtaken it, and a callback dropped because it landed exactly as the reconciler gave up,
even though `next(unresolved, callback)` settles.

So a miss now re-reads and re-decides, and `checkoutRequestId` is persisted in its own
idempotent statement before any transition is attempted. It is *identity*, not state: the
only correlation id Safaricom ever issues, and it must not be able to die with a lost race.

Both cases are regression-tested in
[`test/integration/races.test.ts`](test/integration/races.test.ts). Full reasoning,
including where the first mutation run showed the tests had a hole, is in
[DESIGN.md](DESIGN.md).

## Testing your own integration

Safaricom's sandbox only exercises the happy path. `FakeDaraja` injects the failures that
only happen in production:

```ts
import { FakeDaraja } from 'daraja-reliable/testing';

const fake = new FakeDaraja();
fake.scriptPush('ok_but_response_lost'); // the customer IS prompted; you see a timeout

const pesa = createReliableDaraja({ transport: fake, store, trustedSourceIps: 'disabled' });
const charge = await pesa.charge({ idempotencyKey: 'test-1', ...req });
// charge.state === 'push_unknown', and a retry must not prompt the customer again
```

Behaviours: `ok`, `reject`, `http500`, `hang`, `ok_but_response_lost`. `callbackBody()`
builds payloads shaped like the real endpoint's.

## Development

```bash
npm install
docker run -d --name daraja-pg -e POSTGRES_PASSWORD=postgres -p 5433:5432 postgres:16-alpine
export DATABASE_URL=postgres://postgres:postgres@localhost:5433/postgres

npm run typecheck
npm test              # unit + integration
npm run test:unit     # no database needed
```

Integration tests truncate `dr_charges` and `dr_audit` between cases, so point
`DATABASE_URL` at a throwaway database.

## Scope

This library runs entirely on **your** Daraja credentials and never holds, routes or
aggregates anyone's funds. That is a deliberate boundary: under CBK rules, handling or
aggregating customer money in Kenya requires a Payment Service Provider licence. A
reliability layer that merchants run themselves needs none, and this will not grow into
anything that does.

## Licence

[MIT](LICENSE).
