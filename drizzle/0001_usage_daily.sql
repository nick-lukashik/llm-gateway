CREATE TABLE "llm_usage_daily" (
	"day" date NOT NULL,
	"client" text NOT NULL,
	"purpose" text,
	"provider" text NOT NULL,
	"model" text NOT NULL,
	"calls" integer NOT NULL,
	"errors" integer NOT NULL,
	"tokens_in" bigint NOT NULL,
	"tokens_out" bigint NOT NULL,
	"duration_ms" bigint NOT NULL,
	"updated_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "llm_usage_daily_key" UNIQUE NULLS NOT DISTINCT("day","client","purpose","provider","model")
);
