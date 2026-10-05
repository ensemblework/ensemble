export interface DiagramTemplate {
  id: string;
  name: string;
  blurb: string;
  source: string;
}

/** Small, valid starters. The person edits the text; nothing here is a real system. */
export const DIAGRAM_TEMPLATES: DiagramTemplate[] = [
  {
    id: "flowchart",
    name: "Flowchart",
    blurb: "A few steps and one question",
    source: `title Flow
direction down

node start "Start" shape circle
node step "Do the work" shape rectangle
node ask "Is it done?" shape diamond
node done "Finish" shape circle

edge start > step
edge step > ask
edge ask > done : "yes"
edge ask > step : "no"
`,
  },
  {
    id: "architecture",
    name: "Architecture",
    blurb: "An app, a service, and a store",
    source: `title Architecture
direction right
curve elbow

node app "App" shape rounded
node api "Service" shape server
node db "Database" shape cylinder

edge app > api
edge api > db
`,
  },
  {
    id: "journey",
    name: "User journey",
    blurb: "What a person does, in order",
    source: `title User journey
direction right

node arrive "Arrives" shape actor
node look "Looks around" shape rounded
node choose "Chooses" shape rectangle
node leave "Leaves" shape actor

edge arrive > look
edge look > choose
edge choose > leave
`,
  },
  {
    id: "decision",
    name: "Decision tree",
    blurb: "One question, two outcomes",
    source: `title Decision
direction down

node ask "Which way?" shape diamond
node left "Path A" shape rectangle
node right "Path B" shape rectangle

edge ask > left : "A"
edge ask > right : "B"
`,
  },
  {
    id: "timeline",
    name: "Timeline",
    blurb: "A process from first to last",
    source: `title Process
direction right

node first "First" shape circle
node middle "Middle" shape rectangle
node last "Last" shape circle

edge first > middle
edge middle > last
`,
  },
  {
    id: "org",
    name: "Org chart",
    blurb: "Who reports to whom",
    source: `title Org chart
direction down

node lead "Lead" shape actor
node one "Teammate" shape actor
node two "Teammate" shape actor

edge lead > one
edge lead > two
`,
  },
  {
    id: "mindmap",
    name: "Mind map",
    blurb: "One topic and its branches",
    source: `title Mind map
direction right

node topic "Topic" shape ellipse
node a "Branch" shape rectangle
node b "Branch" shape rectangle
node c "Branch" shape rectangle

edge topic > a
edge topic > b
edge topic > c
`,
  },
  {
    id: "network",
    name: "Network",
    blurb: "Places that connect",
    source: `title Network
direction right
curve curved

node home "Home" shape server
node office "Office" shape server
node cloud "Outside" shape cloud

edge home > office
edge office > cloud
edge home > cloud
`,
  },
  {
    id: "er",
    name: "Data model",
    blurb: "Records and how they point",
    source: `title Data model
direction right

node account "Account" shape rectangle
node invoice "Invoice" shape rectangle
node line "Line" shape rectangle

edge account > invoice : "has"
edge invoice > line : "has"
`,
  },
  {
    id: "sequence",
    name: "Sequence",
    blurb: "Messages between parties",
    source: `title Sequence
direction right

node person "Person" shape actor
node app "App" shape rectangle
node api "Service" shape server

edge person > app : "asks"
edge app > api : "calls"
edge api > app : "answers"
`,
  },
  {
    id: "plan",
    name: "Project plan",
    blurb: "Stages of a piece of work",
    source: `title Project plan
direction right

node draft "Shape it" shape document
node build "Build it" shape rectangle
node check "Check it" shape diamond
node ship "Ship it" shape circle

edge draft > build
edge build > check
edge check > ship : "ready"
`,
  },
];
