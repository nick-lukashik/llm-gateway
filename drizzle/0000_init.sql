CREATE TABLE "llm_calls" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"client" text NOT NULL,
	"purpose" text,
	"model" text NOT NULL,
	"effort" text NOT NULL,
	"provider" text NOT NULL,
	"account" text NOT NULL,
	"idempotency_key" text,
	"job_id" uuid,
	"outcome" text NOT NULL,
	"error_message" text,
	"tokens_in" integer,
	"tokens_out" integer,
	"duration_ms" integer NOT NULL,
	"queue_ms" integer NOT NULL,
	"corrected" boolean DEFAULT false NOT NULL,
	"request" jsonb NOT NULL,
	"response" jsonb,
	"created_at" timestamp (3) with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "llm_jobs" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"client" text NOT NULL,
	"status" text DEFAULT 'queued' NOT NULL,
	"request" jsonb NOT NULL,
	"purpose" text,
	"result" jsonb,
	"error" jsonb,
	"attempts" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	"started_at" timestamp (3) with time zone,
	"finished_at" timestamp (3) with time zone
);
--> statement-breakpoint
CREATE TABLE "provider_pauses" (
	"provider" text NOT NULL,
	"account" text NOT NULL,
	"until" timestamp (3) with time zone NOT NULL,
	"reason" text NOT NULL,
	"updated_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "provider_pauses_provider_account_pk" PRIMARY KEY("provider","account")
);
--> statement-breakpoint
CREATE INDEX "llm_calls_created_at_idx" ON "llm_calls" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "llm_calls_idempotency_idx" ON "llm_calls" USING btree ("client","idempotency_key") WHERE "llm_calls"."idempotency_key" is not null;--> statement-breakpoint
CREATE INDEX "llm_jobs_status_created_at_idx" ON "llm_jobs" USING btree ("status","created_at");