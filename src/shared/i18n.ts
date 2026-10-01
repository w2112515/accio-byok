import { EN } from './translations.ts'

export type Language = 'en' | 'zh-CN'

// The desktop entry points initialize this from settings (English by default).
// Keep the original language for standalone library consumers.
let language: Language = 'zh-CN'

export function setLanguage(next: Language): void {
  language = next
}

export function getLanguage(): Language {
  return language
}

/** Colocated bilingual copy for new connection and maintenance panels. */
export function tx(english: string, chinese: string): string {
  return language === 'en' ? english : chinese
}

/** Translate app-owned copy, interpolating values without inspecting user content. */
export function tr(source: keyof typeof EN, ...values: unknown[]): string {
  const message = language === 'en' ? EN[source] ?? source : source
  return message.replace(/\{(\d+)\}/g, (token, index: string) =>
    Number(index) < values.length ? String(values[Number(index)] ?? '') : token,
  )
}
