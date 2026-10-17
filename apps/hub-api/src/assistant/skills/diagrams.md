---
name: diagrams
title: Diagrams and flowcharts
when: block diagrams, flowcharts, architectures, pipelines, org charts and decision trees, from a page, task, project or repository, or of a well-known system (a transformer, OAuth, TCP)
tools: hub_list_diagrams, hub_get_diagram, hub_validate_diagram, hub_create_diagram, hub_update_diagram, hub_edit_diagram, hub_explain_diagram, hub_diagram_context, hub_repo_overview, hub_repo_read_file, hub_list_repos, hub_read_page, hub_read_task_page, hub_list_pages, hub_manage_record, hub_read_record_details
module: diagrams
include: block-diagrams
match: \b(diagrams?|flow ?charts?|flow diagram|architecture|block diagram|sequence diagram|pipeline|org chart|decision tree|mind ?map|state machine|draw|visuali[sz]e (the|this|how)|how .{0,40} fits together)\b
paths: /diagrams
mentions: diagram
---
Where the blocks come from
- Their own work (a task, page, project, repo): use only what you read. Call hub_diagram_context (taskId, projectId or deliverableId), hub_read_page for a page, hub_repo_overview for a repo. Every block label must come from that text.
- A well-known system they name ("the transformer architecture", "OAuth 2.0 authorization code flow", "a TCP handshake", "how DNS resolves"): draw its standard, textbook design from general knowledge. Use the standard names. Do not add their company's parts unless they gave them.
- Pasted text, a list or a table in the message: use only those words.

A flowchart or diagram from a page or task description
1. Read it: the open page excerpt, hub_read_page (pageId or taskId) or hub_diagram_context.
2. List the steps, decisions (a question with two or more answers), people and stores it names, in order.
3. Steps → `rectangle`, questions → `diamond` with labelled edges ("yes"/"no"), start and end → `circle`, people → `actor`, stores → `cylinder`, screens → `rounded`.
4. `direction down` for flows; `direction right` for systems.
5. hub_validate_diagram, fix every error and warning, then hub_create_diagram with links to the page or task (`{ "kind": "page" | "task", "id": … }`).

Big or complex diagrams
- Use `group` frames for layers or stages; groups can nest. Aim for 7–20 blocks; up to ~30 with groups. Split into two diagrams beyond that.
- Label edges with what flows ("queries", "tokens", "HTTP"). Use dashed edges (`-->`) for optional, async or residual paths.
- Repeated blocks (N layers): draw one and say "× N" in the group label.
- Always validate; save only when ok is true.

Example — the transformer (encoder–decoder), drawn from its standard design:

```udl
title Transformer (encoder–decoder)
direction up
curve elbow

node inputs "Input tokens" shape parallelogram
node in-embed "Input embedding" shape rectangle
node in-pos "Positional encoding" shape circle
group encoder "Encoder × N" {
  node enc-attn "Multi-head self-attention" shape rectangle
  node enc-norm1 "Add & norm" shape rectangle
  node enc-ff "Feed forward" shape rectangle
  node enc-norm2 "Add & norm" shape rectangle
}
node outputs "Output tokens (shifted right)" shape parallelogram
node out-embed "Output embedding" shape rectangle
node out-pos "Positional encoding" shape circle
group decoder "Decoder × N" {
  node dec-masked "Masked multi-head self-attention" shape rectangle
  node dec-norm1 "Add & norm" shape rectangle
  node dec-cross "Multi-head cross-attention" shape rectangle
  node dec-norm2 "Add & norm" shape rectangle
  node dec-ff "Feed forward" shape rectangle
  node dec-norm3 "Add & norm" shape rectangle
}
node linear "Linear" shape rectangle
node softmax "Softmax" shape rectangle
node probs "Output probabilities" shape document

edge inputs > in-embed
edge in-pos > in-embed : "added"
edge in-embed > enc-attn
edge enc-attn > enc-norm1
edge in-embed --> enc-norm1 : "residual"
edge enc-norm1 > enc-ff
edge enc-ff > enc-norm2
edge enc-norm2 > dec-cross : "keys, values"
edge outputs > out-embed
edge out-pos > out-embed : "added"
edge out-embed > dec-masked
edge dec-masked > dec-norm1
edge dec-norm1 > dec-cross : "queries"
edge dec-cross > dec-norm2
edge dec-norm2 > dec-ff
edge dec-ff > dec-norm3
edge dec-norm3 > linear
edge linear > softmax
edge softmax > probs
```

Example — a flowchart from a page that describes an expense policy:

```udl
title Expense approval
direction down

node start "Expense submitted" shape circle
node small "Under $500?" shape diamond
node auto "Auto-approve" shape rectangle
node manager "Manager review" shape actor
node approved "Approved?" shape diamond
node pay "Pay out" shape rounded
node back "Return with a note" shape rectangle color red
node done "Done" shape circle

edge start > small
edge small > auto : "yes"
edge small > manager : "no"
edge manager > approved
edge approved > pay : "yes"
edge approved > back : "no"
edge auto > pay
edge pay > done
edge back --> start : "resubmit"
```

Changing a diagram: hub_get_diagram, then hub_edit_diagram with small ops (keeps ids and layout); hub_update_diagram only to replace the text. Explaining one: hub_explain_diagram.

The full language and drawing rules follow.

Other record maintenance → hub_manage_record (restore one trashed record, page/task conversion, supported plot/diagram/dataset actions, file tags and internal comments). Use the relevant real ID; it preserves the app's existing access and deletion rules.
