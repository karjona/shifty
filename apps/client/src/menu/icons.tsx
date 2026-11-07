// Line icons for the menus: one 24×24 grid, one stroke, square ends and
// mitred joins (they sit with the hard-edged panels), in currentColor.
const svg = (d: string, fill = false) =>
  function Icon() {
    return (
      <svg
        className="icon"
        viewBox="0 0 24 24"
        width="24"
        height="24"
        fill={fill ? "currentColor" : "none"}
        stroke={fill ? "none" : "currentColor"}
        strokeWidth="2"
        strokeLinecap="square"
        strokeLinejoin="miter"
        aria-hidden="true"
      >
        <path d={d} />
      </svg>
    );
  };

export const HomeIcon = svg("M4 10.5 12 4l8 6.5V20h-5.5v-5.5h-5V20H4Z");
/** The collection: a shirt on its hanger. */
export const CollectionIcon = svg(
  "M9 4.5 4 7l1.8 4.2L8 10.5V20h8v-9.5l2.2.7L20 7l-5-2.5c-.5 1.4-1.6 2.2-3 2.2s-2.5-.8-3-2.2Z",
);
export const GearIcon = svg(
  "M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6ZM10.5 3h3l.5 2.6 1.6.9 2.5-.9 1.5 2.6-2 1.7v1.8l2 1.7-1.5 2.6-2.5-.9-1.6.9-.5 2.6h-3l-.5-2.6-1.6-.9-2.5.9-1.5-2.6 2-1.7v-1.8l-2-1.7 1.5-2.6 2.5.9 1.6-.9Z",
);
export const GlobeIcon = svg(
  "M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18ZM3.5 12h17M12 3.2c2.3 2.4 3.4 5.4 3.4 8.8s-1.1 6.4-3.4 8.8c-2.3-2.4-3.4-5.4-3.4-8.8s1.1-6.4 3.4-8.8Z",
);
export const PlusIcon = svg("M12 5v14M5 12h14");
export const MenuIcon = svg("M5 7h14M5 12h14M5 17h14");
export const PlayIcon = svg("M7 4.5v15L19 12Z", true);
export const ChevronLeft = svg("M14.5 6 8.5 12l6 6");
export const ChevronRight = svg("M9.5 6l6 6-6 6");
export const LockIcon = svg("M6 11h12v9H6ZM8.5 11V8a3.5 3.5 0 0 1 7 0v3");
export const CheckIcon = svg("M5 12.5 10 17.5 19 7");
export const ShopIcon = svg("M4 9h16l-1.2 11H5.2ZM8.5 9V7a3.5 3.5 0 0 1 7 0v2");
export const RiderIcon = svg("M12 11a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7ZM5 20c.6-3.8 3.4-6 7-6s6.4 2.2 7 6");
export const UsersIcon = svg(
  "M9 11a3 3 0 1 0 0-6 3 3 0 0 0 0 6ZM3 19c.5-3.2 2.8-5 6-5s5.5 1.8 6 5M16 5.3a3 3 0 0 1 0 5.4M18 14.4c1.6.7 2.7 2.3 3 4.6",
);
export const FlagIcon = svg("M5 21V4M5 4h12l-2.5 4L17 12H5");
export const ClockIcon = svg("M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18ZM12 7.5V12l3 2");
export const BotIcon = svg("M5 9h14v10H5ZM12 9V5M9.5 13.5v1M14.5 13.5v1M2.5 13v2M21.5 13v2");
export const SearchIcon = svg("M10.5 17a6.5 6.5 0 1 0 0-13 6.5 6.5 0 0 0 0 13ZM15.5 15.5 20 20");
export const SlidersIcon = svg("M4 7h9M17 7h3M4 17h3M11 17h9M15 4.5v5M9 14.5v5");
