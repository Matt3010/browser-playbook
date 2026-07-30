-- A workflow may keep one browser profile across its runs, so a login or a bot
-- check passed once while recording is still there when it runs by itself.
-- Off by default: a workflow whose steps are the login must find its login form.
ALTER TABLE "workflows" ADD COLUMN "rememberBrowser" BOOLEAN NOT NULL DEFAULT false;
