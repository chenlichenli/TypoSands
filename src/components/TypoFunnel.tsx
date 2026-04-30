import { useCallback, useEffect, useRef, useState } from 'react'
import Matter from 'matter-js'
import { motion } from 'framer-motion'
import './TypoFunnel.css'

const { Engine, World, Bodies, Body, Composite, Runner, Mouse, MouseConstraint, Events } =
  Matter

/** Presets: `stack` is the full canvas `fontFamily` suffix (after size). */
const LETTER_FONT_OPTIONS = [
  {
    id: 'dmSans',
    label: 'DM Sans',
    stack: '"DM Sans", system-ui, -apple-system, sans-serif',
  },
  {
    id: 'inter',
    label: 'Inter',
    stack: 'Inter, system-ui, -apple-system, sans-serif',
  },
  {
    id: 'jetbrainsMono',
    label: 'JetBrains Mono',
    stack: '"JetBrains Mono", ui-monospace, monospace',
  },
  {
    id: 'system',
    label: 'System UI',
    stack: 'system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif',
  },
  {
    id: 'serif',
    label: 'Serif',
    stack: 'Georgia, "Times New Roman", Times, serif',
  },
  {
    id: 'mono',
    label: 'System monospace',
    stack: 'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace',
  },
] as const

const DEFAULT_LETTER_FONT_ID = LETTER_FONT_OPTIONS[0].id

function letterFontStackForId(id: string): string {
  const found = LETTER_FONT_OPTIONS.find((o) => o.id === id)
  return found?.stack ?? LETTER_FONT_OPTIONS[0].stack
}

const LETTER_SIZE_OPTIONS = [
  { id: 'xs', label: 'Extra small', scale: 0.55 },
  { id: 'sm', label: 'Small', scale: 0.75 },
  { id: 'md', label: 'Medium', scale: 1 },
  { id: 'lg', label: 'Large', scale: 1.3 },
  { id: 'xl', label: 'Extra large', scale: 1.65 },
  { id: 'xxl', label: 'Huge', scale: 2.1 },
] as const

const DEFAULT_LETTER_SIZE_ID = LETTER_SIZE_OPTIONS[2].id

/** Typing bar grows with content up to this height, then scrolls. */
const TYPING_BAR_MIN_HEIGHT_PX = 44
const TYPING_BAR_MAX_HEIGHT_PX = 168

function letterScaleForSizeId(id: string): number {
  const found = LETTER_SIZE_OPTIONS.find((o) => o.id === id)
  return found?.scale ?? 1
}

/** Snapshot at drop time — each letter keeps its own so you can change controls between Enter presses. */
type LetterDropStyle = {
  fontScale: number
  color: string
  /** Full CSS `font-family` list for canvas (same string used in `ctx.font`). */
  fontStack: string
}

type CharBody = Matter.Body & { char: string; dropStyle?: LetterDropStyle }

const DEFAULT_DROP_STYLE: LetterDropStyle = {
  fontScale: 1,
  color: '#2d2640',
  fontStack: LETTER_FONT_OPTIONS[0].stack,
}

function letterBaseFontPx(w: number, h: number, dpr: number, scale: number): number {
  return Math.max(22 * dpr, Math.min(w, h) * 0.045 * dpr) * scale
}

const RESTITUTION = 0.45
const FRICTION = 0.52
const FRICTION_STATIC = 0.62
const FRICTION_AIR = 0.014
const DENSITY = 0.0014

function measureChar(
  ctx: CanvasRenderingContext2D,
  ch: string,
  fontPx: number,
  fontStack: string,
): { w: number; h: number } {
  ctx.font = `600 ${fontPx}px ${fontStack}`
  const m = ctx.measureText(ch)
  const w = Math.max(m.width, fontPx * 0.35)
  const h =
    fontPx *
    (m.actualBoundingBoxAscent + m.actualBoundingBoxDescent > 0
      ? (m.actualBoundingBoxAscent + m.actualBoundingBoxDescent) / fontPx
      : 1.1)
  return { w, h: Math.max(h, fontPx * 0.95) }
}

