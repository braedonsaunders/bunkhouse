-- What the provider says it charged, beside what the ledger estimated.
-- Append-only and effective by fetched_at, like model_prices: a provider that
-- finalizes a day's books later gets a new row, never an edit to one an
-- operator has already read.
CREATE TABLE "cost_reconciliations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"provider" text NOT NULL,
	"day" date NOT NULL,
	"model" text NOT NULL,
	"reported_usd" numeric(19, 4) NOT NULL,
	"ledger_usd" numeric(19, 4) NOT NULL,
	"drift_usd" numeric(19, 4) NOT NULL,
	"source_ref" text,
	"fetched_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" uuid
);
--> statement-breakpoint
CREATE INDEX "cost_reconciliations_lookup_idx" ON "cost_reconciliations" USING btree ("tenant_id","provider","day","fetched_at");--> statement-breakpoint

ALTER TABLE cost_reconciliations ENABLE ROW LEVEL SECURITY;
ALTER TABLE cost_reconciliations FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON cost_reconciliations;
CREATE POLICY tenant_isolation ON cost_reconciliations
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
