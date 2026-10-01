import { useEffect, useRef, useState, type ReactNode } from 'react'
import { cn } from '../lib/format.ts'

function useWidth<T extends HTMLElement>(): [React.RefObject<T | null>, number] {
  const ref = useRef<T>(null)
  const [w, setW] = useState(0)
  useEffect(() => {
    if (!ref.current) return
    const ro = new ResizeObserver(([e]) => setW(Math.floor(e.contentRect.width)))
    ro.observe(ref.current)
    return () => ro.disconnect()
  }, [])
  return [ref, w]
}

function niceMax(v: number): number {
  if (v <= 0) return 1
  const exp = Math.pow(10, Math.floor(Math.log10(v)))
  const f = v / exp
  const nice = f <= 1 ? 1 : f <= 2 ? 2 : f <= 2.5 ? 2.5 : f <= 5 ? 5 : 10
  return nice * exp
}

/** Rect with only the top corners rounded (data end), anchored to the baseline. */
function topRoundedRect(x: number, y: number, w: number, h: number, r: number): string {
  if (h <= 0) return ''
  const rr = Math.min(r, w / 2, h)
  return `M${x},${y + h} V${y + rr} Q${x},${y} ${x + rr},${y} H${x + w - rr} Q${x + w},${y} ${x + w},${y + rr} V${y + h} Z`
}

export interface StackSeries {
  key: string
  label: string
  color: string
}

export function StackedBars({
  data,
  series,
  height = 220,
  format,
  xLabel,
  tooltipTitle,
}: {
  data: Record<string, number | string>[]
  series: StackSeries[]
  height?: number
  format: (n: number) => string
  xLabel: (d: Record<string, number | string>, i: number) => string
  tooltipTitle: (d: Record<string, number | string>) => ReactNode
}) {
  const [ref, width] = useWidth<HTMLDivElement>()
  const [hover, setHover] = useState<number | null>(null)
  const padL = 44
  const padB = 24
  const padT = 8
  const innerW = Math.max(0, width - padL - 4)
  const innerH = height - padB - padT
  const totals = data.map((d) => series.reduce((s, x) => s + (Number(d[x.key]) || 0), 0))
  const max = niceMax(Math.max(...totals, 0))
  const n = data.length || 1
  const slot = innerW / n
  const barW = Math.max(4, Math.min(28, slot * 0.56))
  const ticks = [0, 0.25, 0.5, 0.75, 1].map((t) => t * max)
  const labelEvery = Math.ceil(n / Math.max(1, Math.floor(innerW / 56)))

  return (
    <div className="w-full">
      <div className="mb-3 flex items-center gap-4 text-[12px] text-muted">
        {series.map((s) => (
          <span key={s.key} className="inline-flex items-center gap-1.5">
            <span className="size-2.5 rounded-[3px]" style={{ background: s.color }} />
            {s.label}
          </span>
        ))}
      </div>
      <div ref={ref} className="relative w-full" style={{ height }} onMouseLeave={() => setHover(null)}>
        {width > 0 ? (
          <svg width={width} height={height} role="img" aria-label="每日用量柱状图" className="block overflow-visible">
            {ticks.map((t, i) => {
              const y = padT + innerH - (t / max) * innerH
              return (
                <g key={i}>
                  <line x1={padL} x2={width} y1={y} y2={y} stroke="var(--grid)" strokeWidth={1} />
                  <text x={padL - 8} y={y + 4} textAnchor="end" className="fill-subtle text-[11px] tabular">
                    {format(t)}
                  </text>
                </g>
              )
            })}
            {data.map((d, i) => {
              const cx = padL + slot * i + slot / 2
              let acc = 0
              const segs = series.map((s) => {
                const v = Number(d[s.key]) || 0
                const h = (v / max) * innerH
                const y = padT + innerH - acc - h
                acc += h
                return { s, v, h, y }
              })
              const topIdx = segs.map((x) => x.h > 0).lastIndexOf(true)
              return (
                <g key={i} opacity={hover === null || hover === i ? 1 : 0.45} style={{ transition: 'opacity .15s' }}>
                  {segs.map(({ s, h, y }, si) =>
                    h > 0 ? (
                      si === topIdx ? (
                        <path key={s.key} d={topRoundedRect(cx - barW / 2, y, barW, Math.max(0, h - (si > 0 ? 2 : 0)), 4)} fill={s.color} />
                      ) : (
                        <rect key={s.key} x={cx - barW / 2} y={y + (si > 0 ? 2 : 0)} width={barW} height={Math.max(0, h - (si > 0 ? 2 : 0))} fill={s.color} />
                      )
                    ) : null,
                  )}
                  {i % labelEvery === 0 ? (
                    <text x={cx} y={height - 6} textAnchor="middle" className="fill-subtle text-[11px] tabular">
                      {xLabel(d, i)}
                    </text>
                  ) : null}
                  <rect x={padL + slot * i} y={padT} width={slot} height={innerH} fill="transparent" onMouseEnter={() => setHover(i)} />
                </g>
              )
            })}
            <line x1={padL} x2={width} y1={padT + innerH} y2={padT + innerH} stroke="var(--border-strong)" strokeWidth={1} />
          </svg>
        ) : null}
        {hover !== null && data[hover] ? (
          <div
            className="pointer-events-none absolute z-10 min-w-40 rounded-xl border border-border bg-surface-2 px-3 py-2 text-[12px] shadow-pop backdrop-blur-xl"
            style={{
              left: Math.min(Math.max(padL + slot * hover + slot / 2 - 80, 0), Math.max(0, width - 170)),
              top: 0,
            }}
          >
            <div className="mb-1 font-medium">{tooltipTitle(data[hover])}</div>
            {series.map((s) => (
              <div key={s.key} className="flex items-center justify-between gap-4 text-muted">
                <span className="inline-flex items-center gap-1.5">
                  <span className="size-2 rounded-[2px]" style={{ background: s.color }} />
                  {s.label}
                </span>
                <span className="font-medium text-fg tabular">{format(Number(data[hover][s.key]) || 0)}</span>
              </div>
            ))}
          </div>
        ) : null}
      </div>
    </div>
  )
}

