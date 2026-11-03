CREATE TABLE "notes" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"title" text NOT NULL,
	"body" text DEFAULT '' NOT NULL,
	"created_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "notes_title_length" CHECK (char_length("notes"."title") between 1 and 200),
	CONSTRAINT "notes_body_length" CHECK (char_length("notes"."body") <= 5000)
);
--> statement-breakpoint
CREATE INDEX "notes_created_at_id_idx" ON "notes" USING btree ("created_at" DESC NULLS LAST,"id" DESC NULLS LAST);