'use client'

import { useEffect, useState, ReactNode } from 'react'

export function TVScaleWrapper({ children }: { children: ReactNode }) {
  const [scale, setScale] = useState(1)

  useEffect(() => {
    function update() {
      setScale(Math.min(window.innerWidth / 1920, window.innerHeight / 1080))
    }
    update()
    window.addEventListener('resize', update)
    return () => window.removeEventListener('resize', update)
  }, [])

  return (
    <div style={{ position: 'fixed', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', background: '#000', overflow: 'hidden' }}>
      <div style={{ width: '1920px', height: '1080px', transform: `scale(${scale})`, transformOrigin: 'center center', overflow: 'hidden' }}>
        {children}
      </div>
    </div>
  )
}
