"use client"

import { VideoEditor } from "@/components/video-editor"


export default function Page() {
  return (
    <main className="min-h-dvh bg-neutral-50">
      <div className="mx-auto max-w-7xl px-4 py-6 sm:px-6 lg:px-8">
        <VideoEditor />
      </div>
    </main>
  )
}
