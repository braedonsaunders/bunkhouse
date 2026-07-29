# What work costs, and how we know

Salary is the product's central promise: an agent has a monthly budget in real
dollars, spends against it, and goes into visible overtime rather than quietly
running up a bill. That promise is only as good as the number in the ledger.
This is where that number comes from.

## The rule

**A cost the provider reports is money. A cost we calculate is an estimate. Bank
the first, flag the second, and never let an estimate impersonate money.**

Everything below follows from that.

## Why tokens × price is not enough

The obvious design — count tokens, multiply by a published rate — is wrong in
ways that do not average out:

- **A gateway routes one model id to several upstreams.** OpenRouter serves
  `anthropic/claude-sonnet-4.6` from the primary, a fallback, or the customer's
  own key, at different prices, chosen per request. The id in the ledger does
  not say which one answered.
- **Cache reads are discounted, and the discount is not in the token count.**
- **Token counts are not the counts the price applies to.** Providers meter in
  their own units, and a gateway's reported counts are normalized, not native.
- **Nobody publishes a machine-readable price list.** Not Anthropic, not OpenAI,
  not Google, not Deepgram, not ElevenLabs. Every static price table in every
  application is somebody transcribing a marketing page by hand, and it goes
  stale silently.

So the price table is the fallback, not the design.

## What each provider will actually tell you

| Provider | What it reports | When |
| --- | --- | --- |
| **OpenRouter** | Exact USD for the request, `usage.cost` | In the response |
| **Deepgram** | USD charged, and hours transcribed, per window | Per project |
| **Anthropic** | USD charged, per model, per day, org-wide | Next day, admin key |
| **OpenAI** | USD charged, per line item, per day, org-wide | Next day, admin key |
| **ElevenLabs** | Credits and characters — never dollars | — |
| **Google** | Nothing | — |

Three tiers, and each gets a different treatment.

### Tier one — the provider prices the request

OpenRouter will price every request as it serves it, for the cost of a flag on
the request body. `packages/runtime/src/cost.ts` sets it; the loop reads
`usage.cost` off the raw response and hands it to the spend hook, which banks it
verbatim with `price_source = 'provider'`.

Those rows carry **no** `input_usd_per_mtok` / `output_usd_per_mtok`. That is
deliberate: no single rate produced the figure, and back-solving one would put a
number in the audit trail that was never charged.

The one gap is the voice cascade. The call framework's model client takes no
request-body options, so a cascade call's LLM leg cannot ask for its own price
and is estimated from the table like anyone else. It is reconciled afterwards
along with everything else.

### Tier two — the provider prices the window

Deepgram publishes no rate card, because the rate is whatever the contract says.
It does publish the bill: what a project was charged over a window, and how many
hours it transcribed in the same window. Money ÷ minutes is *this company's*
real rate, measured rather than typed, and it moves when the contract does.

`lib/deepgram-billing.ts` measures it over a trailing 30 days; the nightly pass
re-measures. A rate an operator typed always wins — somebody entering a number
knows a contract the invoices have not caught up with.

ElevenLabs cannot be measured this way. It meters in credits whose dollar value
depends on the plan, and no endpoint reports the plan's rate. Realtime speech is
billed as model tokens. Both stay operator-entered, and the settings screen says
so instead of pretending otherwise.

### Tier three — the provider prices the day

Anthropic and OpenAI each expose a cost report behind a **separate
administration key** (an inference key is refused). Both return real USD in
daily buckets for the whole organization.

That is too coarse to charge an agent with. A daily org-wide total belongs to no
particular run, and splitting it across runs would manufacture an attribution —
exactly the invented precision this ledger exists to avoid.

So it is not spent. It is **banked beside** the ledger in
`cost_reconciliations`: what they charged, what we counted, and the gap. A gap
that persists is a price row that needs correcting, and now it is visible in
Settings → Models → Reconciliation instead of on a credit-card statement.

**The prices are never rewritten from this automatically.** A daily invoice is
an average across a day's traffic; back-solving a per-token rate from it and
silently reinterpreting future spend would be the quiet mutation the rest of the
ledger is built to prevent. An operator is shown the gap and decides.

## Matching a model to a catalogue entry

The fallback table is refreshed from OpenRouter's public catalogue, which meant
solving a naming problem. A native Anthropic key wants
`claude-haiku-4-5-20251001`; the catalogue lists `anthropic/claude-haiku-4.5`.
Suffix matching missed every Anthropic default, which is why so much spend was
landing at $0 — unmatched model, no price row, `price_source = 'unpriced'`,
cost zero.

`normalizeModelId` drops the vendor prefix, the release date, and every
separator: both sides become `claudehaiku45`. Exact ids are still tried first,
so a loose match can never displace a precise one, and `gpt-4o` never collapses
into `gpt-4o-mini`.

Models still left unpriced are listed in Settings → Models → Pricing rather than
left to be discovered.

## Immutability

Spend rows are never edited. They are what the run recorded, at the price in
force when it ran.

Prices are effective-dated and append-only, so a refresh changes what *future*
work is charged at and never reinterprets history. Reconciliation rows are the
same shape: a provider that finalizes a day's books later appends a new reading
rather than overwriting the one an operator has already seen, and a day whose
figures have not moved appends nothing at all.

## Where it runs

The nightly `money` pass in `apps/web/scripts/worker.mts`, per tenant:

1. refresh the fallback price table from the catalogue;
2. re-measure the Deepgram rate from its billing API;
3. pull each connected provider's cost report and record what moved.

Each step is independently skippable. A company with no catalogue-listed model,
no Deepgram key, or no administration key simply has less to do — and every step
is also a button in Settings, because an operator should never have to wait
until tomorrow to find out whether it works.

## What is on the ledger

`token_spend.price_source` says where every figure came from:

| Value | Meaning |
| --- | --- |
| `provider` | The provider reported this cost. It is money. |
| `openrouter` | Estimated from a catalogue price row. |
| `manual` | Estimated from a price an operator entered. |
| `unpriced` | No price row exists. The cost is $0 and that is a gap, not a fact. |
| `voice_minutes` | Speech minutes at an operator-entered rate. |
| `voice_minutes_measured` | Speech minutes at a rate measured from the provider's bill. |
