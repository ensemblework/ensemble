import { PrismaClient } from "@prisma/client";
import { desktopAdapter } from "./desktop-db.js";

const adapter = desktopAdapter();
export const prisma = adapter ? new PrismaClient({ adapter }) : new PrismaClient();
