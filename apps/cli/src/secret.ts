import { createInterface } from "node:readline/promises";

export async function readSecret(prompt: string): Promise<string> {
  if (!process.stdin.isTTY) {
    const chunks: Buffer[] = [];
    for await (const chunk of process.stdin) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    return Buffer.concat(chunks).toString("utf8").trim();
  }
  process.stderr.write(prompt);
  const stdin = process.stdin;
  const wasRaw = stdin.isRaw;
  stdin.setRawMode(true);
  stdin.resume();
  let value = "";
  try {
    for (;;) {
      const chunk = await new Promise<Buffer>((resolve) => stdin.once("data", resolve));
      const text = chunk.toString("utf8");
      if (text === "\r" || text === "\n" || text === "\r\n") {
        process.stderr.write("\n");
        return value;
      }
      if (text === "\u0003") throw new Error("Cancelled.");
      if (text === "\u007f" || text === "\b") {
        value = value.slice(0, -1);
        continue;
      }
      value += text;
    }
  } finally {
    stdin.setRawMode(wasRaw);
    stdin.pause();
  }
}

export async function confirm(question: string): Promise<boolean> {
  if (!process.stdin.isTTY) return false;
  const rl = createInterface({ input: process.stdin, output: process.stderr });
  try {
    const answer = (await rl.question(`${question} [y/N] `)).trim().toLowerCase();
    return answer === "y" || answer === "yes";
  } finally {
    rl.close();
  }
}
