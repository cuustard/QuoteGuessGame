'use client'

import { useEffect, useState } from 'react'
import QRCode from 'qrcode'

export function JoinQR({ roomCode }: { roomCode: string }) {
  const [dataUrl, setDataUrl] = useState('')
  useEffect(() => {
    const origin = typeof window !== 'undefined' ? window.location.origin : ''
    const url = `${origin}/?room=${roomCode}`
    QRCode.toDataURL(url, { width: 200, margin: 1, color: { dark: '#1a1a2e', light: '#ffffff' } })
      .then(setDataUrl).catch(() => {})
  }, [roomCode])
  if (!dataUrl) return null
  // eslint-disable-next-line @next/next/no-img-element
  return <img src={dataUrl} alt="Join QR code" width={180} height={180} className="rounded-xl" />
}
