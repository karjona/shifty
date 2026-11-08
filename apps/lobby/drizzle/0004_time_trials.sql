CREATE TABLE "time_trial_best" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"course" smallint NOT NULL,
	"season" smallint NOT NULL,
	"time_ms" integer NOT NULL,
	"ghost" "bytea" NOT NULL,
	"set_at" timestamp (3) DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "time_trial_run" (
	"id" serial PRIMARY KEY NOT NULL,
	"room" text NOT NULL,
	"run" integer NOT NULL,
	"user_id" text,
	"course" smallint NOT NULL,
	"season" smallint NOT NULL,
	"time_ms" integer NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "time_trial_best" ADD CONSTRAINT "time_trial_best_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "time_trial_run" ADD CONSTRAINT "time_trial_run_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "time_trial_best_idx" ON "time_trial_best" USING btree ("user_id","course","season");--> statement-breakpoint
CREATE INDEX "time_trial_best_board_idx" ON "time_trial_best" USING btree ("course","season","time_ms","set_at");--> statement-breakpoint
CREATE UNIQUE INDEX "time_trial_run_idx" ON "time_trial_run" USING btree ("room","run");--> statement-breakpoint
CREATE INDEX "time_trial_run_user_idx" ON "time_trial_run" USING btree ("user_id") WHERE "time_trial_run"."user_id" is not null;