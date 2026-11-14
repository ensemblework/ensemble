import { env } from "../config.js";

export const publicApiUrl = (): string =>
  (process.env.HUB_API_PUBLIC_URL ?? `http://localhost:${env.HUB_API_PORT}`).replace(/\/$/, "");
