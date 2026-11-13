export function morningInstructions(profession: string | null): string {
  const role = (profession ?? "").replace(/[\r\n]/g, " ").slice(0, 120);
  const focus = /teacher|educat/i.test(role)
    ? "classes, lesson preparation, grading and students"
    : /lawyer|legal/i.test(role)
      ? "matters, filing deadlines, client follow-ups and hearings"
      : /student/i.test(role)
        ? "coursework, exams, study time and upcoming classes"
        : /research|scient/i.test(role)
          ? "experiments, reading, collaborators and research deadlines"
          : /engineer|developer/i.test(role)
            ? "deliverables, reviews, blocked tasks and project deadlines"
            : "priorities, meetings, deadlines and follow-ups";
  return `# Morning brief\n\nPrepare a short morning brief${role ? ` for someone working as ${role}` : ""}. Focus on ${focus}.\n\nStart with the most useful next action. Include today's focus, items waiting on the person, meetings and upcoming deliverables. Use short sections and plain language. Use only the supplied context. Do not invent tasks or facts. Do not send anything to other people.\n`;
}
