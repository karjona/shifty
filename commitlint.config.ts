import { RuleConfigSeverity, type UserConfig } from "@commitlint/types";

export default {
  extends: ["@commitlint/config-conventional"],
  rules: {
    "scope-enum": [
      RuleConfigSeverity.Error,
      "always",
      ["sim", "protocol", "netcode", "server", "client", "lobby", "devkit", "art", "audio", "ci", "deps"],
    ],
  },
} satisfies UserConfig;
