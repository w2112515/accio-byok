import { cva, type VariantProps } from 'class-variance-authority'
import { Check, ChevronDown, Eye, EyeOff, Loader2, X } from 'lucide-react'
import { AlertDialog, Dialog, DropdownMenu, Popover, Select, Slot, Switch as RSwitch, Tabs, Tooltip } from 'radix-ui'
import { forwardRef, useId, useState, type ComponentProps, type ReactNode } from 'react'
import { cn } from '../lib/format.ts'

// --- Button -----------------------------------------------------------------

const buttonVariants = cva(
  'inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-lg text-[13px] font-medium transition-[background,color,box-shadow,transform] duration-150 disabled:pointer-events-none disabled:opacity-50 active:scale-[0.98] [&_svg]:size-4 [&_svg]:shrink-0 no-drag cursor-default',
  {
    variants: {
      variant: {
        primary: 'bg-accent text-accent-fg shadow-sm hover:bg-accent-hover',
        secondary: 'bg-surface border border-border text-fg hover:bg-surface-hover shadow-[0_1px_1px_oklch(0.2_0.02_286/0.04)]',
        ghost: 'text-muted hover:text-fg hover:bg-surface-hover',
        soft: 'bg-accent-soft text-accent hover:bg-accent/15',
        danger: 'bg-danger text-white hover:opacity-90',
        'danger-ghost': 'text-danger hover:bg-danger-soft',
      },
      size: {
        sm: 'h-8 px-3',
        md: 'h-9 px-4',
        lg: 'h-11 px-5 text-sm rounded-xl',
        icon: 'size-8',
        'icon-sm': 'size-7 rounded-md',
      },
    },
    defaultVariants: { variant: 'secondary', size: 'md' },
  },
)

export interface ButtonProps extends ComponentProps<'button'>, VariantProps<typeof buttonVariants> {
  asChild?: boolean
  loading?: boolean
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { className, variant, size, asChild, loading, children, disabled, ...props },
  ref,
) {
  const Comp = asChild ? Slot.Root : 'button'
  return (
    <Comp ref={ref} className={cn(buttonVariants({ variant, size }), className)} disabled={disabled || loading} {...props}>
      {loading ? <Loader2 className="animate-spin" /> : null}
      {children}
    </Comp>
  )
})

// --- Card -------------------------------------------------------------------

export function Card({ className, ...props }: ComponentProps<'div'>) {
  return <div className={cn('rounded-2xl border border-border bg-surface shadow-card backdrop-blur-xl', className)} {...props} />
}

export function CardHeader({ title, description, action, className }: { title: ReactNode; description?: ReactNode; action?: ReactNode; className?: string }) {
  return (
    <div className={cn('flex items-start justify-between gap-4 px-5 pt-4', className)}>
      <div className="min-w-0">
        <h3 className="text-[15px] font-semibold tracking-tight">{title}</h3>
        {description ? <p className="mt-0.5 text-[13px] text-muted">{description}</p> : null}
      </div>
      {action ? <div className="flex shrink-0 items-center gap-2">{action}</div> : null}
    </div>
  )
}

// --- Badge ------------------------------------------------------------------

const badgeVariants = cva('inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-[11.5px] font-medium leading-4 whitespace-nowrap [&_svg]:size-3', {
  variants: {
    tone: {
      neutral: 'bg-fg/[0.06] text-muted',
      accent: 'bg-accent-soft text-accent',
      success: 'bg-success-soft text-success',
      warning: 'bg-warning-soft text-warning',
      danger: 'bg-danger-soft text-danger',
      outline: 'border border-border text-muted',
    },
  },
  defaultVariants: { tone: 'neutral' },
})

export function Badge({ className, tone, ...props }: ComponentProps<'span'> & VariantProps<typeof badgeVariants>) {
  return <span className={cn(badgeVariants({ tone }), className)} {...props} />
}

