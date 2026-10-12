/**
 * Every app Ensemble can search, in the order "Add from apps" lists them.
 * A new app: write sources/<app>.ts implementing ItemSource and list it in one of the groups below.
 */
import { githubItems } from "./sources/github.js";
import { linearItems } from "./sources/linear.js";
import { notionItems } from "./sources/notion.js";
import { MORE_ITEM_SOURCES } from "./sources/more.js";
import { WORK_ITEM_SOURCES } from "./sources/work.js";
import type { ItemSource } from "./types.js";

export const ITEM_SOURCES: readonly ItemSource[] = [notionItems, githubItems, linearItems, ...WORK_ITEM_SOURCES, ...MORE_ITEM_SOURCES];
