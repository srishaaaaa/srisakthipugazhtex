/**
 * Preferred Colour Theme = selected CARD COLOUR + WHITE.
 *
 * The whole app already styles itself from three brand colours (the card /
 * primary red, a lighter accent, and a soft tint used for borders). Those three
 * are now driven by CSS variables holding raw RGB channels, so the owner can
 * change the card colour from Store Settings without any redesign: white
 * backgrounds, layout, typography, spacing and components are untouched.
 */

export const DEFAULT_CARD_COLOR = '#5A0201'

const THEME_CACHE_KEY = 'shop-card-color'

type Rgb = { r: number; g: number; b: number }

export const normalizeHex = (value: string): string => {
  const raw = (value || '').trim()
  const short = /^#?([0-9a-f])([0-9a-f])([0-9a-f])$/i.exec(raw)
  if (short) return `#${short[1]}${short[1]}${short[2]}${short[2]}${short[3]}${short[3]}`.toUpperCase()
  const full = /^#?([0-9a-f]{6})$/i.exec(raw)
  return full ? `#${full[1].toUpperCase()}` : ''
}

export const isValidHex = (value: string) => normalizeHex(value) !== ''

const toRgb = (hex: string): Rgb => {
  const safe = normalizeHex(hex) || DEFAULT_CARD_COLOR
  return {
    r: parseInt(safe.slice(1, 3), 16),
    g: parseInt(safe.slice(3, 5), 16),
    b: parseInt(safe.slice(5, 7), 16),
  }
}

const channels = ({ r, g, b }: Rgb) => `${r} ${g} ${b}`

/** Mix towards white — this is the "+ WHITE" half of the theme. */
const mixWhite = ({ r, g, b }: Rgb, amount: number): Rgb => ({
  r: Math.round(r + (255 - r) * amount),
  g: Math.round(g + (255 - g) * amount),
  b: Math.round(b + (255 - b) * amount),
})

/** Slightly lighter sibling used for the existing highlight/active accents. */
const lighten = (rgb: Rgb) => mixWhite(rgb, 0.08)

/** Mix towards black — the deeper shade used for the app chrome. */
const mixBlack = ({ r, g, b }: Rgb, amount: number): Rgb => ({
  r: Math.round(r * (1 - amount)),
  g: Math.round(g * (1 - amount)),
  b: Math.round(b * (1 - amount)),
})

/** Readable text colour on top of the card colour (white unless very light). */
export const contrastOn = (hex: string): '#FFFFFF' | '#111111' => {
  const { r, g, b } = toRgb(hex)
  const luminance = (0.299 * r + 0.587 * g + 0.114 * b) / 255
  return luminance > 0.68 ? '#111111' : '#FFFFFF'
}

/** Applies the card colour to the document as CSS variables. */
export const applyShopTheme = (hex: string) => {
  if (typeof document === 'undefined') return
  const base = normalizeHex(hex) || DEFAULT_CARD_COLOR
  const rgb = toRgb(base)
  const root = document.documentElement
  root.style.setProperty('--shop-card-rgb', channels(rgb))
  root.style.setProperty('--shop-accent-rgb', channels(lighten(rgb)))
  root.style.setProperty('--shop-soft-rgb', channels(mixWhite(rgb, 0.78)))
  // Page background is plain white, not a red-tinted "cream" — the red/white
  // theme reads as red + white (+ near-black chrome below), not red + beige.
  root.style.setProperty('--shop-tint-rgb', '255 255 255')
  // Deep chrome (sidebars, headers) stays a very dark shade of the card
  // colour itself — mixing further towards black than this crushes a red
  // card colour into a muddy near-black brown instead of a deep red.
  root.style.setProperty('--shop-deep-rgb', channels(mixBlack(rgb, 0.45)))
  root.style.setProperty('--shop-on-card', contrastOn(base))
  try {
    window.localStorage.setItem(THEME_CACHE_KEY, base)
  } catch {
    // Ignore storage failures (private mode / restricted storage).
  }
}

/** Card colour cached from the last save — used before settings load. */
export const readCachedCardColor = (): string => {
  try {
    return normalizeHex(window.localStorage.getItem(THEME_CACHE_KEY) || '') || DEFAULT_CARD_COLOR
  } catch {
    return DEFAULT_CARD_COLOR
  }
}

/**
 * Resolved hex for contexts that cannot read CSS variables: jsPDF documents and
 * the thermal-receipt print window.
 */
export const resolveCardColorHex = (): string => readCachedCardColor()

const toHex = ({ r, g, b }: Rgb) =>
  `#${[r, g, b].map((n) => n.toString(16).padStart(2, '0')).join('')}`.toUpperCase()

/** Soft tint of the card colour — the existing light border/divider colour. */
export const resolveCardSoftHex = (): string => toHex(mixWhite(toRgb(readCachedCardColor()), 0.78))

/** Suggested swatches — all "card colour + white" safe. */
export const CARD_COLOR_PRESETS = [
  '#5A0201',
  '#A00818',
  '#D6402E',
  '#8B1C31',
  '#7A2E8E',
  '#1F5F8B',
  '#0F7A6B',
  '#B8860B',
  '#C2185B',
  '#2F4858',
]
