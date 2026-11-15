import * as React from "react"
import { HoverCard as SdkHoverCard, HoverCardContent, HoverCardTrigger } from "@ui-sdk/react/hover-card"

// Whether the page is used by touch, where nothing hovers.
const coarse = typeof matchMedia !== "undefined" && matchMedia("(pointer: coarse)").matches

// Nothing hovers on a touch screen, so there a tap on the trigger opens the
// card and closes it, and a tap anywhere else closes it.
// A hover card: a gray LCD that swings out above its trigger and prints its
// lines one after another. Hovered or focused with a mouse and keyboard; on
// touch screens a tap on the trigger opens and closes it, and a tap anywhere
// else closes it. `trigger` is what it opens from; `triggerKit` styles that
// (a link by default); `variant` lays out the screen for its content. Pass
// `open` and `onOpenChange` to hold its state outside, as a row of cards
// that may only show one at a time does.
function HoverCard({
  trigger,
  children,
  triggerKit = "link",
  variant,
  open: held,
  onOpenChange,
}: {
  trigger: React.ReactNode
  children: React.ReactNode
  triggerKit?: string
  variant?: string
  open?: boolean
  onOpenChange?: (open: boolean) => void
}) {
  const [own, setOwn] = React.useState(false)
  const open = held ?? own
  const setOpen = onOpenChange ?? setOwn
  const triggerEl = React.useRef<HTMLAnchorElement>(null)
  React.useEffect(() => {
    if (!coarse || !open) return
    const away = (event: PointerEvent) => {
      const target = event.target as Element
      if (triggerEl.current?.contains(target) || target.closest?.("[data-hover-card]")) return
      setOpen(false)
    }
    document.addEventListener("pointerdown", away, true)
    return () => document.removeEventListener("pointerdown", away, true)
  }, [open])
  return (
    <SdkHoverCard open={open} onOpenChange={coarse ? undefined : setOpen}>
      <HoverCardTrigger
        ref={triggerEl}
        data-kit={triggerKit}
        tabIndex={0}
        onClick={coarse ? () => setOpen(!open) : undefined}
      >
        {trigger}
      </HoverCardTrigger>
      <HoverCardContent data-kit="popover" data-hover-card side="top" sideOffset={16}>
        <div data-kit="hover-lcd" data-variant={variant}>
          {children}
        </div>
      </HoverCardContent>
    </SdkHoverCard>
  )
}

// The catalog's profile card: initials beside a name and a bio, and a
// status line, printing in turn.
function ProfileHoverCard({ name, handle, bio }: { name: string; handle: string; bio: string }) {
  return (
    <HoverCard trigger={handle}>
      <span data-kit="hover-lcd-initials" aria-hidden style={{ "--i": 0 } as React.CSSProperties}>
        {name
          .split(" ")
          .map((part) => part[0])
          .join("")}
      </span>
      <strong style={{ "--i": 1 } as React.CSSProperties}>{name}</strong>
      <p style={{ "--i": 2 } as React.CSSProperties}>{bio}</p>
      <span data-kit="hover-lcd-status" style={{ "--i": 3 } as React.CSSProperties}>
        {handle} · online
      </span>
    </HoverCard>
  )
}

export { HoverCard, ProfileHoverCard }
