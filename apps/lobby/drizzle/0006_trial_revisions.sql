ALTER TABLE "time_trial_best" ADD COLUMN "revision" smallint DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "time_trial_run" ADD COLUMN "revision" smallint DEFAULT 0 NOT NULL;