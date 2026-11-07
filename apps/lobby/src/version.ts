// The release this lobby is: race servers and clients must match it.
import pkg from "../package.json" with { type: "json" };

export const VERSION: string = pkg.version;
