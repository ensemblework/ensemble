/**
 * The network between the owner's computer and Ensemble, when a task wants to cut it: a TCP relay on
 * 127.0.0.1 the computer pairs through. `drop` closes every connection at once and refuses new ones for a
 * while, as a lost Wi-Fi does; what the computer was doing goes on, and only its words to Ensemble are lost.
 */
import { connect, createServer, type Server, type Socket } from "node:net";

export type Link = { base: string; drop: (ms: number) => void; drops: () => Array<{ at: string; ms: number }>; close: () => Promise<void> };

export async function startLink(target: { host: string; port: number }): Promise<Link> {
  const open = new Set<Socket>();
  const history: Array<{ at: string; ms: number }> = [];
  let downUntil = 0;
  const server: Server = createServer((client) => {
    if (Date.now() < downUntil) {
      client.destroy();
      return;
    }
    const upstream = connect(target.port, target.host);
    open.add(client);
    open.add(upstream);
    const end = () => {
      client.destroy();
      upstream.destroy();
      open.delete(client);
      open.delete(upstream);
    };
    client.on("error", end).on("close", end);
    upstream.on("error", end).on("close", end);
    client.pipe(upstream);
    upstream.pipe(client);
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const port = (server.address() as { port: number }).port;
  return {
    base: `http://127.0.0.1:${port}`,
    drop(ms) {
      downUntil = Date.now() + ms;
      history.push({ at: new Date().toISOString(), ms });
      for (const socket of open) socket.destroy();
      open.clear();
    },
    drops: () => [...history],
    close: () =>
      new Promise<void>((resolve) => {
        for (const socket of open) socket.destroy();
        server.close(() => resolve());
      }),
  };
}
