/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_UPDATER_GH_TOKEN?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
