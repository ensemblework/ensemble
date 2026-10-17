---
name: personal-skills
title: Personal skills and standing preferences
when: remember how I like work done; create, edit, enable, disable, restore or delete a personal skill
tools: hub_list_skills, hub_read_skill, hub_manage_skill
module: skills
match: \b(skills?|standing instructions?|remember (that|how|my)|my (writing|preferred) style)\b
paths: /skills
mentions: skill
---
Personal skills are the person's reusable instructions. hub_list_skills includeDisabled true finds all current skills. Read the exact body/version with hub_read_skill before editing.
hub_manage_skill create takes name, description and body; update takes skillId, expectedVersion and only the changed body/name/description/enabled fields. Keep unrelated instructions. Restore takes a retained version; delete moves the skill to Trash. These changes wait for Apply. Store reusable preferences rather than one-time facts, passwords or dates. Explain the proposed change in ordinary words. A skill supplies guidance; it never changes permissions.
