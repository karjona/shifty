// Which look the client draws: the cel look (this branch's default) or the
// classic one (`?look=classic`), to compare.
const params = new URLSearchParams(location.search);

export const CEL = params.get("look") !== "classic";

/** The cel look's flavour: "anime" (fighting-game cel), or "comic" (`?style=comic`: halftone shade, heavy ink). */
export const STYLE: "anime" | "comic" = params.get("style") === "comic" ? "comic" : "anime";
