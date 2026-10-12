/** Item sources for apps added with the connectors that used to be listed as coming soon (Figma, Zendesk, Vercel…). */
import type { ItemSource } from "../types.js";
import { azureDevopsItems } from "./azure-devops.js";
import { boxItems } from "./box.js";
import { discordItems } from "./discord.js";
import { dropboxItems } from "./dropbox.js";
import { figmaItems } from "./figma.js";
import { frontItems } from "./front.js";
import { hubspotItems } from "./hubspot.js";
import { vercelItems } from "./vercel.js";
import { xeroItems } from "./xero.js";
import { zendeskItems } from "./zendesk.js";

export const MORE_ITEM_SOURCES: readonly ItemSource[] = [
  figmaItems,
  vercelItems,
  azureDevopsItems,
  zendeskItems,
  frontItems,
  hubspotItems,
  dropboxItems,
  boxItems,
  xeroItems,
  discordItems,
];
