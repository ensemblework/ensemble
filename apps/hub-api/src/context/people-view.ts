const CLOSED = new Set(["done", "dropped"]);

export type PeopleInput = {
  people: Array<{
    id: string;
    name: string;
    email: string | null;
    role: string | null;
    team: string | null;
    lastInteraction: string | null;
    confidence: number;
    projects: Array<{ id: string; name: string }>;
  }>;
  tasks: Array<{ title: string; status: string; people: string[]; updatedAt: string }>;
  notes: Array<{ title: string; personIds: string[]; askedAt: string }>;
  sessions: Array<{ title: string; personIds: string[]; startedAt: string }>;
};

export type PeopleCard = PeopleInput["people"][number] & {
  openTasks: number;
  recentTitle: string | null;
  recentAt: string | null;
  derived: boolean;
};

type Hit = { title: string; at: string; open: boolean };

function isBlankClient(person: { name: string; role: string | null; email: string | null }): boolean {
  return person.name.trim().toLowerCase() === "client" && !person.role?.trim() && !person.email?.trim();
}

function push(bucket: Map<string, Hit[]>, key: string, hit: Hit) {
  const list = bucket.get(key) ?? [];
  list.push(hit);
  bucket.set(key, list);
}

function summarize(hits: Hit[] | undefined): { openTasks: number; recentTitle: string | null; recentAt: string | null } {
  if (!hits?.length) return { openTasks: 0, recentTitle: null, recentAt: null };
  const recent = hits.reduce((best, hit) => (hit.at > best.at ? hit : best));
  return {
    openTasks: hits.filter((hit) => hit.open).length,
    recentTitle: recent.title,
    recentAt: recent.at,
  };
}

/**
 * People come from the directory, from task assignees, and from meeting attendees.
 * A role-less "Client" left by an old starter is not a person.
 */
export function peopleCards(input: PeopleInput): PeopleCard[] {
  const byId = new Map(input.people.map((person) => [person.id, person]));
  const byName = new Map(input.people.map((person) => [person.name.trim().toLowerCase(), person]));
  const hits = new Map<string, Hit[]>();
  const derived = new Map<string, string>();

  for (const task of input.tasks) {
    const open = !CLOSED.has(task.status);
    for (const ref of task.people) {
      const token = ref.trim();
      if (!token) continue;
      const known = byId.get(token) ?? byName.get(token.toLowerCase());
      if (known) {
        push(hits, known.id, { title: task.title, at: task.updatedAt, open });
        continue;
      }
      if (token.includes("-") && token.length > 20) continue;
      const key = `name:${token.toLowerCase()}`;
      derived.set(key, token);
      push(hits, key, { title: task.title, at: task.updatedAt, open });
    }
  }

  for (const note of input.notes) {
    for (const id of note.personIds) {
      if (!byId.has(id)) continue;
      push(hits, id, { title: note.title, at: note.askedAt, open: false });
    }
  }
  for (const session of input.sessions) {
    for (const id of session.personIds) {
      if (!byId.has(id)) continue;
      push(hits, id, { title: session.title, at: session.startedAt, open: false });
    }
  }

  const cards: PeopleCard[] = [];
  for (const person of input.people) {
    if (isBlankClient(person)) continue;
    cards.push({ ...person, ...summarize(hits.get(person.id)), derived: false });
  }
  for (const [key, name] of derived) {
    if (isBlankClient({ name, role: null, email: null })) continue;
    cards.push({
      id: key,
      name,
      email: null,
      role: "Assignee",
      team: null,
      lastInteraction: null,
      confidence: 0.5,
      projects: [],
      ...summarize(hits.get(key)),
      derived: true,
    });
  }
  return cards.sort((a, b) => b.openTasks - a.openTasks || a.name.localeCompare(b.name));
}
