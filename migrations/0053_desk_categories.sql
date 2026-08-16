-- The desk's governed action categories: 'sandbox' is having a machine at all
-- (terminal, filesystem, tools), 'desktop' is opening a screen on it,
-- 'shared_folder' governs writes to the company shared folder, and
-- 'background_job' governs processes that outlive a command. Kept in their own
-- migration file: the migrate runner wraps each file in one transaction, and
-- ALTER TYPE ... ADD VALUE must not share a transaction with statements that
-- use the new value.
ALTER TYPE "public"."action_category" ADD VALUE IF NOT EXISTS 'sandbox';--> statement-breakpoint
ALTER TYPE "public"."action_category" ADD VALUE IF NOT EXISTS 'desktop';--> statement-breakpoint
ALTER TYPE "public"."action_category" ADD VALUE IF NOT EXISTS 'shared_folder';--> statement-breakpoint
ALTER TYPE "public"."action_category" ADD VALUE IF NOT EXISTS 'background_job';
