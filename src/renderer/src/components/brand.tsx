import { findPreset } from '../../../shared/presets.ts'
import type { ProviderKind } from '../../../shared/types.ts'
import { cn } from '../lib/format.ts'
import { Badge } from './ui.tsx'

export function AppLogo({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 512 512" className={cn('size-7', className)} aria-hidden>
      <defs>
        <linearGradient id="lg-bg" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="#7C6CFF" />
          <stop offset="0.55" stopColor="#9B5CF6" />
          <stop offset="1" stopColor="#FF7A59" />
        </linearGradient>
      </defs>
      <rect x="16" y="16" width="480" height="480" rx="116" fill="url(#lg-bg)" />
      <rect x="96" y="176" width="320" height="160" rx="80" fill="#fff" fillOpacity="0.22" stroke="#fff" strokeOpacity="0.55" strokeWidth="12" />
      <circle cx="178" cy="256" r="26" fill="#fff" fillOpacity="0.55" />
      <circle cx="336" cy="256" r="64" fill="#fff" />
      <path d="M344 222 L318 262 H340 L328 292 L356 250 H334 Z" fill="#8B5CF6" />
    </svg>
  )
}

export function OfficialAvatar({ size = 40 }: { size?: number }) {
  return (
    <div
      className="flex shrink-0 items-center justify-center rounded-xl font-semibold text-white shadow-sm"
      style={{ width: size, height: size, fontSize: size * 0.42, background: 'linear-gradient(135deg,#FF9A3C,#FF5F3C)' }}
      aria-hidden
    >
      A
    </div>
  )
}

export function ProviderAvatar({ presetId, name, size = 40 }: { presetId?: string; name: string; size?: number }) {
  const preset = findPreset(presetId)
  const color = preset?.color ?? '#64748B'
  const mono = preset?.monogram && preset.category !== 'custom' ? preset.monogram : (name.trim()[0] ?? '?').toUpperCase()
  return (
    <div
      className="flex shrink-0 items-center justify-center rounded-xl font-semibold text-white shadow-sm ring-1 ring-black/5 dark:ring-white/12"
      style={{
        width: size,
        height: size,
        fontSize: mono.length > 1 ? size * 0.32 : size * 0.42,
        background: `linear-gradient(135deg, color-mix(in oklch, ${color} 82%, white), ${color})`,
      }}
      aria-hidden
    >
      {mono}
    </div>
  )
}

export const KIND_LABEL: Record<ProviderKind, string> = {
  openai: 'OpenAI 兼容',
  anthropic: 'Anthropic',
  gemini: 'Gemini',
}

export function KindBadge({ kind }: { kind: ProviderKind }) {
  return <Badge tone="outline">{KIND_LABEL[kind]}</Badge>
}
