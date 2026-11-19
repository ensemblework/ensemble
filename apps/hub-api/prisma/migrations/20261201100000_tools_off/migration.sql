-- Connected-app tools switched off for one assistant conversation, one editor key and one OAuth app.
ALTER TABLE "assistant_conversations" ADD COLUMN "tools_off" TEXT[] DEFAULT ARRAY[]::TEXT[];
ALTER TABLE "api_tokens" ADD COLUMN "tools_off" TEXT[] DEFAULT ARRAY[]::TEXT[];
ALTER TABLE "mcp_oauth_grants" ADD COLUMN "tools_off" TEXT[] DEFAULT ARRAY[]::TEXT[];