function funnelLayout(width: number, height: number) {
  const cx = width / 2
  const topY = height * 0.1
  const bottomY = height * 0.72
  const funnelH = bottomY - topY
  const topHalfW = Math.min(width * 0.38, height * 0.42)
  const bottomHalfW = Math.max(width * 0.055, 18)
  const wallThick = Math.max(14, Math.min(width, height) * 0.022)

  const leftTop = { x: cx - topHalfW, y: topY }
  const leftBot = { x: cx - bottomHalfW, y: bottomY }
  const rightTop = { x: cx + topHalfW, y: topY }
  const rightBot = { x: cx + bottomHalfW, y: bottomY }

  return {
    cx,
    topY,
    bottomY,
    funnelH,
    topHalfW,
    bottomHalfW,
    wallThick,
    leftTop,
    leftBot,
    rightTop,
    rightBot,
  }
}

function slantedWall(
  ax: number,
  ay: number,
  bx: number,
  by: number,
  thickness: number,
  opts: { isStatic: boolean; label?: string },
): Matter.Body {
  const dx = bx - ax
  const dy = by - ay
  const len = Math.hypot(dx, dy)
  const mx = (ax + bx) / 2
  const my = (ay + by) / 2
  const angle = Math.atan2(dy, dx)
  return Bodies.rectangle(mx, my, len, thickness, {
    isStatic: opts.isStatic,
    label: opts.label,
    angle,
    friction: FRICTION,
    frictionStatic: FRICTION_STATIC,
    restitution: 0.08,
  })
}