export function StatusDot({ tone, pulse }: { tone: 'success' | 'warning' | 'danger' | 'neutral' | 'accent'; pulse?: boolean }) {
  const color = { success: 'bg-success text-success', warning: 'bg-warning text-warning', danger: 'bg-danger text-danger', neutral: 'bg-subtle text-subtle', accent: 'bg-accent text-accent' }[tone]
  return <span aria-hidden className={cn('inline-block size-2 shrink-0 rounded-full', color, pulse && 'animate-pulse-ring')} />
}

// --- Form controls ---------------------------------------------------------

export const Input = forwardRef<HTMLInputElement, ComponentProps<'input'>>(function Input({ className, ...props }, ref) {
  return (
    <input
      ref={ref}
      className={cn(
        'h-9 w-full min-w-0 rounded-lg border border-border bg-surface-2 px-3 text-[13px] text-fg outline-none transition placeholder:text-subtle hover:border-border-strong focus:border-accent focus:ring-3 focus:ring-accent-ring disabled:opacity-60 no-drag',
        className,
      )}
      {...props}
    />
  )
})

export function SecretInput({ className, ...props }: ComponentProps<'input'>) {
  const [show, setShow] = useState(false)
  return (
    <div className="relative">
      <Input type={show ? 'text' : 'password'} autoComplete="off" spellCheck={false} className={cn('pr-9 font-mono', className)} {...props} />
      <button
        type="button"
        onClick={() => setShow((s) => !s)}
        aria-label={show ? '隐藏' : '显示'}
        className="absolute inset-y-0 right-0 flex w-9 items-center justify-center text-subtle hover:text-fg no-drag"
      >
        {show ? <EyeOff className="size-4" /> : <Eye className="size-4" />}
      </button>
    </div>
  )
}

export function Textarea({ className, ...props }: ComponentProps<'textarea'>) {
  return (
    <textarea
      className={cn(
        'min-h-20 w-full rounded-lg border border-border bg-surface-2 px-3 py-2 text-[13px] outline-none transition placeholder:text-subtle hover:border-border-strong focus:border-accent focus:ring-3 focus:ring-accent-ring no-drag',
        className,
      )}
      {...props}
    />
  )
}

export function Field({
  label,
  hint,
  error,
  children,
  className,
  htmlFor,
}: {
  label: ReactNode
  hint?: ReactNode
  error?: string
  children: ReactNode
  className?: string
  htmlFor?: string
}) {
  return (
    <div className={cn('space-y-1.5', className)}>
      <label htmlFor={htmlFor} className="block text-[12.5px] font-medium text-fg">
        {label}
      </label>
      {children}
      {error ? <p className="text-[12px] text-danger">{error}</p> : hint ? <p className="text-[12px] leading-relaxed text-subtle">{hint}</p> : null}
    </div>
  )
}

export function Switch({ checked, onCheckedChange, disabled, id, label }: { checked: boolean; onCheckedChange: (v: boolean) => void; disabled?: boolean; id?: string; label?: string }) {
  return (
    <RSwitch.Root
      id={id}
      aria-label={label}
      checked={checked}
      onCheckedChange={onCheckedChange}
      disabled={disabled}
      className="relative inline-flex h-5 w-9 shrink-0 items-center rounded-full border border-transparent bg-fg/15 transition-colors data-[state=checked]:bg-accent disabled:opacity-50 no-drag"
    >
      <RSwitch.Thumb className="block size-4 translate-x-0.5 rounded-full bg-white shadow-sm transition-transform data-[state=checked]:translate-x-[17px]" />
    </RSwitch.Root>
  )
}

export function SettingRow({ title, description, children, htmlFor }: { title: ReactNode; description?: ReactNode; children: ReactNode; htmlFor?: string }) {
  return (
    <div className="flex items-center justify-between gap-6 px-5 py-3.5">
      <div className="min-w-0">
        <label htmlFor={htmlFor} className="block text-[13.5px] font-medium">
          {title}
        </label>
        {description ? <p className="mt-0.5 text-[12.5px] leading-relaxed text-muted">{description}</p> : null}
      </div>
      <div className="flex shrink-0 items-center gap-2">{children}</div>
    </div>
  )
}

// --- Select -----------------------------------------------------------------

