/** Operator-only erasure for a privately verified request. Reads email from stdin. */
import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";
import { prisma } from "../src/lib/prisma.js";
import { privateIdentifier } from "../src/lib/secrets.js";

const input = createInterface({ input: stdin, output: stdout });
try {
  const email = (await input.question("Email for the verified erasure request: ")).trim().toLowerCase();
  if (!email || !email.includes("@")) throw new Error("Enter a valid account email.");
  await prisma.accountDeletionLog.deleteMany({ where: { emailKey: privateIdentifier("account-deletion-log", email) } });
  stdout.write("Deletion log erased, if present.\n");
} finally {
  input.close();
  await prisma.$disconnect();
}
