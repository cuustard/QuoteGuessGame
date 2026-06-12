import type { Viewport } from 'next'
import type { ReactNode } from 'react'

export const viewport: Viewport = {
  initialScale: 1,
  maximumScale: 1,
  userScalable: false,
}

export default function HostLayout({ children }: { children: ReactNode }) {
  return <>{children}</>
}
