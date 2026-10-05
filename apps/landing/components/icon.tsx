const PATHS = {
  sunrise: (
    <>
      <path d="M4 17h16M7 17a5 5 0 0 1 10 0" />
      <path d="M12 6v3M5.6 9.6l1.8 1.8M18.4 9.6l-1.8 1.8" />
    </>
  ),
  board: (
    <>
      <rect x="3.5" y="4.5" width="17" height="15" rx="2.5" />
      <path d="M9.5 4.5v15M14.5 4.5v15" />
    </>
  ),
  shield: (
    <>
      <path d="M12 3.5 5 6v5.5c0 4.2 3 7.4 7 9 4-1.6 7-4.8 7-9V6l-7-2.5Z" />
      <path d="m9 12 2.2 2.2L15.5 10" />
    </>
  ),
  graph: (
    <>
      <circle cx="6" cy="7" r="2.2" />
      <circle cx="18" cy="6" r="2.2" />
      <circle cx="12" cy="17.5" r="2.2" />
      <path d="M8 8.2 10.8 15.6M16.3 7.6l-3.2 8M8.2 6.8l7.6-.6" />
    </>
  ),
  quill: (
    <>
      <path d="M19.5 4.5c-6 0-11 4.5-12.5 12.5l2 .5c2.5-1 4.5-2 6-3.5l-2-1 3.5-1.5C18 9.5 19.5 7 19.5 4.5Z" />
      <path d="M4.5 19.5 7 17" />
    </>
  ),
  chain: (
    <>
      <path d="M10 14a3.5 3.5 0 0 0 5 0l3-3a3.5 3.5 0 0 0-5-5l-1 1" />
      <path d="M14 10a3.5 3.5 0 0 0-5 0l-3 3a3.5 3.5 0 0 0 5 5l1-1" />
    </>
  ),
  plug: (
    <>
      <path d="M9 3.5v4M15 3.5v4M7 7.5h10v3a5 5 0 0 1-10 0v-3Z" />
      <path d="M12 15.5v5" />
    </>
  ),
  chip: (
    <>
      <rect x="6.5" y="6.5" width="11" height="11" rx="2" />
      <path d="M10 3.5v3M14 3.5v3M10 17.5v3M14 17.5v3M3.5 10h3M3.5 14h3M17.5 10h3M17.5 14h3" />
    </>
  ),
  laptop: (
    <>
      <rect x="4.5" y="5.5" width="15" height="10" rx="1.5" />
      <path d="M2.5 18.5h19" />
    </>
  ),
  hand: (
    <>
      <path d="M8 12V6.5a1.5 1.5 0 0 1 3 0V11M11 10V5a1.5 1.5 0 0 1 3 0v5M14 10V6.5a1.5 1.5 0 0 1 3 0V14a6 6 0 0 1-6 6h-.5a6 6 0 0 1-4.8-2.4L4 15.2a1.5 1.5 0 0 1 2.3-1.9L8 15" />
    </>
  ),
} satisfies Record<string, React.ReactNode>;

export type IconName = keyof typeof PATHS;

export function Icon({ name }: { name: IconName }) {
  return (
    <svg className="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      {PATHS[name]}
    </svg>
  );
}
