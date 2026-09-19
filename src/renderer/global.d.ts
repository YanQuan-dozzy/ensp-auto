import type { RendererApi } from '@shared/api'

declare global {
  interface Window {
    api: RendererApi
  }
}

export {}
