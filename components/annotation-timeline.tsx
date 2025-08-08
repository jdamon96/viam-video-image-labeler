"use client"

import * as React from "react"
import { cn } from "@/lib/utils"

export type TimelineAnnotation = {
  id: string
  start: number
  end: number
  color: string
  label?: string
}

type DragState =
  | { type: "none" }
  | { type: "seek"; startX: number }
  | { type: "move"; id: string; startX: number; origStart: number; origEnd: number }
  | { type: "resize-left"; id: string; startX: number; origStart: number; origEnd: number }
  | { type: "resize-right"; id: string; startX: number; origStart: number; origEnd: number }
  | { type: "select-range"; startX: number; anchorTime: number }
  | { type: "selection-move"; startX: number; origStart: number; origEnd: number }
  | { type: "selection-left"; startX: number; origStart: number; origEnd: number }
  | { type: "selection-right"; startX: number; origStart: number; origEnd: number }

export function AnnotationTimeline({
  duration,
  currentTime,
  onSeek,
  annotations,
  selectedId,
  onSelect,
  onChangeTime,
  selection,
  onSelectionChange,
  selectMode = false,
  minClipLen = 0.1,
  className,
}: {
  duration: number
  currentTime: number
  onSeek: (t: number) => void
  annotations: TimelineAnnotation[]
  selectedId: string | null
  onSelect: (id: string) => void
  onChangeTime: (id: string, next: { start?: number; end?: number }) => void
  selection: { start: number; end: number } | null
  onSelectionChange: (s: { start: number; end: number } | null) => void
  selectMode?: boolean
  minClipLen?: number
  className?: string
}) {
  const containerRef = React.useRef<HTMLDivElement | null>(null)
  const [width, setWidth] = React.useState(600)
  const [drag, setDrag] = React.useState<DragState>({ type: "none" })

  React.useEffect(() => {
    const el = containerRef.current
    if (!el) return
    const ro = new ResizeObserver(() => setWidth(el.clientWidth))
    ro.observe(el)
    setWidth(el.clientWidth)
    return () => ro.disconnect()
  }, [])

  function clamp(val: number, min: number, max: number) {
    return Math.min(max, Math.max(min, val))
  }

  function xToTime(clientX: number, element: HTMLElement): number {
    const rect = element.getBoundingClientRect()
    const ratio = (clientX - rect.left) / Math.max(1, rect.width)
    return clamp(ratio * duration, 0, duration)
  }

  function onScrubPointerDown(e: React.PointerEvent) {
    if (!containerRef.current) return
    const t = xToTime(e.clientX, containerRef.current)
    ;(e.target as Element).setPointerCapture(e.pointerId)
    if (selectMode) {
      onSelectionChange({ start: t, end: t })
      setDrag({ type: "select-range", startX: e.clientX, anchorTime: t })
    } else {
      onSeek(t)
      setDrag({ type: "seek", startX: e.clientX })
    }
  }

  function onScrubPointerMove(e: React.PointerEvent) {
    if (!containerRef.current) return
    const rect = containerRef.current.getBoundingClientRect()
    const dt = ((e.clientX - (drag as any).startX) / Math.max(1, rect.width)) * duration

    if (drag.type === "seek") {
      const t = xToTime(e.clientX, containerRef.current)
      onSeek(t)
    } else if (drag.type === "select-range") {
      const t = xToTime(e.clientX, containerRef.current)
      const s = Math.min(drag.anchorTime, t)
      const en = Math.max(drag.anchorTime, t)
      onSelectionChange({ start: s, end: en })
    } else if (drag.type === "move") {
      const len = drag.origEnd - drag.origStart
      let newStart = clamp(drag.origStart + dt, 0, Math.max(0, duration - len))
      let newEnd = newStart + len
      onChangeTime(drag.id, { start: newStart, end: newEnd })
    } else if (drag.type === "resize-left") {
      let newStart = clamp(drag.origStart + dt, 0, drag.origEnd - minClipLen)
      onChangeTime(drag.id, { start: newStart })
    } else if (drag.type === "resize-right") {
      let newEnd = clamp(drag.origEnd + dt, drag.origStart + minClipLen, duration)
      onChangeTime(drag.id, { end: newEnd })
    } else if (drag.type === "selection-move" && selection) {
      const len = drag.origEnd - drag.origStart
      let newStart = clamp(drag.origStart + dt, 0, Math.max(0, duration - len))
      let newEnd = newStart + len
      onSelectionChange({ start: newStart, end: newEnd })
    } else if (drag.type === "selection-left" && selection) {
      let newStart = clamp(drag.origStart + dt, 0, (drag.origEnd) - minClipLen)
      onSelectionChange({ start: newStart, end: selection.end })
    } else if (drag.type === "selection-right" && selection) {
      let newEnd = clamp(drag.origEnd + dt, (drag.origStart) + minClipLen, duration)
      onSelectionChange({ start: selection.start, end: newEnd })
    }
  }

  function onScrubPointerUp() {
    setDrag({ type: "none" })
  }

  function startMove(id: string, e: React.PointerEvent, origStart: number, origEnd: number) {
    ;(e.currentTarget as Element).setPointerCapture(e.pointerId)
    setDrag({ type: "move", id, startX: e.clientX, origStart, origEnd })
  }
  function startResizeLeft(id: string, e: React.PointerEvent, origStart: number, origEnd: number) {
    ;(e.currentTarget as Element).setPointerCapture(e.pointerId)
    setDrag({ type: "resize-left", id, startX: e.clientX, origStart, origEnd })
  }
  function startResizeRight(id: string, e: React.PointerEvent, origStart: number, origEnd: number) {
    ;(e.currentTarget as Element).setPointerCapture(e.pointerId)
    setDrag({ type: "resize-right", id, startX: e.clientX, origStart, origEnd })
  }

  function startSelectionMove(e: React.PointerEvent) {
    if (!selection) return
    e.stopPropagation()
    e.preventDefault()
    ;(e.currentTarget as Element).setPointerCapture(e.pointerId)
    setDrag({ type: "selection-move", startX: e.clientX, origStart: selection.start, origEnd: selection.end })
  }
  function startSelectionLeft(e: React.PointerEvent) {
    if (!selection) return
    e.stopPropagation()
    e.preventDefault()
    ;(e.currentTarget as Element).setPointerCapture(e.pointerId)
    setDrag({ type: "selection-left", startX: e.clientX, origStart: selection.start, origEnd: selection.end })
  }
  function startSelectionRight(e: React.PointerEvent) {
    if (!selection) return
    e.stopPropagation()
    e.preventDefault()
    ;(e.currentTarget as Element).setPointerCapture(e.pointerId)
    setDrag({ type: "selection-right", startX: e.clientX, origStart: selection.start, origEnd: selection.end })
  }

  const playheadLeft = `${duration > 0 ? (currentTime / duration) * 100 : 0}%`

  // Derived selection style
  const selectionLeft = selection ? `${(selection.start / Math.max(1e-6, duration)) * 100}%` : "0%"
  const selectionWidth = selection ? `${((selection.end - selection.start) / Math.max(1e-6, duration)) * 100}%` : "0%"

  return (
    <div
      ref={containerRef}
      className={cn("w-full select-none", className)}
      onPointerMove={onScrubPointerMove}
      onPointerUp={onScrubPointerUp}
      onPointerCancel={onScrubPointerUp}
    >
      {/* Scrub bar (also selection-creation surface) */}
      <div
        className={cn(
          "relative h-8 rounded-md border bg-neutral-100",
          selectMode ? "ring-2 ring-emerald-500/70" : ""
        )}
        onPointerDown={onScrubPointerDown}
        aria-label="Timeline scrub bar"
      >
        {/* ticks (every 10% for simplicity) */}
        {Array.from({ length: 11 }).map((_, i) => (
          <div
            key={i}
            className="absolute top-0 h-full border-r border-neutral-200"
            style={{ left: `${(i / 10) * 100}%` }}
          />
        ))}

        {/* selection band (on scrub bar) */}
        {selection ? (
          <div
            className="absolute top-0 h-full"
            style={{
              left: selectionLeft,
              width: selectionWidth,
            }}
          >
            <div
              className="absolute inset-0 bg-emerald-500/15 border-y border-emerald-500/30 cursor-grab active:cursor-grabbing"
              onPointerDown={startSelectionMove}
              title={`Selection ${selection.start.toFixed(2)}s → ${selection.end.toFixed(2)}s`}
            />
            {/* left handle */}
            <div
              className="absolute left-0 top-0 h-full w-2 bg-emerald-500/40 cursor-ew-resize"
              onPointerDown={startSelectionLeft}
              aria-label="Resize selection start"
            />
            {/* right handle */}
            <div
              className="absolute right-0 top-0 h-full w-2 bg-emerald-500/40 cursor-ew-resize"
              onPointerDown={startSelectionRight}
              aria-label="Resize selection end"
            />
          </div>
        ) : null}

        {/* playhead */}
        <div
          className="absolute top-0 h-full w-0.5 bg-emerald-600"
          style={{ left: playheadLeft }}
          aria-label="Playhead"
        />
      </div>

      {/* Triangle track */}
      <div className="relative mt-2 h-10 rounded-md border bg-white overflow-hidden" aria-label="Triangle track">
        {annotations.map((a) => {
          const leftPct = (a.start / Math.max(1e-6, duration)) * 100
          const wPct = ((a.end - a.start) / Math.max(1e-6, duration)) * 100
          return (
            <div
              key={a.id}
              className={cn(
                "absolute top-1 h-8 rounded-md border cursor-grab active:cursor-grabbing",
                selectedId === a.id ? "ring-2 ring-emerald-500" : ""
              )}
              style={{
                left: `${leftPct}%`,
                width: `max(6px, ${wPct}%)`,
                borderColor: a.color,
                background: "linear-gradient(to right, rgba(0,0,0,0.04), rgba(0,0,0,0.02))",
              }}
              onClick={(e) => {
                e.stopPropagation()
                onSelect(a.id)
              }}
              onPointerDown={(e) => {
                e.stopPropagation()
                onSelect(a.id)
                startMove(a.id, e, a.start, a.end)
              }}
              title={`${a.label ?? "Triangle"} ${a.start.toFixed(2)}s → ${a.end.toFixed(2)}s`}
            >
              {/* left handle */}
              <div
                className="absolute left-0 top-0 h-full w-2 cursor-ew-resize bg-[rgba(0,0,0,0.05)]"
                onPointerDown={(e) => {
                  e.stopPropagation()
                  onSelect(a.id)
                  startResizeLeft(a.id, e, a.start, a.end)
                }}
              />
              {/* right handle */}
              <div
                className="absolute right-0 top-0 h-full w-2 cursor-ew-resize bg-[rgba(0,0,0,0.05)]"
                onPointerDown={(e) => {
                  e.stopPropagation()
                  onSelect(a.id)
                  startResizeRight(a.id, e, a.start, a.end)
                }}
              />
              {/* color strip */}
              <div
                className="absolute left-0 top-0 h-full"
                style={{ width: 4, backgroundColor: a.color, borderTopLeftRadius: 6, borderBottomLeftRadius: 6 }}
                aria-hidden
              />
            </div>
          )
        })}
      </div>
    </div>
  )
}
