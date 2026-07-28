CREATE TYPE "public"."price_source" AS ENUM('openrouter', 'manual');--> statement-breakpoint
CREATE TABLE "model_prices" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"model" text NOT NULL,
	"input_usd_per_mtok" numeric(19, 4) NOT NULL,
	"output_usd_per_mtok" numeric(19, 4) NOT NULL,
	"source" "price_source" NOT NULL,
	"source_ref" text,
	"effective_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" uuid
);
--> statement-breakpoint
ALTER TABLE "token_spend" ADD COLUMN "input_usd_per_mtok" numeric(19, 4);--> statement-breakpoint
ALTER TABLE "token_spend" ADD COLUMN "output_usd_per_mtok" numeric(19, 4);--> statement-breakpoint
ALTER TABLE "token_spend" ADD COLUMN "price_source" text;--> statement-breakpoint
CREATE INDEX "model_prices_lookup_idx" ON "model_prices" USING btree ("tenant_id","model","effective_at");
ALTER TABLE model_prices ENABLE ROW LEVEL SECURITY;
ALTER TABLE model_prices FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON model_prices;
DROP POLICY IF EXISTS tenant_write_insert ON model_prices;
DROP POLICY IF EXISTS tenant_write_update ON model_prices;
DROP POLICY IF EXISTS tenant_write_delete ON model_prices;
CREATE POLICY tenant_isolation ON model_prices
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