export function TypoFunnel() {
  const stageRef = useRef<HTMLDivElement>(null)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const engineRef = useRef<Matter.Engine | null>(null)
  const mouseRef = useRef<Matter.Mouse | null>(null)
  const staticIdsRef = useRef<Set<number>>(new Set())
  const sizeRef = useRef({ w: 0, h: 0, dpr: 1 })
  const [text, setText] = useState('')
  const [letterSizeId, setLetterSizeId] = useState<string>(DEFAULT_LETTER_SIZE_ID)
  const [letterColor, setLetterColor] = useState('#2d2640')
  const [letterFontId, setLetterFontId] = useState<string>(DEFAULT_LETTER_FONT_ID)
  const [canvasBackgroundColor, setCanvasBackgroundColor] = useState('#ffffff')
  const measureCtxRef = useRef<CanvasRenderingContext2D | null>(null)
  const typingInputRef = useRef<HTMLTextAreaElement>(null)

  const adjustTypingBarHeight = useCallback(() => {
    const el = typingInputRef.current
    if (!el) return
    el.style.height = 'auto'
    const sh = el.scrollHeight
    const bounded = Math.min(Math.max(sh, TYPING_BAR_MIN_HEIGHT_PX), TYPING_BAR_MAX_HEIGHT_PX)
    el.style.height = `${bounded}px`
    el.style.overflowY = sh > TYPING_BAR_MAX_HEIGHT_PX ? 'auto' : 'hidden'
  }, [])

  useEffect(() => {
    adjustTypingBarHeight()
  }, [text, adjustTypingBarHeight])

  useEffect(() => {
    const el = typingInputRef.current
    const bar = el?.parentElement
    if (!bar) return
    const ro = new ResizeObserver(() => adjustTypingBarHeight())
    ro.observe(bar)
    return () => ro.disconnect()
  }, [adjustTypingBarHeight])

  const canvasBgHex = /^#[0-9A-Fa-f]{6}$/i.test(canvasBackgroundColor)
    ? canvasBackgroundColor
    : '#ffffff'

  const spawnString = useCallback((raw: string, style: LetterDropStyle) => {
    const engine = engineRef.current
    const canvas = canvasRef.current
    if (!engine || !canvas) return

    const { w, h, dpr } = sizeRef.current
    const ctx =
      measureCtxRef.current ??
      canvas.getContext('2d', { alpha: true })!
    measureCtxRef.current = ctx

    const batchStyle: LetterDropStyle = {
      fontScale: style.fontScale,
      color: style.color,
      fontStack: style.fontStack,
    }

    const layout = funnelLayout(w, h)
    const baseFont = letterBaseFontPx(w, h, dpr, batchStyle.fontScale)

    const normalized = raw.replace(/\r\n/g, '\n').replace(/\r/g, '\n')
    const lines = normalized.split('\n')

    for (const line of lines) {
      const lineChars = [...line]
      const approxHalfWidth = (lineChars.length * baseFont * 0.35) / 2
      let xCursor = layout.cx - approxHalfWidth

      for (let col = 0; col < lineChars.length; col++) {
        const ch = lineChars[col]
        const { w: cw, h: chh } = measureChar(ctx, ch, baseFont, batchStyle.fontStack)
        const spread = (Math.random() - 0.5) * baseFont * 0.35
        const x = xCursor + cw / 2 + spread
        const y = layout.topY - baseFont * (1.4 + col * 0.08 + Math.random() * 0.4)

        const body = Bodies.rectangle(x, y, cw * 1.02, chh * 1.02, {
          restitution: RESTITUTION,
          friction: FRICTION,
          frictionStatic: FRICTION_STATIC,
          frictionAir: FRICTION_AIR,
          density: DENSITY,
          chamfer: { radius: Math.min(4 * dpr, cw * 0.08) },
          label: 'letter',
        }) as CharBody

        body.char = ch
        body.dropStyle = batchStyle
        Body.setAngle(body, (Math.random() - 0.5) * 0.35)
        World.add(engine.world, body)
        xCursor += cw + baseFont * 0.06
      }
    }
  }, [])

  const restartLetters = useCallback(() => {
    const engine = engineRef.current
    if (!engine) return
    const letters = Composite.allBodies(engine.world).filter(
      (b) => !b.isStatic && b.label === 'letter',
    )
    for (const b of letters) Composite.remove(engine.world, b)
  }, [])

  useEffect(() => {
    const stage = stageRef.current
    const canvas = canvasRef.current
    if (!stage || !canvas) return
    const canvasEl = canvas
    const stageEl = stage

    const engine = Engine.create({ gravity: { x: 0, y: 1, scale: 0.00105 } })
    engineRef.current = engine

    const runner = Runner.create()
    Runner.run(runner, engine)

    let raf = 0
    const ctx = canvasEl.getContext('2d', { alpha: true })!
    measureCtxRef.current = ctx

    function buildStatics(w: number, h: number, dpr: number) {
      const prev = engine.world.bodies.filter((b) => staticIdsRef.current.has(b.id))
      for (const b of prev) Composite.remove(engine.world, b)
      staticIdsRef.current.clear()

      const L = funnelLayout(w, h)
      const thick = L.wallThick
      const groundH = Math.max(28 * dpr, h * 0.045)

      const ground = Bodies.rectangle(w / 2, h - groundH / 2, w + 4, groundH, {
        isStatic: true,
        friction: FRICTION,
        frictionStatic: FRICTION_STATIC,
        restitution: 0.12,
        label: 'ground',
      })

      const leftBarrier = Bodies.rectangle(
        -thick,
        h / 2,
        thick * 2,
        h * 2.5,
        { isStatic: true, friction: FRICTION, label: 'wall' },
      )
      const rightBarrier = Bodies.rectangle(
        w + thick,
        h / 2,
        thick * 2,
        h * 2.5,
        { isStatic: true, friction: FRICTION, label: 'wall' },
      )

      const leftFunnel = slantedWall(
        L.leftTop.x,
        L.leftTop.y,
        L.leftBot.x,
        L.leftBot.y,
        thick,
        { isStatic: true, label: 'funnel' },
      )
      const rightFunnel = slantedWall(
        L.rightTop.x,
        L.rightTop.y,
        L.rightBot.x,
        L.rightBot.y,
        thick,
        { isStatic: true, label: 'funnel' },
      )

      const lipW = (L.bottomHalfW + thick * 1.2) * 2
      const lip = Bodies.rectangle(L.cx, L.bottomY + thick * 0.55, lipW, thick, {
        isStatic: true,
        friction: FRICTION,
        label: 'funnelLip',
      })

      const statics = [ground, leftBarrier, rightBarrier, leftFunnel, rightFunnel, lip]
      for (const b of statics) staticIdsRef.current.add(b.id)
      World.add(engine.world, statics)
    }

    function resize() {
      const dpr = Math.min(window.devicePixelRatio || 1, 2.5)
      // Size the simulation to the *canvas* element, not the outer column — otherwise
      // the bitmap uses the full column height (incl. toolbar) while the canvas only
      // sits below the input, so bodies render off the visible bitmap / layout breaks.
      const rect = stageEl.getBoundingClientRect()
      const w = Math.max(320, Math.floor(rect.width * dpr))
      const h = Math.max(280, Math.floor(rect.height * dpr))

      const prev = sizeRef.current
      const scaleX = prev.w > 0 ? w / prev.w : 1
      const scaleY = prev.h > 0 ? h / prev.h : 1

      canvasEl.width = w
      canvasEl.height = h

      if (prev.w > 0 && prev.h > 0 && (scaleX !== 1 || scaleY !== 1)) {
        for (const b of engine.world.bodies) {
          if (staticIdsRef.current.has(b.id)) continue
          Body.setPosition(b, { x: b.position.x * scaleX, y: b.position.y * scaleY })
          Body.setVelocity(b, {
            x: b.velocity.x * scaleX,
            y: b.velocity.y * scaleY,
          })
        }
      }

      sizeRef.current = { w, h, dpr }
      buildStatics(w, h, dpr)
    }

    const ro = new ResizeObserver(() => {
      cancelAnimationFrame(raf)
      raf = requestAnimationFrame(resize)
    })
    ro.observe(stageEl)
    resize()
    requestAnimationFrame(() => resize())

    const mouse = Mouse.create(canvasEl)
    mouse.pixelRatio = Math.min(window.devicePixelRatio || 1, 2.5)
    mouseRef.current = mouse

    const mc = MouseConstraint.create(engine, {
      mouse,
      constraint: {
        stiffness: 0.22,
        damping: 0.08,
        render: { visible: false },
      },
    })
    World.add(engine.world, mc)

    const onMouseDown = () => {
      mouse.pixelRatio = Math.min(window.devicePixelRatio || 1, 2.5)
    }
    canvasEl.addEventListener('mousedown', onMouseDown)
    canvasEl.addEventListener('touchstart', onMouseDown, { passive: true })

    const darkMq = window.matchMedia('(prefers-color-scheme: dark)')

    const draw = () => {
      const { w, h, dpr } = sizeRef.current
      if (w < 1 || h < 1) return
      ctx.setTransform(1, 0, 0, 1, 0, 0)
      ctx.clearRect(0, 0, w, h)

      ctx.textAlign = 'center'
      ctx.textBaseline = 'middle'

      const dragged = mc.body as CharBody | null

      for (const b of engine.world.bodies) {
        if (staticIdsRef.current.has(b.id)) continue
        const cb = b as CharBody
        if (!cb.char) continue
        const st = cb.dropStyle ?? DEFAULT_DROP_STYLE
        const fontPx = letterBaseFontPx(w, h, dpr, st.fontScale)
        const letterFill =
          /^#[0-9A-Fa-f]{6}$/i.test(st.color) ? st.color : DEFAULT_DROP_STYLE.color
        const stack = st.fontStack || DEFAULT_DROP_STYLE.fontStack
        ctx.font = `600 ${fontPx}px ${stack}`
        ctx.save()
        ctx.translate(b.position.x, b.position.y)
        ctx.rotate(b.angle)
        if (dragged && dragged.id === b.id) {
          ctx.fillStyle = darkMq.matches
            ? 'rgba(216, 180, 254, 0.98)'
            : 'rgba(120, 53, 196, 0.95)'
        } else {
          ctx.fillStyle = letterFill
        }
        ctx.fillText(cb.char, 0, 0)
        ctx.restore()
      }
    }

    Events.on(engine, 'afterUpdate', draw)
    draw()

    return () => {
      cancelAnimationFrame(raf)
      ro.disconnect()
      canvasEl.removeEventListener('mousedown', onMouseDown)
      canvasEl.removeEventListener('touchstart', onMouseDown)
      Events.off(engine, 'afterUpdate', draw)
      World.clear(engine.world, false)
      Engine.clear(engine)
      Runner.stop(runner)
      engineRef.current = null
      mouseRef.current = null
      measureCtxRef.current = null
      staticIdsRef.current.clear()
    }
  }, [])

  const onTypingKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key !== 'Enter') return
    if (e.shiftKey) return
    e.preventDefault()
    const t = e.currentTarget.value.trim()
    if (!t) return
    spawnString(t, {
      fontScale: letterScaleForSizeId(letterSizeId),
      color: letterColor,
      fontStack: letterFontStackForId(letterFontId),
    })
    setText('')
  }

  const hasTyped = text.length > 0

  return (
    <motion.div
      className="typo-funnel"
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      transition={{ duration: 0.35, ease: [0.22, 1, 0.36, 1] }}
    >
      <aside className="typo-funnel__sidebar">
        <header className="typo-funnel__sidebar-head">
          <h1 className="typo-funnel__title">TypoSands</h1>
          <label className="typo-funnel__hint typo-funnel__hint--under-title" htmlFor="typo-input">
            Click and type, then press Enter. Drag the canvas to swish letters around.
          </label>
        </header>

        <div className="typo-funnel__sidebar-group">
          <div
            className={`typo-funnel__bar${hasTyped ? ' typo-funnel__bar--active' : ''}`}
          >
            <textarea
              ref={typingInputRef}
              id="typo-input"
              className="typo-funnel__input"
              value={text}
              onChange={(e) => setText(e.target.value)}
              onKeyDown={onTypingKeyDown}
              placeholder=""
              autoComplete="off"
              spellCheck={false}
              rows={1}
              aria-multiline="true"
            />
          </div>

          <h2 className="typo-funnel__customize-title" id="sidebar-customize">
            Customize
          </h2>
          <div
            className="typo-funnel__appearance"
            role="group"
            aria-labelledby="sidebar-customize"
          >
            <div className="typo-funnel__appearance-row typo-funnel__appearance-row--bg">
              <label className="typo-funnel__appearance-label" htmlFor="canvas-bg-color">
                Background
              </label>
              <input
                id="canvas-bg-color"
                className="typo-funnel__color-swatch"
                type="color"
                value={canvasBgHex}
                onChange={(e) => setCanvasBackgroundColor(e.target.value)}
                title="Canvas background"
              />
            </div>
            <p className="typo-funnel__hint typo-funnel__hint--after-bg">
              Background applies to the whole canvas; other customizations apply to the next line
              you drop.
            </p>
            <div className="typo-funnel__appearance-row">
              <label className="typo-funnel__appearance-label" htmlFor="letter-size">
                Font size
              </label>
              <select
                id="letter-size"
                className="typo-funnel__appearance-select"
                value={letterSizeId}
                onChange={(e) => setLetterSizeId(e.target.value)}
              >
                {LETTER_SIZE_OPTIONS.map((opt) => (
                  <option key={opt.id} value={opt.id}>
                    {opt.label}
                  </option>
                ))}
              </select>
            </div>
            <div className="typo-funnel__appearance-row">
            <label className="typo-funnel__appearance-label" htmlFor="letter-font">
              Next drop — font
            </label>
            <select
              id="letter-font"
              className="typo-funnel__appearance-select"
              value={letterFontId}
              onChange={(e) => setLetterFontId(e.target.value)}
            >
              {LETTER_FONT_OPTIONS.map((opt) => (
                <option key={opt.id} value={opt.id}>
                  {opt.label}
                </option>
              ))}
            </select>
          </div>
            <div className="typo-funnel__appearance-row typo-funnel__appearance-row--color">
            <label className="typo-funnel__appearance-label" htmlFor="letter-color">
              Next drop — color
            </label>
            <input
              id="letter-color"
              className="typo-funnel__color-swatch"
              type="color"
              value={/^#[0-9A-Fa-f]{6}$/i.test(letterColor) ? letterColor : '#2d2640'}
              onChange={(e) => setLetterColor(e.target.value)}
              title="Letter color"
            />
          </div>
          </div>

          <button
            type="button"
            className="typo-funnel__restart"
            onClick={restartLetters}
          >
            Restart
          </button>
        </div>
      </aside>

      <div ref={stageRef} className="typo-funnel__stage">
        <canvas
          ref={canvasRef}
          className="typo-funnel__canvas"
          style={{ backgroundColor: canvasBgHex }}
        />
      </div>
    </motion.div>
  )
}
