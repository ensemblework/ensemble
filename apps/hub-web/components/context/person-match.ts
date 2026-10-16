/** Checks for the Add person form. The API makes the same duplicate check and answers 409 `person_exists`. */

type Known = { id: string; name: string; email: string | null; derived?: boolean };

// One @, something before it, a domain ending in a word of two or more letters, as the API checks.
const EMAIL = /^[^\s@]+@[^\s@.]+(?:\.[^\s@.]+)*\.[a-z]{2,}$/i;

/** What is wrong with an optional email, or null when it is blank or looks like an address. */
export function emailProblem(email: string): string | null {
  const value = email.trim();
  if (!value) return null;
  return EMAIL.test(value) ? null : "Enter an email address like name@example.com, or leave it blank.";
}

/**
 * Someone already in the list who is the person being added: the same email in any case,
 * or, when no email is given, the same name. People only seen as task assignees are not saved yet.
 */
export function findSamePerson<T extends Known>(people: readonly T[], draft: { name: string; email: string }): T | null {
  const email = draft.email.trim().toLowerCase();
  const name = draft.name.trim().replace(/\s+/g, " ").toLowerCase();
  const saved = people.filter((person) => !person.derived);
  if (email) return saved.find((person) => person.email?.trim().toLowerCase() === email) ?? null;
  if (!name) return null;
  return saved.find((person) => person.name.trim().replace(/\s+/g, " ").toLowerCase() === name) ?? null;
}
