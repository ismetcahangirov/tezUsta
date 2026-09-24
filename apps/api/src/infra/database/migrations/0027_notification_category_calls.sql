-- A later migration in the same deploy must not use 'calls': Postgres rejects a new enum value used in the transaction that added it.
ALTER TYPE "public"."notification_category" ADD VALUE 'calls';