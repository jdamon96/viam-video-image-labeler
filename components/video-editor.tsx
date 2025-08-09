"use client"

import React from "react"
import { SquareButton as Button } from "@/components/square-button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Slider } from "@/components/ui/slider"
import { Switch } from "@/components/ui/switch"
import { Progress } from "@/components/ui/progress"
import { Separator } from "@/components/ui/separator"
import { toast } from "@/hooks/use-toast"
import { cn } from "@/lib/utils"
import { Play, Pause, FastForward, Rewind, Upload, Scissors, Download, Trash2, Clock, TextSelectIcon as Selection } from 'lucide-react'
import JSZip from "jszip"
import { createViamClient, type ViamClient } from "@viamrobotics/sdk"
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from "@/components/ui/dialog"
import { AnnotationTimeline, type TimelineAnnotation, type TriangleTrack } from "./annotation-timeline"

type FrameInfo = {
index: number
time: number
blob: Blob
objectUrl: string
}

type TriangleAnnotation = {
id: string
x: number // normalized [0..1]
y: number // normalized [0..1]
size: number // normalized size relative to min(videoWidth, videoHeight)
color: string
strokeWidth: number
start: number
end: number
label?: string
}

function formatTime(totalSeconds: number): string {
if (!isFinite(totalSeconds) || totalSeconds < 0) totalSeconds = 0
const hours = Math.floor(totalSeconds / 3600)
const minutes = Math.floor((totalSeconds % 3600) / 60)
const seconds = Math.floor(totalSeconds % 60)
const ms = Math.floor((totalSeconds - Math.floor(totalSeconds)) * 1000)
const hh = hours.toString().padStart(2, "0")
const mm = minutes.toString().padStart(2, "0")
const ss = seconds.toString().padStart(2, "0")
if (hours > 0) return `${hh}:${mm}:${ss}.${ms.toString().padStart(3, "0")}`
return `${mm}:${ss}.${ms.toString().padStart(3, "0")}`
}

function clamp(val: number, min: number, max: number) {
return Math.min(max, Math.max(min, val))
}

function getUUID() {
if (typeof crypto !== "undefined" && "randomUUID" in crypto) return crypto.randomUUID()
return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, function (c) {
  const r = (Math.random() * 16) | 0
  const v = c === "x" ? r : (r & 0x3) | 0x8
  return v.toString(16)
})
}

function createTriangleTracks(annotations: TriangleAnnotation[]): TriangleTrack[] {
  // Group annotations by triangle ID (we'll use a combination of position and color as a proxy for triangle identity)
  const triangleMap = new Map<string, TriangleAnnotation[]>()
  
  annotations.forEach(annotation => {
    // Create a unique triangle identifier based on position and color
    // This assumes triangles at the same position with the same color are the same triangle
    const triangleId = `${Math.round(annotation.x * 100)}_${Math.round(annotation.y * 100)}_${annotation.color}`
    
    if (!triangleMap.has(triangleId)) {
      triangleMap.set(triangleId, [])
    }
    triangleMap.get(triangleId)!.push(annotation)
  })
  
  // Convert to triangle tracks
  const tracks: TriangleTrack[] = []
  triangleMap.forEach((triangleAnnotations, triangleId) => {
    // Sort annotations by start time
    triangleAnnotations.sort((a, b) => a.start - b.start)
    
    // Create track label
    const firstAnnotation = triangleAnnotations[0]
    const triangleLabel = firstAnnotation.label || 
      `Triangle (${Math.round(firstAnnotation.x * 100)}%, ${Math.round(firstAnnotation.y * 100)}%)`
    
    // Convert to timeline annotations
    const timelineAnnotations: TimelineAnnotation[] = triangleAnnotations.map(annotation => ({
      id: annotation.id,
      start: annotation.start,
      end: annotation.end,
      color: annotation.color,
      label: annotation.label
    }))
    
    tracks.push({
      triangleId,
      triangleLabel,
      color: firstAnnotation.color,
      annotations: timelineAnnotations
    })
  })
  
  return tracks
}

// Helper function to check if a point is inside an equilateral triangle
function isPointInTriangle(px: number, py: number, triangle: TriangleAnnotation, videoWidth: number, videoHeight: number): boolean {
  // Calculate triangle vertices using the same logic as the drawing function
  // Use the smaller dimension for consistent sizing (same as rendering)
  const minDim = Math.min(videoWidth, videoHeight)
  const sideLength = triangle.size * minDim
  
  // Calculate equilateral triangle geometry
  const triangleHeight = sideLength * Math.sqrt(3) / 2
  const halfBase = sideLength / 2
  const centroidOffset = triangleHeight / 3
  
  // Convert triangle center from normalized to video coordinates
  const centerX = triangle.x * videoWidth
  const centerY = triangle.y * videoHeight
  
  // Triangle vertices in video coordinates
  const ax = centerX // Top vertex
  const ay = centerY - (triangleHeight - centroidOffset)
  const bx = centerX - halfBase // Bottom left
  const by = centerY + centroidOffset
  const cx = centerX + halfBase // Bottom right  
  const cy = centerY + centroidOffset
  
  // Convert click point from normalized to video coordinates
  const clickX = px * videoWidth
  const clickY = py * videoHeight
  
  // Use barycentric coordinate system to check if point is inside triangle
  const denom = (by - cy) * (ax - cx) + (cx - bx) * (ay - cy)
  if (Math.abs(denom) < 1e-10) return false // Degenerate triangle
  
  const a = ((by - cy) * (clickX - cx) + (cx - bx) * (clickY - cy)) / denom
  const b = ((cy - ay) * (clickX - cx) + (ax - cx) * (clickY - cy)) / denom
  const c = 1 - a - b
  
  return a >= 0 && b >= 0 && c >= 0
}

