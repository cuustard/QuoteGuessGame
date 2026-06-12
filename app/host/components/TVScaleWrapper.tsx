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
    <div className="fixed inset-0 bg-black overflow-hidden">
      <div
        style={{
          position: 'absolute',
          left: '50%',
          top: '50%',
          width: '1920px',
          height: '1080px',
          transform: `translate(-50%, -50%) scale(${scale})`,
          transformOrigin: 'center center',
        }}
      >
        {children}
      </div>
    </div>
  )
}