export interface Option<T extends string = string> {
  value: T
  label: ReactNode
  description?: ReactNode
}

export function SelectBox<T extends string>({
  value,
  onChange,
  options,
  placeholder,
  className,
  id,
  label,
}: {
  value: T | undefined
  onChange: (v: T) => void
  options: Option<T>[]
  placeholder?: string
  className?: string
  id?: string
  label?: string
}) {
  return (
    <Select.Root value={value} onValueChange={(v) => onChange(v as T)}>
      <Select.Trigger
        id={id}
        aria-label={label}
        className={cn(
          'inline-flex h-9 w-full min-w-0 items-center justify-between gap-2 rounded-lg border border-border bg-surface-2 px-3 text-[13px] outline-none hover:border-border-strong focus:border-accent focus:ring-3 focus:ring-accent-ring data-[placeholder]:text-subtle no-drag',
          className,
        )}
      >
        <span className="truncate">
          <Select.Value placeholder={placeholder} />
        </span>
        <Select.Icon>
          <ChevronDown className="size-4 text-subtle" />
        </Select.Icon>
      </Select.Trigger>
      <Select.Portal>
        <Select.Content position="popper" sideOffset={6} className="z-50 max-h-80 min-w-[var(--radix-select-trigger-width)] overflow-hidden rounded-xl border border-border bg-surface-2 p-1 shadow-pop backdrop-blur-2xl animate-pop-in">
          <Select.Viewport>
            {options.map((o) => (
              <Select.Item
                key={o.value}
                value={o.value}
                className="relative flex cursor-default items-center rounded-md py-1.5 pr-8 pl-2.5 text-[13px] outline-none select-none data-[highlighted]:bg-accent-soft data-[highlighted]:text-fg"
              >
                <div className="min-w-0">
                  <Select.ItemText>{o.label}</Select.ItemText>
                  {o.description ? <div className="text-[11.5px] text-subtle">{o.description}</div> : null}
                </div>
                <Select.ItemIndicator className="absolute right-2">
                  <Check className="size-4 text-accent" />
                </Select.ItemIndicator>
              </Select.Item>
            ))}
          </Select.Viewport>
        </Select.Content>
      </Select.Portal>
    </Select.Root>
  )
}

export function Segmented<T extends string>({ value, onChange, options, className, label }: { value: T; onChange: (v: T) => void; options: Option<T>[]; className?: string; label?: string }) {
  return (
    <div role="radiogroup" aria-label={label} className={cn('inline-flex rounded-lg border border-border bg-fg/[0.04] p-0.5 no-drag', className)}>
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          role="radio"
          aria-checked={value === o.value}
          onClick={() => onChange(o.value)}
          className={cn(
            'rounded-md px-3 py-1 text-[12.5px] font-medium text-muted transition-all',
            value === o.value ? 'bg-surface text-fg shadow-sm' : 'hover:text-fg',
          )}
        >
          {o.label}
        </button>
      ))}
    </div>
  )
}

// --- Overlays ---------------------------------------------------------------

export function Modal({
  open,
  onOpenChange,
  title,
  description,
  children,
  footer,
  className,
}: {
  open: boolean
  onOpenChange: (v: boolean) => void
  title: ReactNode
  description?: ReactNode
  children: ReactNode
  footer?: ReactNode
  className?: string
}) {
  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-40 bg-overlay backdrop-blur-[2px] animate-fade-in no-drag" />
        <Dialog.Content
          className={cn(
            'fixed top-1/2 left-1/2 z-50 flex max-h-[calc(100vh-64px)] w-[min(560px,calc(100vw-48px))] -translate-x-1/2 -translate-y-1/2 flex-col rounded-2xl border border-border bg-surface-2 shadow-pop backdrop-blur-2xl animate-pop-in outline-none no-drag',
            className,
          )}
        >
          <div className="flex items-start justify-between gap-4 border-b border-border px-6 pt-5 pb-4">
            <div className="min-w-0">
              <Dialog.Title className="text-[16px] font-semibold tracking-tight">{title}</Dialog.Title>
              {description ? <Dialog.Description className="mt-1 text-[13px] text-muted">{description}</Dialog.Description> : <Dialog.Description className="sr-only">{String(title)}</Dialog.Description>}
            </div>
            <Dialog.Close asChild>
              <Button variant="ghost" size="icon-sm" aria-label="关闭">
                <X />
              </Button>
            </Dialog.Close>
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto px-6 py-5">{children}</div>
          {footer ? <div className="flex shrink-0 items-center justify-end gap-2 border-t border-border px-6 py-3.5">{footer}</div> : null}
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  )
}

