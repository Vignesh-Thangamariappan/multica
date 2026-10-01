import reactConfig from "@multica/eslint-config/react";
import i18next from "eslint-plugin-i18next";
import {
  NO_UNTRANSLATED_ATTRIBUTES,
  NO_UNTRANSLATED_TOAST,
} from "./eslint-i18n-guard.mjs";

// Global i18n protection. Every JSX text node in this package must pass
// through useT() — raw strings become a build error. Scope of
// `mode: "jsx-text-only"`: flags raw strings inside JSX children only;
// attribute values and plain TS literals are allowed through — the two doors
// `eslint-i18n-guard.mjs` pins shut.

export default [
  ...reactConfig,
  {
    files: ["**/*.tsx"],
    ignores: ["**/*.test.tsx", "test/**"],
    plugins: { i18next },
    rules: {
      "i18next/no-literal-string": [
        "error",
        { mode: "jsx-text-only" },
      ],
    },
  },
  {
    // Toasts are fired from hooks (`.ts`) as often as from components.
    files: ["**/*.{ts,tsx}"],
    ignores: ["**/*.test.{ts,tsx}", "test/**"],
    rules: {
      "no-restricted-syntax": [
        "error",
        NO_UNTRANSLATED_ATTRIBUTES,
        NO_UNTRANSLATED_TOAST,
      ],
    },
  },
  {
    // Fork-owned UI (Meetings, Agent Office) ships English-only copy. These
    // files are not part of upstream, so the i18n guards do not apply until
    // the screens are moved onto useT() + locale bundles.
    files: ["meetings/**/*.tsx", "agents/components/agents-office-*.tsx"],
    ignores: ["**/*.test.tsx"],
    rules: {
      "i18next/no-literal-string": "off",
      "no-restricted-syntax": "off",
    },
  },
];
