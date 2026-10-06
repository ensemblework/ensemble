-- The address that started a CLI login, shown on the approval page so people
-- can spot a request they did not make. Cleared once the request is decided,
-- exchanged or expired.

ALTER TABLE "cli_auth_requests" ADD COLUMN IF NOT EXISTS "request_ip" TEXT;