// Find triangle at the given position that's currently active
function findTriangleAtPosition(x: number, y: number, currentTime: number, annotations: TriangleAnnotation[], videoWidth: number, videoHeight: number): TriangleAnnotation | null {
  // Get active annotations at current time, sorted by creation order (latest first for better selection)
  const activeAnnotations = annotations
    .filter(a => currentTime >= a.start && currentTime <= a.end)
    .reverse() // Latest created triangles get priority for selection
  
  // Check each active triangle to see if the click is inside it
  for (const annotation of activeAnnotations) {
    if (isPointInTriangle(x, y, annotation, videoWidth, videoHeight)) {
      return annotation
    }
  }
  
  return null
}

export function VideoEditor() {
const videoRef = React.useRef<HTMLVideoElement | null>(null)
const overlayLayerRef = React.useRef<HTMLDivElement | null>(null)

const [videoUrl, setVideoUrl] = React.useState<string | null>(null)
const [videoName, setVideoName] = React.useState<string>("")
const [duration, setDuration] = React.useState<number>(0)
const [videoSize, setVideoSize] = React.useState<{ width: number; height: number }>({ width: 0, height: 0 })

const [currentTime, setCurrentTime] = React.useState<number>(0)
const [isPlaying, setIsPlaying] = React.useState<boolean>(false)
const [playbackRate, setPlaybackRate] = React.useState<number>(1)

// Annotations (multiple, with time ranges)
const [annotations, setAnnotations] = React.useState<TriangleAnnotation[]>([])
const [overlayEnabled, setOverlayEnabled] = React.useState<boolean>(true)
const [selectedId, setSelectedId] = React.useState<string | null>(null)
const [draggingAnnoId, setDraggingAnnoId] = React.useState<string | null>(null)
const defaultAnnoDuration = 3 // seconds
const suppressClickRef = React.useRef<boolean>(false)

// Selection (splice), integrated into timeline
const [selection, setSelection] = React.useState<{ start: number; end: number } | null>(null)
const [selectMode, setSelectMode] = React.useState<boolean>(false)

const [samplingHz, setSamplingHz] = React.useState<number>(1)
// Always burn-in annotations; we keep state internal as true (no UI toggle)
const [burnInAnnotation] = React.useState<boolean>(true)
const [frames, setFrames] = React.useState<FrameInfo[]>([])
const [sampling, setSampling] = React.useState<boolean>(false)
const [progress, setProgress] = React.useState<number>(0)
const [sequenceId, setSequenceId] = React.useState<string>(getUUID())

// Viam: credentials, dataset and upload state
const [viamApiKey, setViamApiKey] = React.useState<string>("")
const [viamApiKeyId, setViamApiKeyId] = React.useState<string>("")
const [viamDatasetId, setViamDatasetId] = React.useState<string>("")
// No default text in the input; fallback handled in upload call
const [partId, setPartId] = React.useState<string>("")
const [uploading, setUploading] = React.useState<boolean>(false)
const [uploadProgress, setUploadProgress] = React.useState<number>(0)
const [viamTags, setViamTags] = React.useState<string>("")

const [previewOpen, setPreviewOpen] = React.useState<boolean>(false)
const [previewIndex, setPreviewIndex] = React.useState<number>(0)

React.useEffect(() => {
  return () => {
    frames.forEach((f) => URL.revokeObjectURL(f.objectUrl))
    if (videoUrl) URL.revokeObjectURL(videoUrl)
  }
  // eslint-disable-next-line react-hooks/exhaustive-deps
}, [])

React.useEffect(() => {
  const video = videoRef.current
  if (!video) return
  const onLoaded = () => {
    setDuration(video.duration || 0)
    setVideoSize({ width: video.videoWidth, height: video.videoHeight })
    setCurrentTime(0)
    const defaultEnd = Math.min(30, video.duration || 0)
    if (defaultEnd > 0) setSelection({ start: 0, end: defaultEnd })
  }
  const onTime = () => setCurrentTime(video.currentTime)
  const onEnded = () => setIsPlaying(false)
  video.addEventListener("loadedmetadata", onLoaded)
  video.addEventListener("timeupdate", onTime)
  video.addEventListener("ended", onEnded)
  return () => {
    video.removeEventListener("loadedmetadata", onLoaded)
    video.removeEventListener("timeupdate", onTime)
    video.removeEventListener("ended", onEnded)
  }
}, [videoUrl])

React.useEffect(() => {
  if (videoRef.current) videoRef.current.playbackRate = playbackRate
}, [playbackRate])

const togglePlay = React.useCallback(() => {
  const video = videoRef.current
  if (!video) return
  if (isPlaying) {
    video.pause()
    setIsPlaying(false)
  } else {
    video.play().then(
      () => setIsPlaying(true),
      (err) => {
        console.error(err)
        toast({ title: "Cannot play", description: "Autoplay may be blocked. Click play again." })
      }
    )
  }
}, [isPlaying])

// Delete/Backspace/Spacebar support
React.useEffect(() => {
  const isTypingTarget = (el: EventTarget | null) => {
    if (!(el instanceof HTMLElement)) return false
    const tag = el.tagName.toLowerCase()
    return tag === "input" || tag === "textarea" || el.isContentEditable
  }
  const onKeyDown = (e: KeyboardEvent) => {
    // Handle spacebar for play/pause when video is loaded
    if (e.key === " " || e.code === "Space") {
      if (videoUrl && !isTypingTarget(e.target)) {
        e.preventDefault()
        togglePlay()
        return
      }
    }
    
    if (!selectedId) return
    if (isTypingTarget(e.target)) return
    if (e.key === "Delete" || e.key === "Backspace") {
      e.preventDefault()
      setAnnotations((prev) => prev.filter((a) => a.id !== selectedId))
      setSelectedId(null)
    } else if (e.key === "Escape") {
      setSelectedId(null)
    }
  }
  window.addEventListener("keydown", onKeyDown)
  return () => window.removeEventListener("keydown", onKeyDown)
}, [selectedId, videoUrl, togglePlay])

React.useEffect(() => {
  if (!previewOpen) return
  const onKey = (e: KeyboardEvent) => {
    if (e.key === "ArrowLeft") {
      e.preventDefault()
      setPreviewIndex((i) => (frames.length ? (i - 1 + frames.length) % frames.length : 0))
    } else if (e.key === "ArrowRight") {
      e.preventDefault()
      setPreviewIndex((i) => (frames.length ? (i + 1) % frames.length : 0))
    }
  }
  window.addEventListener("keydown", onKey)
  return () => window.removeEventListener("keydown", onKey)
}, [previewOpen, frames.length])

function onSelectFile(file: File) {
  try {
    const url = URL.createObjectURL(file)
    if (videoUrl) URL.revokeObjectURL(videoUrl)
    setVideoUrl(url)
    setVideoName(file.name)
    setFrames((prev) => {
      prev.forEach((f) => URL.revokeObjectURL(f.objectUrl))
      return []
    })
    setSequenceId(getUUID())
    setAnnotations([])
    setSelectedId(null)
    setSelection(null)
    setSelectMode(false)
    setCurrentTime(0)
    setIsPlaying(false)
  } catch (e) {
    console.error(e)
    toast({ title: "Failed to load file", description: "Try a different video file.", variant: "destructive" })
  }
}

function seekBy(delta: number) {
  const video = videoRef.current
  if (!video) return
  video.currentTime = clamp(video.currentTime + delta, 0, duration || 0)
}

function onTimelineSeek(t: number) {
  if (!videoRef.current) return
  videoRef.current.currentTime = clamp(t, 0, duration)
}

// Click on overlay: select existing triangle if clicked, or add new triangle if clicking empty area
function onOverlayClick(e: React.MouseEvent) {
  if (!overlayLayerRef.current) return
  if (suppressClickRef.current) {
    suppressClickRef.current = false
    return
  }
  const rect = overlayLayerRef.current.getBoundingClientRect()
  const x = (e.clientX - rect.left) / rect.width
  const y = (e.clientY - rect.top) / rect.height

  // First, check if we clicked on an existing triangle
  const clickedTriangle = findTriangleAtPosition(x, y, currentTime, annotations, videoSize.width, videoSize.height)
  
  if (clickedTriangle) {
    // Clicked on an existing triangle - select it
    setSelectedId(clickedTriangle.id)
  } else {
    // Clicked on empty area - create new triangle
    addAnnotationAt(x, y)
  }
}

function addAnnotationAt(xNorm: number, yNorm: number) {
  const start = currentTime
  const end = clamp(currentTime + defaultAnnoDuration, 0, duration || currentTime + defaultAnnoDuration)

  const defaultSize = 0.03
  const defaultColor = "#c0c5ce"
  const defaultStrokeWidth = 5
  
  const x = clamp(xNorm, 0, 1)
  const y = clamp(yNorm, 0, 1)
  
  // Check if a triangle already exists at this position/color combination
  const triangleId = `${Math.round(x * 100)}_${Math.round(y * 100)}_${defaultColor}`
  const existingTriangle = annotations.find(a => {
    const existingTriangleId = `${Math.round(a.x * 100)}_${Math.round(a.y * 100)}_${a.color}`
    return existingTriangleId === triangleId
  })
  
  if (existingTriangle) {
    // Triangle already exists at this position - select it instead of creating a new one
    setSelectedId(existingTriangle.id)
    toast({
      title: "Triangle already exists",
      description: "A triangle already exists at this position. Selected existing triangle.",
      variant: "default"
    })
    return
  }
  
  const anno: TriangleAnnotation = {
    id: getUUID(),
    x,
    y,
    size: defaultSize,                 
    color: defaultColor,           // gray default
    strokeWidth: defaultStrokeWidth,             
    start,
    end,
  }
  setAnnotations((prev) => [...prev, anno])
  setSelectedId(anno.id)
}

function removeSelected() {
  if (!selectedId) return
  setAnnotations((prev) => prev.filter((a) => a.id !== selectedId))
  setSelectedId(null)
}

// Dragging triangle position on the video for active ones
function onAnnoPointerDown(id: string, e: React.PointerEvent) {
  e.preventDefault()
  e.stopPropagation()
  ;(e.target as Element).setPointerCapture(e.pointerId)
  setSelectedId(id)
  setDraggingAnnoId(id)
  suppressClickRef.current = true
}
function onAnnoPointerMove(e: React.PointerEvent) {
  if (!draggingAnnoId || !overlayLayerRef.current) return
  const rect = overlayLayerRef.current.getBoundingClientRect()
  const x = (e.clientX - rect.left) / rect.width
  const y = (e.clientY - rect.top) / rect.height
  setAnnotations((prev) =>
    prev.map((a) => (a.id === draggingAnnoId ? { ...a, x: clamp(x, 0, 1), y: clamp(y, 0, 1) } : a))
  )
}
function onAnnoPointerUp(e?: React.PointerEvent) {
  if (e) e.stopPropagation()
  setDraggingAnnoId(null)
  setTimeout(() => {
    suppressClickRef.current = false
  }, 0)
}

function updateAnnoTime(id: string, next: { start?: number; end?: number }) {
  setAnnotations((prev) =>
    prev.map((a) => (a.id === id ? { ...a, start: next.start ?? a.start, end: next.end ?? a.end } : a))
  )
}

function updateSelectedSpatial(partial: Partial<Pick<TriangleAnnotation, "size" | "color">>) {
  if (!selectedId) return
  setAnnotations((prev) => prev.map((a) => (a.id === selectedId ? { ...a, ...partial } : a)))
}

async function sampleSelection() {
  if (!videoRef.current || !videoSize.width || !duration) {
    toast({ title: "No video loaded", description: "Load a video before sampling.", variant: "destructive" })
    return
  }
  if (!selection || selection.end <= selection.start) {
    toast({ title: "No selection", description: "Use Select export region to choose a time range.", variant: "destructive" })
    return
  }

  const video = videoRef.current
  const start = clamp(selection.start, 0, duration)
  const end = clamp(selection.end, 0, duration)
  const hz = Math.max(0.1, samplingHz)
  const step = 1 / hz
  const times: number[] = []
  let t = start
  while (t <= end + 1e-6) {
    times.push(Math.min(t, end))
    t += step
  }

  setSampling(true)
  setProgress(0)
  setFrames((prev) => {
    prev.forEach((f) => URL.revokeObjectURL(f.objectUrl))
    return []
  })

  const previousRate = video.playbackRate
  const wasPlaying = !video.paused
  video.pause()
  video.playbackRate = 1

  const canvas = document.createElement("canvas")
  canvas.width = video.videoWidth || 1280
  canvas.height = video.videoHeight || 720
  const ctx = canvas.getContext("2d", { willReadFrequently: false })
  if (!ctx) {
    toast({ title: "Canvas error", description: "Cannot create drawing context.", variant: "destructive" })
    setSampling(false)
    return
  }

  const newFrames: FrameInfo[] = []

  for (let i = 0; i < times.length; i++) {
    const targetTime = times[i]
    await new Promise<void>((resolve, reject) => {
      const onSeeked = () => {
        video.removeEventListener("seeked", onSeeked)
        resolve()
      }
      const onError = (ev: Event) => {
        video.removeEventListener("seeked", onSeeked)
        reject(ev)
      }
      video.addEventListener("seeked", onSeeked, { once: true })
      video.addEventListener("error", onError, { once: true })
      try {
        video.currentTime = targetTime
      } catch (e) {
        reject(e as any)
      }
    }).catch((e) => {
      console.error("Seek error:", e)
    })
    await new Promise((r) => requestAnimationFrame(() => r(null)))
    ctx.drawImage(video, 0, 0, canvas.width, canvas.height)
    if (burnInAnnotation && overlayEnabled) {
      const active = annotations.filter((a) => targetTime >= a.start && targetTime <= a.end)
      for (const anno of active) {
        drawTriangleOnContext(ctx, canvas.width, canvas.height, anno)
      }
    }
    const blob: Blob = await new Promise((resolve) => canvas.toBlob((b) => resolve(b as Blob), "image/jpeg", 0.92))
    const objectUrl = URL.createObjectURL(blob)
    newFrames.push({ index: i, time: targetTime, blob, objectUrl })
    setProgress(Math.round(((i + 1) / times.length) * 100))
    await new Promise((r) => setTimeout(r, 0))
  }

  setFrames(newFrames)
  setSampling(false)
  video.playbackRate = previousRate
  if (wasPlaying) {
    try {
      await video.play()
      setIsPlaying(true)
    } catch {
      setIsPlaying(false)
    }
  }

  toast({
    title: "Sampling complete",
    description: `${newFrames.length} frame${newFrames.length === 1 ? "" : "s"} captured at ${hz.toFixed(
      2
    )} Hz. Sequence: sequence_${sequenceId}`,
  })
}

function drawTriangleOnContext(
  ctx: CanvasRenderingContext2D,
  width: number,
  height: number,
  tri: Pick<TriangleAnnotation, "x" | "y" | "size" | "strokeWidth" | "color">
) {
  // Convert normalized coordinates to canvas coordinates
  const centerX = tri.x * width
  const centerY = tri.y * height
  
  // Calculate equilateral triangle size in pixels (use smaller dimension for consistent sizing)
  // This ensures the triangle maintains its equilateral shape regardless of canvas aspect ratio
  const minDim = Math.min(width, height)
  const sideLength = tri.size * minDim
  
  // Calculate equilateral triangle vertices
  const triangleHeight = sideLength * Math.sqrt(3) / 2
  const halfBase = sideLength / 2
  const centroidOffset = triangleHeight / 3
  
  // Triangle vertices in canvas coordinates
  const p1 = { x: centerX, y: centerY - (triangleHeight - centroidOffset) } // Top vertex
  const p2 = { x: centerX - halfBase, y: centerY + centroidOffset } // Bottom left
  const p3 = { x: centerX + halfBase, y: centerY + centroidOffset } // Bottom right

  ctx.save()
  ctx.lineWidth = Math.max(1, (tri.strokeWidth * minDim) / 1080)
  ctx.strokeStyle = tri.color
  ctx.fillStyle = "rgba(0,0,0,0)"
  ctx.beginPath()
  ctx.moveTo(p1.x, p1.y)
  ctx.lineTo(p2.x, p2.y)
  ctx.lineTo(p3.x, p3.y)
  ctx.closePath()
  ctx.stroke()
  ctx.restore()
}

async function downloadZip() {
  if (frames.length === 0) {
    toast({ title: "No frames", description: "Sample an export region first.", variant: "destructive" })
    return
  }
  const zip = new JSZip()
  const seqTag = `sequence_${sequenceId}`
  const folder = zip.folder(seqTag)!
  for (const f of frames) {
    const filename = `${seqTag}_${String(f.index).padStart(4, "0")}_${f.time.toFixed(3)}s.jpg`
    folder.file(filename, f.blob)
  }
  const metadata = {
    sequence_tag: seqTag,
    source_video: videoName,
    selection,
    sampling_hz: samplingHz,
    frames: frames.map((f) => ({ index: f.index, time: f.time })),
    annotations: annotations.map((a) => ({
      id: a.id,
      type: "triangle",
      start: a.start,
      end: a.end,
      normalized_apex: { x: a.x, y: a.y },
      normalized_size: a.size,
      color: a.color,
      stroke_width_ref_px: a.strokeWidth,
      applied_to_frames: burnInAnnotation,
    })),
    note: "Intended for Viam Data upload (images only).",
  }
  folder.file(`${seqTag}_metadata.json`, JSON.stringify(metadata, null, 2))
  const content = await zip.generateAsync({ type: "blob" })
  const url = URL.createObjectURL(content)
  const a = document.createElement("a")
  a.href = url
  a.download = `${seqTag}.zip`
  document.body.appendChild(a)
  a.click()
  a.remove()
  URL.revokeObjectURL(url)
}

function clearFrames() {
  frames.forEach((f) => URL.revokeObjectURL(f.objectUrl))
  setFrames([])
}

function resetAll() {
  clearFrames()
  if (videoUrl) URL.revokeObjectURL(videoUrl)
  setVideoUrl(null)
  setVideoName("")
  setDuration(0)
  setVideoSize({ width: 0, height: 0 })
  setAnnotations([])
  setSelectedId(null)
  setSelection(null)
  setSelectMode(false)
  setCurrentTime(0)
  setIsPlaying(false)
  setSequenceId(getUUID())
}

const canUpload =
  frames.length > 0 &&
  !!viamApiKey.trim() &&
  !!viamApiKeyId.trim() &&
  !!viamDatasetId.trim() &&
  !!partId.trim() &&
  !uploading &&
  !sampling

async function uploadToViam() {
  if (frames.length === 0) {
    toast({ title: "No frames", description: "Sample frames before uploading.", variant: "destructive" })
    return
  }
  if (!viamApiKey || !viamApiKeyId || !viamDatasetId) {
    toast({ title: "Missing credentials", description: "Provide API Key, Key ID, and Dataset ID.", variant: "destructive" })
    return
  }

  if (!partId.trim()) {
    toast({ title: "Missing Part ID", description: "Provide a Part ID to identify the uploader source.", variant: "destructive" })
    setUploading(false)
    return
  }

  setUploading(true)
  setUploadProgress(0)

  console.groupCollapsed("Viam Upload")
  const seqTag = `sequence_${sequenceId}`
  const extraTags = viamTags
    .split(",")
    .map((t) => t.trim())
    .filter(Boolean)
  const tags = Array.from(new Set([seqTag, ...extraTags]))
  console.log("Tags to apply:", tags)
  console.log("Environment info:", {
    userAgent: typeof navigator !== "undefined" ? navigator.userAgent : "n/a",
    framesCount: frames.length,
    seqTag,
    datasetId: viamDatasetId,
    partId,
    apiKeyId_preview: viamApiKeyId ? `${viamApiKeyId.slice(0, 4)}...${viamApiKeyId.slice(-4)}` : "(empty)",
    apiKey_present: !!viamApiKey,
  })

  let client: ViamClient | null = null
  try {
    console.time("viam_client_connect")
    client = await createViamClient({
      credentials: {
        type: "api-key",
        authEntity: viamApiKeyId,
        payload: viamApiKey,
      },
    })
    console.timeEnd("viam_client_connect")
    console.log("ViamClient connected.")
  } catch (err) {
    console.timeEnd("viam_client_connect")
    console.error("Viam client connect error:", err)
    console.groupEnd()
    setUploading(false)
    toast({ title: "Failed to connect to Viam", description: "Check API Key ID/Key and try again.", variant: "destructive" })
    return
  }

  const dataClient = (client as any).dataClient
  console.log("Data client available?", !!dataClient)
  if (!dataClient) {
    setUploading(false)
    try { (client as any).disconnect?.() } catch {}
    toast({ title: "No Data Client", description: "Viam Data client unavailable.", variant: "destructive" })
    console.groupEnd()
    return
  }

  const binaryIds: string[] = []

  console.time("viam_total_upload")
  console.log("Starting frame uploads...")

  try {
    for (let i = 0; i < frames.length; i++) {
      const f = frames[i]
      console.time(`upload_frame_${i}`)
      console.log(`Uploading frame ${i + 1}/${frames.length}`, { timeS: f.time.toFixed(3), sizeBytes: f.blob.size })
      const ab = await f.blob.arrayBuffer()
      const bytes = new Uint8Array(ab)
      const requestTime = new Date()
      const receiveTime = new Date()

      const id: string = await dataClient.binaryDataCaptureUpload(
        bytes,
        partId.trim(),
        "rdk:component:camera",
        "video-sampler",
        "ReadImage",
        ".jpg",
        [requestTime, receiveTime],
        tags
      )
      binaryIds.push(id)
      console.timeEnd(`upload_frame_${i}`)

      setUploadProgress(Math.round(((i + 1) / frames.length) * 100))
      await new Promise((r) => setTimeout(r, 0))
    }

    // Add to dataset in chunks
    const datasetId = viamDatasetId.trim()
    const chunkSize = 50
    console.log("All frames uploaded, associating with dataset...", { count: binaryIds.length, dataset: datasetId })
    console.time("viam_add_to_dataset")
    for (let i = 0; i < binaryIds.length; i += chunkSize) {
      const chunk = binaryIds.slice(i, i + chunkSize)
      console.log(`Adding ${chunk.length} ids to dataset [${i}-${i + chunk.length - 1}]`)
      await dataClient.addBinaryDataToDatasetByIds(chunk, datasetId)
    }
    console.timeEnd("viam_add_to_dataset")

    toast({
      title: "Upload complete",
      description: `${binaryIds.length} image${binaryIds.length === 1 ? "" : "s"} uploaded to dataset ${viamDatasetId} with tag ${seqTag}.`,
    })
  } catch (err) {
    console.error("Viam upload error:", err)
    toast({
      title: "Upload failed",
      description: "Check network and credentials. Some images may not have been uploaded.",
      variant: "destructive",
    })
  } finally {
    console.timeEnd("viam_total_upload")
    try {
      ;(client as any).disconnect?.()
      console.log("ViamClient disconnected.")
    } catch (e) {
      console.warn("Error disconnecting ViamClient:", e)
    }
    console.groupEnd()
    setUploading(false)
  }
}

const activeAnnotations = overlayEnabled
  ? annotations.filter((a) => currentTime >= a.start && currentTime <= a.end)
  : []

return (
  <div className="grid grid-cols-1 gap-6">
    <div className="lg:col-span-3 space-y-4">
      <Card className="rounded-none">
        <CardHeader>
          <CardTitle>Video</CardTitle>
          <CardDescription>Load a video, control playback, add time-ranged triangle annotations, and select an export region to sample as image frames.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          {/* File + reset */}
          <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
            <div className="flex items-center gap-2">
              <Label htmlFor="video-file" className="whitespace-nowrap">
                Video file
              </Label>
              <Input
                id="video-file"
                type="file"
                className="rounded-none"
                accept="video/mp4,video/quicktime,video/*"
                onChange={(e) => {
                  const file = e.target.files?.[0]
                  if (file) onSelectFile(file)
                }}
              />
            </div>
            {videoName && (
              <div className="text-xs text-neutral-500">
                {`Loaded: ${videoName}`}
              </div>
            )}
            <div className="flex-1" />
            <Button variant="ghost" size="sm" className="bg-gray-100 hover:bg-gray-200" onClick={resetAll}>
              <Trash2 className="h-4 w-4 mr-2" />
              Reset Video
            </Button>
          </div>

          {/* Video + overlay */}
          <div className="mx-auto w-full max-w-4xl">
            <div className="relative w-full overflow-hidden rounded-md bg-black">
              <div className="relative w-full" style={{ paddingTop: videoSize.width ? `${(videoSize.height / videoSize.width) * 100}%` : "56.25%" }}>
                <video
                  ref={videoRef}
                  className="absolute inset-0 h-full w-full object-contain bg-black"
                  crossOrigin="anonymous"
                  src={videoUrl ?? undefined}
                  preload="metadata"
                  playsInline
                  controls={false}
                />
                <div
                  className="absolute inset-0"
                  ref={overlayLayerRef}
                  onClick={onOverlayClick}
                  aria-label="Annotation overlay"
                  role="presentation"
                >
                  {overlayEnabled ? (
                    <svg
                      className="absolute inset-0 h-full w-full"
                      onPointerMove={onAnnoPointerMove}
                      onPointerUp={onAnnoPointerUp}
                      onPointerCancel={onAnnoPointerUp}
                      viewBox={`0 0 ${videoSize.width} ${videoSize.height}`}
                      preserveAspectRatio="xMidYMid meet"
                    >
                      {activeAnnotations.map((a) => {
                        // Convert normalized coordinates to video pixel coordinates
                        const centerX = a.x * videoSize.width
                        const centerY = a.y * videoSize.height
                        
                        // Calculate equilateral triangle size in pixels (use smaller dimension for consistent sizing)
                        const minDim = Math.min(videoSize.width, videoSize.height)
                        const sideLength = a.size * minDim
                        
                        // Calculate equilateral triangle vertices
                        const triangleHeight = sideLength * Math.sqrt(3) / 2
                        const halfBase = sideLength / 2
                        const centroidOffset = triangleHeight / 3
                        
                        // Triangle vertices in video pixel coordinates
                        const p1X = centerX
                        const p1Y = centerY - (triangleHeight - centroidOffset) // Top vertex
                        const p2X = centerX - halfBase
                        const p2Y = centerY + centroidOffset // Bottom left
                        const p3X = centerX + halfBase
                        const p3Y = centerY + centroidOffset // Bottom right
                        
                        const p1 = `${p1X},${p1Y}`
                        const p2 = `${p2X},${p2Y}`
                        const p3 = `${p3X},${p3Y}`
                        return (
                          <polygon
                            key={a.id}
                            points={`${p1} ${p2} ${p3}`}
                            fill="none"
                            stroke={a.color}
                            strokeWidth={3}
                            vectorEffect="non-scaling-stroke"
                            aria-label={`Triangle annotation ${a.id}`}
                            onPointerDown={(e) => onAnnoPointerDown(a.id, e)}
                            onClick={(e) => e.stopPropagation()}
                            style={{ cursor: selectedId === a.id ? "grabbing" : "grab" }}
                          />
                        )
                      })}
                    </svg>
                  ) : null}
                </div>
              </div>
            </div>
          </div>

          {/* Transport */}
          <div className="flex flex-wrap items-center gap-2">
            <Button onClick={() => seekBy(-5)} variant="outline" size="sm">
              {"-5s"}
            </Button>
            <Button onClick={togglePlay} size="sm" className="min-w-24">
              {isPlaying ? <><Pause className="h-4 w-4 mr-2" />{"Pause"}</> : <><Play className="h-4 w-4 mr-2" />{"Play"}</>}
            </Button>
            <Button onClick={() => seekBy(5)} variant="outline" size="sm">
              {"+5s"}
            </Button>

            <Separator orientation="vertical" className="h-6 mx-2" />

            <div className="flex items-center gap-2">
              <Label className="text-xs">Speed</Label>
              <div className="flex gap-1">
                {[0.5, 1, 2, 4].map((r) => (
                  <Button key={r} size="sm" variant={playbackRate === r ? "default" : "outline"} onClick={() => setPlaybackRate(r)}>
                    {`${r}x`}
                  </Button>
                ))}
              </div>
            </div>

            <Separator orientation="vertical" className="h-6 mx-2" />

            <div className="flex items-center gap-2">
              <Clock className="h-4 w-4 text-neutral-500" />
              <span className="text-sm tabular-nums">{formatTime(currentTime)}</span>
              <span className="text-neutral-400">/</span>
              <span className="text-xs text-neutral-500">{formatTime(duration)}</span>
            </div>

            <div className="flex-1" />

            {/* Export region control row */}
            <div className="flex flex-wrap items-center gap-2">
              <Button
                size="sm"
                variant={selectMode ? "default" : "outline"}
                onClick={() => setSelectMode((v) => !v)}
                aria-pressed={selectMode}
              >
                <Selection className="h-4 w-4 mr-2" />
                {selectMode ? "Selecting…" : "Select export region"}
              </Button>

              {/* When a selection exists, expose sampling controls inline here */}
              {selection ? (
                <>
                  <Button size="sm" onClick={sampleSelection} disabled={sampling}>
                    <Scissors className="h-4 w-4 mr-2" />
                    {sampling ? "Sampling..." : "Sample export region to images"}
                  </Button>
                  <div className="flex items-center gap-2">
                    <Label className="text-xs">Hz</Label>
                    <Input
                      type="number"
                      min={0.1}
                      step={0.1}
                      className="w-24 h-8 rounded-none"
                      value={samplingHz}
                      onChange={(e) => setSamplingHz(Math.max(0.1, Number(e.target.value || 1)))}
                    />
                  </div>
                  <div className="text-xs text-neutral-500">
                    {formatTime(selection.start)} → {formatTime(selection.end)}
                  </div>
                </>
              ) : null}
            </div>
          </div>

          {/* Sampling progress (inline) */}
          {sampling ? (
            <div className="space-y-2">
              <Progress value={progress} />
              <div className="text-xs text-neutral-500">{progress}%</div>
            </div>
          ) : null}

          {/* Timeline with selection + triangle track */}
          <AnnotationTimeline
            duration={duration}
            currentTime={currentTime}
            onSeek={onTimelineSeek}
            triangleTracks={createTriangleTracks(annotations)}
            selectedId={selectedId}
            onSelect={setSelectedId}
            onChangeTime={updateAnnoTime}
            selection={selection}
            onSelectionChange={setSelection}
            selectMode={selectMode}
            className="mt-1"
          />

          {/* Annotation controls */}
          <div className="rounded-md border p-3 space-y-2">
            <div className="flex items-center justify-between">
              <div className="font-medium text-sm">Annotations</div>
              <div className="flex items-center gap-2">
                <Label htmlFor="overlay-enabled" className="text-xs">
                  Show triangles
                </Label>
                <Switch id="overlay-enabled" checked={overlayEnabled} onCheckedChange={setOverlayEnabled} />
              </div>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <Button size="sm" variant="outline" onClick={() => addAnnotationAt(0.5, 0.2)}>
                Add Triangle (at playhead)
              </Button>
              <Button size="sm" variant="ghost" onClick={removeSelected} disabled={!selectedId}>
                <Trash2 className="h-4 w-4 mr-2" />
                Remove selected
              </Button>

              {selectedId ? (
                <>
                  <div className="flex items-center gap-2">
                    <Label className="text-xs">Size</Label>
                    <Slider
                      value={[Math.round((annotations.find((a) => a.id === selectedId)?.size || 0.06) * 100)]}
                      onValueChange={([v]) => updateSelectedSpatial({ size: clamp(v / 100, 0.02, 0.3) })}
                      min={2}
                      max={30}
                      step={1}
                      className="w-40"
                    />
                  </div>
                  <div className="flex items-center gap-2">
                    <Label className="text-xs">Color</Label>
                    <div className="flex gap-1">
                      {[
                        { c: "#c0c5ce", label: "Gray" },
                        { c: "#f97316", label: "Orange" },
                        { c: "#10b981", label: "Green" },
                        { c: "#ef4444", label: "Red" },
                        { c: "#a855f7", label: "Purple" },
                        { c: "#111827", label: "Black" },
                      ].map((opt) => (
                        <button
                          key={opt.c}
                          aria-label={opt.label}
                          title={opt.label}
                          onClick={() => updateSelectedSpatial({ color: opt.c })}
                          className={cn(
                            "h-6 w-6 border", // square swatches
                            annotations.find((a) => a.id === selectedId)?.color === opt.c ? "ring-2 ring-offset-1" : ""
                          )}
                          style={{ backgroundColor: opt.c }}
                        />
                      ))}
                    </div>
                  </div>
                </>
              ) : (
                <p className="text-xs text-neutral-500">
                  Tip: Click a triangle to select and drag it. Click elsewhere to move the selected triangle.
                  Hold Shift and click to add a new triangle.
                </p>
              )}
            </div>
          </div>
        </CardContent>
      </Card>

      {/* Frames & Upload */}
      <Card className="rounded-none">
        <CardHeader>
          <CardTitle>Frames & Export</CardTitle>
          <CardDescription>Preview sampled frames, download ZIP, and upload to a Viam dataset.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          {/* Preview */}
          {frames.length === 0 ? (
            <p className="text-sm text-neutral-500">No frames yet. Select an export region and sample to see images here.</p>
          ) : (
            <div className="grid grid-cols-2 md:grid-cols-4 lg:grid-cols-5 gap-3">
              {frames.map((f) => (
                <figure
                  key={f.index}
                  className="rounded-md overflow-hidden border bg-white cursor-zoom-in"
                  onClick={() => { setPreviewIndex(f.index); setPreviewOpen(true); }}
                >
                  <img
                    src={f.objectUrl || "/placeholder.svg?height=96&width=160&query=frame%20thumbnail"}
                    alt={`Frame ${f.index} at ${f.time.toFixed(2)}s`}
                    className="w-full h-24 object-cover"
                  />
                  <figcaption className="p-2 text-[11px] text-neutral-600 flex items-center justify-between">
                    <span className="font-mono">#{f.index}</span>
                    <span>{formatTime(f.time)}</span>
                  </figcaption>
                </figure>
              ))}
            </div>
          )}

          {/* Export actions */}
          <div className="flex flex-wrap items-center gap-2">
            <Button size="sm" onClick={downloadZip} disabled={frames.length === 0}>
              <Download className="h-4 w-4 mr-2" />
              Download ZIP
            </Button>
            <Button size="sm" variant="outline" onClick={clearFrames} disabled={frames.length === 0}>
              <Trash2 className="h-4 w-4 mr-2" />
              Clear frames
            </Button>
          </div>

          {/* Upload panel */}
          <div className="rounded-none border p-3 space-y-3">
            <div className="grid grid-cols-1 sm:grid-cols-5 gap-3">
              <div className="space-y-1 sm:col-span-2">
                <Label htmlFor="dataset">Viam Dataset ID</Label>
                <Input
                  id="dataset"
                  placeholder="Dataset ID"
                  value={viamDatasetId}
                  onChange={(e) => setViamDatasetId(e.target.value)}
                  className="rounded-none"
                />
              </div>
              <div className="space-y-1">
                <Label htmlFor="apikey-id">API Key ID</Label>
                <Input
                  id="apikey-id"
                  placeholder="Key ID"
                  value={viamApiKeyId}
                  onChange={(e) => setViamApiKeyId(e.target.value)}
                  className="rounded-none"
                />
              </div>
              <div className="space-y-1">
                <Label htmlFor="apikey">API Key</Label>
                <Input
                  id="apikey"
                  placeholder="API Key"
                  type="password"
                  value={viamApiKey}
                  onChange={(e) => setViamApiKey(e.target.value)}
                  className="rounded-none"
                />
              </div>
              <div className="space-y-1">
                <Label htmlFor="partid">Part ID</Label>
                <Input
                  id="partid"
                  placeholder="Part ID"
                  value={partId}
                  onChange={(e) => setPartId(e.target.value)}
                  className="rounded-none"
                />
              </div>
              <div className="space-y-1 sm:col-span-2">
                <Label htmlFor="viam-tags">Additional tags (comma-separated)</Label>
                <Input
                  id="viam-tags"
                  placeholder="e.g., project-x, triangle, v1"
                  value={viamTags}
                  onChange={(e) => setViamTags(e.target.value)}
                  className="rounded-none"
                />
              </div>
            </div>
            <div className="flex items-center gap-2">
              <Button size="sm" onClick={uploadToViam} disabled={!canUpload}>
                <Upload className="h-4 w-4 mr-2" />
                {uploading ? "Uploading..." : "Upload to Viam"}
              </Button>
              <div className="text-xs text-neutral-500">
                {`Will tag each image with 'sequence_${sequenceId}' (randomly generated UUID) plus any tags you enter.`}
              </div>
            </div>
            {uploading ? (
              <div className="space-y-2">
                <Progress value={uploadProgress} />
                <div className="text-xs text-neutral-500">{uploadProgress}%</div>
              </div>
            ) : null}
          </div>

          {/* Preview modal */}
          <Dialog open={previewOpen} onOpenChange={setPreviewOpen}>
            <DialogContent className="max-w-5xl">
              <DialogHeader>
                <DialogTitle>Frame {previewIndex} • {frames[previewIndex]?.time !== undefined ? `${frames[previewIndex].time.toFixed(2)}s` : ""}</DialogTitle>
                <DialogDescription>{videoName} — {frames.length} frames • {`sequence_${sequenceId}`}</DialogDescription>
              </DialogHeader>
              <div className="flex items-center justify-center">
                {frames.length > 0 && (
                  <img
                    src={frames[previewIndex]?.objectUrl || "/placeholder.svg?height=480&width=854&query=preview%20frame"}
                    alt={`Preview frame #${previewIndex}`}
                    className="max-h-[75vh] w-auto rounded-md"
                  />
                )}
              </div>
              <div className="flex items-center justify-between pt-2">
                <Button
                  variant="outline"
                  onClick={() => setPreviewIndex((i) => (i - 1 + frames.length) % frames.length)}
                  disabled={frames.length === 0}
                >
                  Prev
                </Button>
                <div className="text-xs text-neutral-500">
                  {frames.length > 0 ? `${previewIndex + 1} / ${frames.length}` : "No frames"}
                </div>
                <Button
                  variant="outline"
                  onClick={() => setPreviewIndex((i) => (i + 1) % frames.length)}
                  disabled={frames.length === 0}
                >
                  Next
                </Button>
              </div>
            </DialogContent>
          </Dialog>
        </CardContent>
      </Card>
    </div>
  </div>
)
}
