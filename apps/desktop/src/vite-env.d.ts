/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** The commit this build is from, set by the self-hosted bundle's image build (web.Dockerfile). */
  readonly VITE_TRIODITIS_VERSION?: string
}
