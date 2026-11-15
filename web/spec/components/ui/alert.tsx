import * as React from "react"

type Tone = "neutral" | "info" | "success" | "warning" | "danger"

function Alert({
  tone = "info",
  title,
  children,
}: {
  tone?: Tone
  title: string
  children: React.ReactNode
}) {
  return (
    <div data-kit="alert" data-tone={tone} role={tone === "danger" ? "alert" : "status"}>
      <div data-kit="legend">
        <span data-kit="alert-led" aria-hidden />
        <strong data-kit="alert-title">{title}</strong>
      </div>
      <p data-kit="alert-description">{children}</p>
    </div>
  )
}

export { Alert }