export function Sheet({ open, onOpenChange, title, children }: { open: boolean; onOpenChange: (v: boolean) => void; title: ReactNode; children: ReactNode }) {
  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-40 bg-overlay animate-fade-in no-drag" />
        <Dialog.Content className="fixed top-2 right-2 bottom-2 z-50 flex w-[min(620px,calc(100vw-80px))] flex-col rounded-2xl border border-border bg-surface-2 shadow-pop backdrop-blur-2xl animate-slide-in outline-none no-drag">
          <div className="flex items-center justify-between gap-4 border-b border-border px-5 py-3.5">
            <Dialog.Title className="truncate text-[15px] font-semibold">{title}</Dialog.Title>
            <Dialog.Description className="sr-only">详情</Dialog.Description>
            <Dialog.Close asChild>
              <Button variant="ghost" size="icon-sm" aria-label="关闭">
                <X />
              </Button>
            </Dialog.Close>
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto p-5">{children}</div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  )
}

export function Confirm({
  open,
  onOpenChange,
  title,
  description,
  confirmText = '确定',
  danger,
  onConfirm,
}: {
  open: boolean
  onOpenChange: (v: boolean) => void
  title: ReactNode
  description?: ReactNode
  confirmText?: string
  danger?: boolean
  onConfirm: () => void | Promise<void>
}) {
  const [busy, setBusy] = useState(false)
  return (
    <AlertDialog.Root open={open} onOpenChange={onOpenChange}>
      <AlertDialog.Portal>
        <AlertDialog.Overlay className="fixed inset-0 z-40 bg-overlay animate-fade-in no-drag" />
        <AlertDialog.Content className="fixed top-1/2 left-1/2 z-50 w-[min(420px,calc(100vw-48px))] -translate-x-1/2 -translate-y-1/2 rounded-2xl border border-border bg-surface-2 p-6 shadow-pop backdrop-blur-2xl animate-pop-in no-drag">
          <AlertDialog.Title className="text-[15px] font-semibold">{title}</AlertDialog.Title>
          <AlertDialog.Description className="mt-2 text-[13px] leading-relaxed text-muted">{description}</AlertDialog.Description>
          <div className="mt-5 flex justify-end gap-2">
            <AlertDialog.Cancel asChild>
              <Button>取消</Button>
            </AlertDialog.Cancel>
            <Button
              variant={danger ? 'danger' : 'primary'}
              loading={busy}
              onClick={async () => {
                setBusy(true)
                try {
                  await onConfirm()
                  onOpenChange(false)
                } finally {
                  setBusy(false)
                }
              }}
            >
              {confirmText}
            </Button>
          </div>
        </AlertDialog.Content>
      </AlertDialog.Portal>
    </AlertDialog.Root>
  )
}

export const Menu = DropdownMenu.Root
export const MenuTrigger = DropdownMenu.Trigger

export function MenuContent({ children, align = 'end' }: { children: ReactNode; align?: 'start' | 'end' | 'center' }) {
  return (
    <DropdownMenu.Portal>
      <DropdownMenu.Content align={align} sideOffset={6} className="z-50 min-w-44 rounded-xl border border-border bg-surface-2 p-1 shadow-pop backdrop-blur-2xl animate-pop-in no-drag">
        {children}
      </DropdownMenu.Content>
    </DropdownMenu.Portal>
  )
}

