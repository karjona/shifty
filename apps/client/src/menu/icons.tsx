// Small line icons for the menus (24×24, currentColor).
const svg = (d: string) =>
  function Icon() {
    return (
      <svg
        viewBox="0 0 24 24"
        width="24"
        height="24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden="true"
      >
        <path d={d} />
      </svg>
    );
  };

export const HomeIcon = svg("M3 11.5 12 4l9 7.5M5.5 9.5V20h13V9.5M10 20v-5.5h4V20");
export const DiamondIcon = svg("M12 3 21 12 12 21 3 12Z");
export const GearIcon = svg(
  "M12 15.5a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7ZM19.4 13.5l1.6 1.2-2 3.4-1.9-.7a7.6 7.6 0 0 1-2 1.2L14.8 21h-4l-.3-2.4a7.6 7.6 0 0 1-2-1.2l-1.9.7-2-3.4 1.6-1.2a7.7 7.7 0 0 1 0-2.4L4.6 9.9l2-3.4 1.9.7a7.6 7.6 0 0 1 2-1.2L10.8 3h4l.3 2.4a7.6 7.6 0 0 1 2 1.2l1.9-.7 2 3.4-1.6 1.2a7.7 7.7 0 0 1 0 2.4Z",
);
export const GlobeIcon = svg(
  "M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18ZM3 12h18M12 3c2.5 2.5 3.5 5.5 3.5 9s-1 6.5-3.5 9c-2.5-2.5-3.5-5.5-3.5-9s1-6.5 3.5-9Z",
);
export const PlusIcon = svg("M12 5v14M5 12h14");
export const PlayIcon = svg("M7 4.5v15l12-7.5Z");
