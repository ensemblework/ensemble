/** Item sources for apps people already connect for sync and imports (Jira, Trello, Asana, Slack, Google, Microsoft…). */
import type { ItemSource } from "../types.js";
import { asanaItems } from "./asana.js";
import { atlassianItems } from "./atlassian.js";
import { clickupItems } from "./clickup.js";
import { googleItems } from "./google.js";
import { microsoftItems } from "./microsoft.js";
import { mondayItems } from "./monday.js";
import { slackItems } from "./slack.js";
import { todoistItems } from "./todoist.js";
import { trelloItems } from "./trello.js";

export const WORK_ITEM_SOURCES: readonly ItemSource[] = [atlassianItems, trelloItems, asanaItems, todoistItems, clickupItems, mondayItems, slackItems, googleItems, microsoftItems];