/** Compact single-series bars for trend-at-a-glance. */
export function MiniBars({ values, labels, format, height = 56, className }: { values: number[]; labels: string[]; format: (n: number) => string; height?: number; className?: string }) {
  const [ref, width] = useWidth<HTMLDivElement>()
  const [hover, setHover] = useState<number | null>(null)
  const max = Math.max(...values, 1)
  const n = values.length || 1
  const gap = 4
  const barW = Math.max(3, (width - gap * (n - 1)) / n)
  return (
    <div ref={ref} className={cn('relative w-full', className)} style={{ height }} onMouseLeave={() => setHover(null)}>
      {width > 0 ? (
        <svg width={width} height={height} role="img" aria-label="近 7 天请求数" className="block">
          {values.map((v, i) => {
            const h = Math.max(v > 0 ? 3 : 1.5, (v / max) * (height - 4))
            const x = i * (barW + gap)
            return (
              <g key={i} onMouseEnter={() => setHover(i)}>
                <rect x={x} y={0} width={barW} height={height} fill="transparent" />
                <path d={topRoundedRect(x, height - h, barW, h, 3)} fill={v > 0 ? 'var(--series-1)' : 'var(--grid)'} opacity={hover === null || hover === i ? 1 : 0.5} />
              </g>
            )
          })}
        </svg>
      ) : null}
      {hover !== null ? (
        <div
          className="pointer-events-none absolute -top-9 z-10 rounded-lg border border-border bg-surface-2 px-2 py-1 text-[11.5px] whitespace-nowrap shadow-pop"
          style={{ left: Math.min(Math.max(hover * (barW + gap) + barW / 2 - 50, 0), Math.max(0, width - 110)) }}
        >
          <span className="text-muted">{labels[hover]}</span> <span className="font-medium tabular">{format(values[hover])}</span>
        </div>
      ) : null}
    </div>
  )
}

/** Horizontal share list: label, value and a proportional bar. */
export function ShareList({ items, format, empty }: { items: { key: string; label: ReactNode; value: number; sub?: ReactNode }[]; format: (n: number) => string; empty?: ReactNode }) {
  const total = items.reduce((s, i) => s + i.value, 0)
  const max = Math.max(...items.map((i) => i.value), 1)
  if (!items.length) return <div className="py-6 text-center text-[13px] text-subtle">{empty ?? '暂无数据'}</div>
  return (
    <ul className="space-y-3">
      {items.map((i) => (
        <li key={i.key}>
          <div className="mb-1 flex items-baseline justify-between gap-3 text-[13px]">
            <span className="min-w-0 truncate">{i.label}</span>
            <span className="shrink-0 tabular text-muted">
              <span className="font-medium text-fg">{format(i.value)}</span>
              {total > 0 ? <span className="ml-1.5 text-[12px]">{Math.round((i.value / total) * 100)}%</span> : null}
            </span>
          </div>
          <div className="h-1.5 w-full overflow-hidden rounded-full bg-fg/[0.06]">
            <div className="h-full rounded-full bg-series-1 transition-[width] duration-500" style={{ width: `${(i.value / max) * 100}%` }} />
          </div>
          {i.sub ? <div className="mt-1 text-[11.5px] text-subtle">{i.sub}</div> : null}
        </li>
      ))}
    </ul>
  )
}
