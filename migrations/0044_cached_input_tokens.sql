-- What the prompt cache actually saved, on the ledger beside what it cost.
--
-- A tool-using run re-sends its whole head every step, so most of an agent's
-- bill is the same tokens over and over. Providers discount that head heavily
-- when they recognise it — a tenth of the input price on several — but only if
-- the head really is unchanged and the request really does land on the upstream
-- that holds it. Both of those are easy to break silently, and the only way to
-- know whether caching is working is to record the provider's own count of what
-- it served from cache.
--
-- Kept as a plain count rather than a saving in money: the discount rate varies
-- per provider and per TTL, the cost column already carries the authoritative
-- figure where the provider reports one, and a token count stays true whatever
-- the pricing does next.
alter table token_spend
  add column if not exists cached_input_tokens bigint not null default 0;

comment on column token_spend.cached_input_tokens is
  'Of input_tokens, how many the provider served from its prompt cache. Already included in input_tokens; recorded separately so cache effectiveness is measurable.';
