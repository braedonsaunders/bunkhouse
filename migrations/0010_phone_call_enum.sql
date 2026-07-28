-- New governed action category for the voice/telephony layer. Kept in its own
-- migration file: the migrate runner wraps each file in one transaction, and
-- ALTER TYPE ... ADD VALUE must not share a transaction with statements that
-- use the new value.
ALTER TYPE "public"."action_category" ADD VALUE 'phone_call';
