CREATE TABLE "invite" (
	"code" text PRIMARY KEY NOT NULL,
	"note" text,
	"max_uses" integer DEFAULT 1 NOT NULL,
	"uses" integer DEFAULT 0 NOT NULL,
	"expires_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "invite_use" (
	"user_id" text PRIMARY KEY NOT NULL,
	"code" text NOT NULL,
	"used_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "invite_use" ADD CONSTRAINT "invite_use_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invite_use" ADD CONSTRAINT "invite_use_code_invite_code_fk" FOREIGN KEY ("code") REFERENCES "public"."invite"("code") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "invite_use_code_idx" ON "invite_use" USING btree ("code");