import * as React from "react"
import { Tooltip as SdkTooltip, TooltipTrigger } from "@ui-sdk/react/tooltip"

// The hint is a small LCD beside its control, its characters faint until the
// control is hovered or focused, when they darken one after another. The
// trigger's aria-label already names it, so the screen is hidden from screen
// readers.
// Touch screens have no hover, and a tapped button isn't focused in Safari, so
// there a press opens and closes the tooltip instead.
const touch = typeof matchMedia !== "undefined" && matchMedia("(pointer: coarse)").matches

function Tooltip({ label, children }: { label: string; children: React.ReactNode }) {
  const [open, setOpen] = React.useState(false)
  const wrap = React.useRef<HTMLSpanElement>(null)
  // On a touch screen nothing hovers away, so an open tooltip closes on a
  // tap anywhere else, or by itself after a moment.
  React.useEffect(() => {
    if (!touch || !open) return
    const away = (event: PointerEvent) => {
      if (!wrap.current?.contains(event.target as Node)) setOpen(false)
    }
    const timer = setTimeout(() => setOpen(false), 2500)
    document.addEventListener("pointerdown", away, true)
    return () => {
      clearTimeout(timer)
      document.removeEventListener("pointerdown", away, true)
    }
  }, [open])
  return (
    <span data-kit="tooltip-wrap" ref={wrap}>
      <span data-kit="tooltip-legend" data-open={open || undefined} aria-hidden>
        {[...label].map((char, i) => (
          <span key={i} style={{ "--i": i } as React.CSSProperties}>
            {char}
          </span>
        ))}
      </span>
      <SdkTooltip open={open} onOpenChange={setOpen} toggleable={touch}>
        <TooltipTrigger data-kit="tooltip-trigger" aria-label={label}>
          {children}
        </TooltipTrigger>
      </SdkTooltip>
    </span>
  )
}

export { Tooltip }
