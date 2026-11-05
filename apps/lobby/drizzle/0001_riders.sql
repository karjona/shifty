CREATE TABLE "inventory" (
	"user_id" text NOT NULL,
	"item" text NOT NULL,
	"source" text NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "inventory_user_id_item_pk" PRIMARY KEY("user_id","item")
);
--> statement-breakpoint
CREATE TABLE "ledger" (
	"id" serial PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"delta" integer NOT NULL,
	"reason" text NOT NULL,
	"ref" text NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "match_player" ADD COLUMN "look" text;--> statement-breakpoint
ALTER TABLE "match_player" ADD COLUMN "setups" jsonb;--> statement-breakpoint
ALTER TABLE "player" ADD COLUMN "appearance" jsonb;--> statement-breakpoint
ALTER TABLE "player" ADD COLUMN "setups" jsonb;--> statement-breakpoint
ALTER TABLE "player" ADD COLUMN "credits" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "inventory" ADD CONSTRAINT "inventory_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ledger" ADD CONSTRAINT "ledger_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "ledger_once_idx" ON "ledger" USING btree ("user_id","reason","ref");--> statement-breakpoint
CREATE INDEX "ledger_user_idx" ON "ledger" USING btree ("user_id","created_at");