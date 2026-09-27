-- Allow finalized teams to reopen recruitment without changing their finalized state.
ALTER TABLE "teams" ADD COLUMN "recruiting" BOOLEAN NOT NULL DEFAULT false;
