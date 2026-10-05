/**
 * One-time encryption of secrets that were stored before decrypt() rejected
 * plaintext. Safe to run more than once: values that already start with v1:
 * are left alone. Nothing secret is printed.
 *
 *   ENSEMBLE_SECRET_KEY=... DATABASE_URL=... pnpm secrets:encrypt
 *
 * Use the same ENSEMBLE_SECRET_KEY the running hub-api and agent-runtime use.
 * This script will not invent a new key.
 */
import { prisma } from "../src/lib/prisma.js";
import { encrypt, secretNeedsEncryption } from "../src/lib/secrets.js";

async function main(): Promise<void> {
  if (!process.env.ENSEMBLE_SECRET_KEY?.trim()) {
    console.error("ENSEMBLE_SECRET_KEY is unset. Set the same key hub-api already uses. This script will not create a new key.");
    process.exit(1);
  }
  if (!process.env.DATABASE_URL?.trim()) {
    console.error("DATABASE_URL is unset.");
    process.exit(1);
  }

  let credentials = 0;
  let accessTokens = 0;
  let refreshTokens = 0;
  let clientSecrets = 0;

  const models = await prisma.modelCredential.findMany({ select: { userId: true, provider: true, secret: true } });
  for (const row of models) {
    if (!secretNeedsEncryption(row.secret)) continue;
    await prisma.modelCredential.update({
      where: { userId_provider: { userId: row.userId, provider: row.provider } },
      data: { secret: encrypt(row.secret) },
    });
    credentials += 1;
  }

  const tokens = await prisma.authToken.findMany({ select: { id: true, accessToken: true, refreshToken: true } });
  for (const row of tokens) {
    const data: { accessToken?: string; refreshToken?: string } = {};
    if (secretNeedsEncryption(row.accessToken)) {
      data.accessToken = encrypt(row.accessToken);
      accessTokens += 1;
    }
    if (secretNeedsEncryption(row.refreshToken)) {
      data.refreshToken = encrypt(row.refreshToken!);
      refreshTokens += 1;
    }
    if (data.accessToken || data.refreshToken) {
      await prisma.authToken.update({ where: { id: row.id }, data });
    }
  }

  const apps = await prisma.connectorApp.findMany({ select: { provider: true, clientSecret: true } });
  for (const row of apps) {
    if (!secretNeedsEncryption(row.clientSecret)) continue;
    await prisma.connectorApp.update({
      where: { provider: row.provider },
      data: { clientSecret: encrypt(row.clientSecret) },
    });
    clientSecrets += 1;
  }

  const total = credentials + accessTokens + refreshTokens + clientSecrets;
  if (total === 0) {
    console.log("No plaintext secrets found.");
  } else {
    console.log(
      `Encrypted ${credentials} model credential(s), ${accessTokens} oauth access token(s), ${refreshTokens} oauth refresh token(s), ${clientSecrets} connector client secret(s).`,
    );
  }
}

main()
  .catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
