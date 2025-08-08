"use client"

import * as React from "react"
import { cn } from "@/lib/utils"

type Variant = "default" | "outline" | "ghost" | "danger"
type Size = "sm" | "md" | "icon"

export interface SquareButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: Variant
  size?: Size
}

export const SquareButton = React.forwardRef<HTMLButtonElement, SquareButtonProps>(function SquareButton(
  { className, variant = "outline", size = "sm", ...props },
  ref
) {
  const base =
    "inline-flex items-center justify-center whitespace-nowrap select-none border transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-neutral-400 disabled:opacity-50 disabled:pointer-events-none"

  const sizes: Record<Size, string> = {
    sm: "h-8 px-3 text-xs",
    md: "h-9 px-3.5 text-sm",
    icon: "h-8 w-8 p-0",
  }

  const variants: Record<Variant, string> = {
    // Slightly emphasized neutral
    "default": "bg-neutral-100 text-neutral-900 border-neutral-300 hover:bg-neutral-200",
    // Light neutral tile (used as our main style)
    outline: "bg-white text-neutral-800 border-neutral-300 hover:bg-neutral-100",
    // Minimal, no border
    ghost: "border-transparent text-neutral-700 hover:bg-neutral-100",
    // Subtle danger
    danger: "bg-white text-red-700 border-red-300 hover:bg-red-50",
  }

  return (
    <button ref={ref} className={cn(base, sizes[size], variants[variant], className)} {...props} />
  )
})
