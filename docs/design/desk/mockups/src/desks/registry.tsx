import type { ReactNode } from "react";
import type { AccentId, State } from "../kit/ui";
import * as L from "../widgets/legal";
import * as S from "../widgets/student";
import * as E from "../widgets/exam";
import * as R from "../widgets/research";
import * as T from "../widgets/teacher";
import * as M from "../widgets/manager";
import * as D from "../widgets/dev";
import * as K from "../widgets/maker";
import * as G from "../widgets/general";
import { PlotSlot } from "../kit/plots";

export type DeskDef = {
  id: string; name: string; persona: string; accent: AccentId; board?: string; dev?: boolean; needs?: number;
  line: ReactNode; blurb: string; tiles: (s?: State) => ReactNode; mobile?: () => ReactNode;
};

export const DESKS: DeskDef[] = [
  {
    id: "default", name: "Your desk", persona: "Default", accent: "indigo", dev: true, needs: 2,
    blurb: "The owner's general desk: the day, what needs you, and what the agent proposes.",
    line: "Good morning, Prajwal. Priya is waiting on the latency numbers; the ranker ADR has your 10 am block.",
    tiles: (s) => (
      <>
        <G.YourDay state={s} />
        <G.NeedsMe state={s} />
        <G.Brief state={s} />
        <G.Focus state={s} />
        <G.Proposals state={s} />
        <G.Deliverables state={s} c={3} />
        <G.People state={s} c={3} />
        <G.Reminders state={s} c={3} />
        <PlotSlot state={s} title="Focus time" c={3} r={3} />
      </>
    ),
  },
  {
    id: "chambers", name: "Chambers", persona: "Legal", accent: "brass", board: "Matters", needs: 1,
    blurb: "Limitation dates stay on screen, even when the docket is empty.",
    line: "Good morning, Prajwal. Two limitation dates fall inside a week, and Khanna is item 14 in Court 32.",
    tiles: (s) => (
      <>
        <L.LimitationHero state={s} />
        <L.Hearings state={s} />
        <L.Billable state={s} />
        <L.Stages state={s} />
        <L.Filings state={s} />
        <L.Drafts state={s} />
        <L.CauseList state={s} />
        <L.Unbilled state={s} />
        <L.LegalFocus state={s} />
        <L.FollowUps state={s} />
      </>
    ),
    mobile: () => (
      <>
        <L.LimitationMobile />
        <L.CauseList mobile />
        <L.Unbilled mobile />
        <L.Hearings c={4} r={3} mobile />
        <L.Filings c={4} r={4} />
        <L.Billable c={4} r={3} />
      </>
    ),
  },
  {
    id: "semester", name: "Semester", persona: "Student", accent: "orchid", board: "Coursework", needs: 0,
    blurb: "The week, the deadlines, and every course, on one desk.",
    line: "CN assignment 2 is due tonight. You're in OS until 12:15, and attendance in CN is at 72%.",
    tiles: (s) => (
      <>
        <S.WeekStrip state={s} />
        <S.DeadlineRail state={s} />
        <S.CourseRings state={s} />
        <S.Streak state={s} />
        <S.NowNext state={s} />
        <S.StudyPlan state={s} c={3} />
        <S.GroupProject state={s} c={3} />
        <S.Reading state={s} c={3} />
        <PlotSlot state={s} title="Study hours" c={3} r={3} />
      </>
    ),
  },
  {
    id: "exam", name: "Exam season", persona: "Aspirant", accent: "rose", board: "Plan", needs: 0,
    blurb: "One date, the syllabus, the mocks and today's revision. A season, not a second life.",
    line: "235 days to Prelims. Five topics are due for revision, and mock 10 moved you to 106.",
    tiles: (s) => (
      <>
        <E.Countdown state={s} />
        <E.DailyTarget state={s} />
        <E.Affairs state={s} />
        <E.Syllabus state={s} />
        <E.MockTrend state={s} />
        <E.RevisionQueue state={s} />
        <E.HoursHeat state={s} />
        <E.PyqAccuracy state={s} />
      </>
    ),
    mobile: () => (
      <>
        <E.Countdown mobile />
        <E.DailyTarget mobile />
        <E.Affairs mobile />
        <E.RevisionQueue c={4} r={3} mobile />
        <E.MockTrend c={4} r={3} mobile />
        <E.Syllabus c={4} r={3} />
      </>
    ),
  },
  {
    id: "literature", name: "Literature desk", persona: "Researcher", accent: "tide", board: "Papers", needs: 0,
    blurb: "Papers move from To read to Cited, and the chapter grows beside them.",
    line: "Chapter 2 is at 7,840 words. ARR closes in 15 days, and Dr. Iyer meets you Monday.",
    tiles: (s) => (
      <>
        <R.Pipeline state={s} />
        <R.WordCount state={s} c={3} />
        <R.CiteGraph state={s} c={3} />
        <R.ReadStreak state={s} c={3} />
        <PlotSlot state={s} title="Reading trend" c={3} r={3} />
        <R.OpenQs state={s} />
        <R.Advisor state={s} />
        <R.Venue state={s} />
      </>
    ),
  },
  {
    id: "classes", name: "This week's classes", persona: "Teacher", accent: "moss", board: "Lessons", needs: 0,
    blurb: "The period you're in, the one after, and the marking pile by class.",
    line: "Period 5 with 10-B in Lab 2, 20 minutes left. 85 copies to mark, and 12-A's pre-board is due Friday.",
    tiles: (s) => (
      <>
        <T.Timetable state={s} />
        <T.Grading state={s} />
        <T.SyllabusClass state={s} />
        <T.FollowUpsT state={s} />
        <T.Attendance state={s} />
        <T.Ptm state={s} />
        <PlotSlot state={s} title="Marks by class" meta="plot slot · e.g. scores vs test, per section" c={6} r={4} />
        <T.Duty state={s} />
        <T.NextTest state={s} />
      </>
    ),
  },
  {
    id: "staff", name: "Staff week", persona: "Manager", accent: "ember", board: "Team board", needs: 3,
    blurb: "Who is carrying the week, who you haven't met, and what you already decided.",
    line: "Two people are over capacity, and you haven't met Divya in 29 days. Four blockers are open.",
    tiles: (s) => (
      <>
        <M.TeamLoad state={s} />
        <M.Blockers state={s} />
        <M.OneOnOnes state={s} c={4} />
        <M.Objectives state={s} c={4} />
        <PlotSlot state={s} title="Load trend" meta="plot slot · 8 weeks" c={4} r={3} />
        <M.DecisionLog state={s} />
        <M.WhosOut state={s} />
      </>
    ),
  },
  {
    id: "branch", name: "Branch desk", persona: "Developer", accent: "indigo", dev: true, needs: 2,
    blurb: "Pull requests waiting on you, CI at a glance, and what shipped.",
    line: "Three reviews are waiting on you, #479 has a failing check, and v0.42.1 went to prod two hours ago.",
    tiles: (s) => (
      <>
        <D.PrQueue state={s} />
        <D.BranchActivity state={s} />
        <D.CiHealth state={s} />
        <D.Deploys state={s} />
        <D.Issues state={s} />
        <D.Wip state={s} c={3} />
        <D.Blocked state={s} c={3} />
        <D.WeekDone state={s} c={3} />
        <PlotSlot state={s} title="Commit trend" c={3} r={2} />
      </>
    ),
    mobile: () => (
      <>
        <D.PrQueue c={4} r={5} mobile />
        <D.BranchActivity c={4} r={2} mobile />
        <D.Wip c={2} r={2} />
        <D.CiHealth mobile />
        <D.Issues c={4} r={3} mobile />
        <D.Deploys c={4} r={3} mobile />
        <PlotSlot title="Commit trend" c={4} r={2} mobile />
      </>
    ),
  },
  {
    id: "bench", name: "Bench", persona: "Maker", accent: "sky", board: "Build", needs: 0,
    blurb: "The build on a timeline, the parts in hand, and every test by board.",
    line: "Rev C boards are in transit, B2 failed thermal at 6 A, and 7 parts are still out.",
    tiles: (s) => (
      <>
        <K.Gantt state={s} />
        <K.Bom state={s} />
        <K.TestGrid state={s} />
        <K.BuildLog state={s} />
        <K.Budget state={s} />
        <K.LeadTime state={s} />
        <PlotSlot state={s} title="Current draw · series" meta="plot slot · e.g. amps vs time, per board" c={6} r={4} />
        <K.CurrentDraw state={s} />
        <K.NextMilestone state={s} />
      </>
    ),
  },
];
const ORDER = ["default", "semester", "exam", "literature", "chambers", "classes", "staff", "branch", "bench"];
DESKS.sort((a, b) => ORDER.indexOf(a.id) - ORDER.indexOf(b.id));
export const TEMPLATES = DESKS.filter((d) => d.id !== "default");
export const deskById = (id: string) => DESKS.find((d) => d.id === id) ?? DESKS[0];
