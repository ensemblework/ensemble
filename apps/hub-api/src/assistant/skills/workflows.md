---
name: workflows
title: Dependent actions
when: several actions where one creates a record another must use; complete a linked request under one Apply
tools: hub_run_workflow, hub_list_people, hub_list_projects, hub_list_tasks, hub_create_person, hub_create_project, hub_create_tasks, hub_create_page
match: \b(then (attach|link|create|add|invite)|and (attach|link) (it|them)|workflow|dependent|everything together)\b
---
Read existing targets and sources first. Propose the writes with hub_run_workflow title and ordered steps. Each step has id, tool and input. References are objects, for example {"$ref":"person.person.id"}, never guessed IDs or literal placeholder strings.
Example: step person uses hub_create_person; step tasks uses hub_create_tasks with people [{"$ref":"person.person.id"}]. A project result is project.project.id; a page is page.id; created tasks are tasks.tasks.0.id. Use references only to earlier steps. Exact result fields come from the named tool. No read tools or nested workflows. One Apply approves the displayed plan; completed steps are checkpointed. A failed step stops the rest. Retry the same Apply to continue without repeating completed work. A running step interrupted before its receipt needs checking, not replay.