export function MenuItem({ children, onSelect, danger, disabled }: { children: ReactNode; onSelect?: () => void; danger?: boolean; disabled?: boolean }) {
  return (
    <DropdownMenu.Item
      disabled={disabled}
      onSelect={onSelect}
      className={cn(
        'flex cursor-default items-center gap-2 rounded-md px-2.5 py-1.5 text-[13px] outline-none select-none data-[disabled]:opacity-40 data-[highlighted]:bg-accent-soft [&_svg]:size-4 [&_svg]:text-subtle',
        danger && 'text-danger data-[highlighted]:bg-danger-soft [&_svg]:text-danger',
      )}
    >
      {children}
    </DropdownMenu.Item>
  )
}

export function MenuSeparator() {
  return <DropdownMenu.Separator className="my-1 h-px bg-border" />
}

export function Tip({ content, children, side = 'top' }: { content: ReactNode; children: ReactNode; side?: 'top' | 'bottom' | 'left' | 'right' }) {
  return (
    <Tooltip.Root delayDuration={250}>
      <Tooltip.Trigger asChild>{children}</Tooltip.Trigger>
      <Tooltip.Portal>
        <Tooltip.Content side={side} sideOffset={6} className="z-50 max-w-72 rounded-lg bg-[oklch(0.24_0.01_286)] px-2.5 py-1.5 text-[12px] leading-snug text-white shadow-pop animate-fade-in dark:bg-[oklch(0.93_0.005_286)] dark:text-[oklch(0.2_0.01_286)]">
          {content}
        </Tooltip.Content>
      </Tooltip.Portal>
    </Tooltip.Root>
  )
}

export const TooltipProvider = Tooltip.Provider

export function PopoverBox({ trigger, children, align = 'start', className }: { trigger: ReactNode; children: ReactNode; align?: 'start' | 'end'; className?: string }) {
  return (
    <Popover.Root>
      <Popover.Trigger asChild>{trigger}</Popover.Trigger>
      <Popover.Portal>
        <Popover.Content align={align} sideOffset={6} className={cn('z-50 rounded-xl border border-border bg-surface-2 p-1 shadow-pop backdrop-blur-2xl animate-pop-in outline-none no-drag', className)}>
          {children}
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  )
}

export const PopoverClose = Popover.Close

export function TabsBar<T extends string>({ value, onChange, tabs }: { value: T; onChange: (v: T) => void; tabs: Option<T>[] }) {
  return (
    <Tabs.Root value={value} onValueChange={(v) => onChange(v as T)}>
      <Tabs.List className="inline-flex gap-1 rounded-lg border border-border bg-fg/[0.04] p-0.5 no-drag">
        {tabs.map((t) => (
          <Tabs.Trigger
            key={t.value}
            value={t.value}
            className="rounded-md px-3 py-1 text-[12.5px] font-medium text-muted transition data-[state=active]:bg-surface data-[state=active]:text-fg data-[state=active]:shadow-sm hover:text-fg"
          >
            {t.label}
          </Tabs.Trigger>
        ))}
      </Tabs.List>
    </Tabs.Root>
  )
}

// --- Misc -------------------------------------------------------------------

export function Skeleton({ className }: { className?: string }) {
  return <div className={cn('animate-pulse rounded-md bg-fg/[0.07]', className)} />
}

export function EmptyState({ icon, title, description, action }: { icon: ReactNode; title: ReactNode; description?: ReactNode; action?: ReactNode }) {
  return (
    <div className="flex flex-col items-center justify-center px-6 py-12 text-center">
      <div className="mb-4 flex size-12 items-center justify-center rounded-2xl bg-accent-soft text-accent [&_svg]:size-6">{icon}</div>
      <div className="text-[15px] font-semibold">{title}</div>
      {description ? <p className="mt-1 max-w-sm text-[13px] leading-relaxed text-muted">{description}</p> : null}
      {action ? <div className="mt-5">{action}</div> : null}
    </div>
  )
}

export function Kbd({ children }: { children: ReactNode }) {
  return <kbd className="rounded border border-border bg-surface px-1.5 py-0.5 font-mono text-[11px] text-muted">{children}</kbd>
}

export function useFieldId(): string {
  return useId()
}
