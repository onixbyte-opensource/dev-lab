/// <reference types="vite/client" />
interface ImportMetaEnv {
  readonly VITE_SEO_SITE_URL: string
  readonly VITE_REDUX_STORAGE: string
}

interface ImportMeta {
  readonly env: ImportMetaEnv
}
