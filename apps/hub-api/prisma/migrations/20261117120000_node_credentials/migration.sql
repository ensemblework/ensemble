-- Credential isolation and encrypted entry (ensemble-node B12).

-- The public key a paired computer reported first ({kid, alg, spki, fingerprint, pinnedAt}): the web
-- encrypts secrets for it. Kept until the computer is paired again, whatever later heartbeats say.
ALTER TABLE "devices" ADD COLUMN     "seal_key" JSONB;

-- On a computer: where a saved secret may be sent by reference (secret_http, git), as origins. Null or
-- empty: nowhere, and the secret goes only into the environment of runs that may have it.
ALTER TABLE "run_secrets" ADD COLUMN     "allow" JSONB;
