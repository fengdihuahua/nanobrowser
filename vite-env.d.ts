/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** Set only for unattended development runs (fixtures/autorun.mjs). */
  readonly WXT_AUTORUN_URL?: string;
  /** Set only for the DSH build: the extension is the Hub client of dsh-plugin/nanobrowser. Off in every other build. */
  readonly WXT_BRIDGE?: string;
  readonly WXT_BRIDGE_PORT?: string;
  readonly WXT_BRIDGE_TOKEN?: string;
  /** The PostHog project key and host; a production build with both sends analytics there. */
  readonly VITE_POSTHOG_API_KEY?: string;
  readonly VITE_POSTHOG_HOST?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
