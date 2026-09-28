import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { act, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { SettingsFile } from '@shared/schema'
import { DesktopCanvas } from '../components/canvas/DesktopCanvas'
import { applyTheme, themeAttributes } from '../lib/theme'
import { REVEAL_STAGGER_MS, LAUNCH_REVEAL_WINDOW_MS } from '../lib/motion'
import { useLayoutStore } from '../stores/layout'
import { useSettingsStore } from '../stores/settings'
import { makeGroup, PRIMARY_INFO, seedCanvas } from '../test/canvas-fixtures'
import { installFakeBridge } from '../test/fake-bridge'

// The real stylesheets (vitest does not process CSS imports, so read them from disk).
const motionVariablesCss = readFileSync(join(__dirname, 'motion-variables.css'), 'utf8')
const motionCss = readFileSync(join(__dirname, 'motion.css'), 'utf8')

// jsdom cascades unlayered stylesheet declarations into getComputedStyle (not @layer, @media or
// :hover), so the kill switch — unlayered on purpose, to beat every utility — is checked on real
// computed styles; the layered group rules, the OS media query and the hover rule are checked on
// the parsed stylesheet.

let sheet: HTMLStyleElement

beforeEach(() => {
  sheet = document.createElement('style')
  sheet.textContent = `${motionVariablesCss}\n${motionCss}`
  document.head.append(sheet)
  vi.useFakeTimers({
    toFake: [
      'setTimeout',
      'clearTimeout',
      'setInterval',
      'clearInterval',
      'requestAnimationFrame',
      'cancelAnimationFrame',
      'Date'
    ]
  })
})

afterEach(() => {
  vi.useRealTimers()
  sheet.remove()
  document.documentElement.classList.remove('reduce-motion')
})

const GROUPS = [
  makeGroup('lower', { title: 'Lower', x: 40, y: 600, z: 1 }),
  makeGroup('upper', { title: 'Upper', x: 900, y: 40, z: 2 })
]

function renderCanvas(settings: Partial<SettingsFile> = {}): void {
  installFakeBridge()
  seedCanvas({ groups: GROUPS, settings })
  // What connectTheme does in the app: the settings drive <html>'s attributes and classes.
  applyTheme(document.documentElement, themeAttributes(useSettingsStore.getState().settings, null))
  render(<DesktopCanvas displayId={PRIMARY_INFO.id} info={PRIMARY_INFO} />)
}

const region = (name: string): HTMLElement => screen.getByRole('region', { name })

function cssRules(): CSSRule[] {
  return Array.from((sheet.sheet as CSSStyleSheet).cssRules)
}

/** The style rule with exactly this selector (outside @media). */
function rule(selector: string): CSSStyleRule | undefined {
  return flatRules().find((entry) => entry.media === '' && entry.rule.selectorText === selector)
    ?.rule
}

/** Every style rule, including those nested in @media and @layer blocks, with its condition. */
function flatRules(
  rules: CSSRule[] = cssRules(),
  media = ''
): { rule: CSSStyleRule; media: string }[] {
  return rules.flatMap((rule) => {
    if (rule instanceof CSSStyleRule) return [{ rule, media }]
    if ('cssRules' in rule) {
      const condition = rule instanceof CSSMediaRule ? rule.media.mediaText : media
      return flatRules(Array.from((rule as CSSGroupingRule).cssRules), condition)
    }
    return []
  })
}

describe('motion kill switch', () => {
  it('with motion on, nothing is stripped and groups keep their transitions', () => {
    renderCanvas()
    expect(document.documentElement).not.toHaveClass('reduce-motion')
    expect(getComputedStyle(region('Upper')).transition).not.toBe('none')
    expect(region('Upper')).toHaveClass('group-window')
    expect(rule('.group-window')?.style.getPropertyValue('transition')).toContain('height 160ms')
  })

  it('Settings › Reduce motion strips every transition and animation', () => {
    renderCanvas({ reduceMotion: true })
    expect(document.documentElement).toHaveClass('reduce-motion')
    const group = region('Upper')
    const button = screen.getAllByRole('button', { name: /Roll up/ })[0]
    for (const element of [group, button]) {
      expect(getComputedStyle(element).transition).toBe('none')
      expect(getComputedStyle(element).animation).toBe('none')
    }
  })

  it('Windows "Show animations" off (prefers-reduced-motion) strips them the same way', () => {
    const stripped = flatRules().filter(
      ({ rule, media }) =>
        media.includes('prefers-reduced-motion: reduce') &&
        rule.selectorText.split(',').some((selector) => selector.trim().endsWith('*')) &&
        rule.style.getPropertyValue('transition') === 'none' &&
        rule.style.getPropertyPriority('transition') === 'important' &&
        rule.style.getPropertyValue('animation') === 'none'
    )
    expect(stripped).toHaveLength(1)
  })

  it('groups render in their final state: no hidden entrance, straight to settled', () => {
    renderCanvas({ reduceMotion: true })
    for (const name of ['Upper', 'Lower']) {
      const group = region(name)
      expect(group).toHaveAttribute('data-reveal', 'settled')
    }
    // Even a group caught hidden resets to the final state under the kill switch.
    const reset = rule('html.reduce-motion .group-window[data-reveal]')
    expect(reset?.style.getPropertyValue('opacity')).toBe('1')
    expect(reset?.style.getPropertyValue('transform')).toBe('none')
  })

  it('turning the kill switch on mid-entrance jumps to the final state', () => {
    renderCanvas()
    expect(region('Upper')).toHaveAttribute('data-reveal', 'hidden')
    act(() => {
      useSettingsStore.getState().update({ reduceMotion: true })
    })
    expect(region('Upper')).toHaveAttribute('data-reveal', 'settled')
  })
})

describe('group entrance (css-reveal)', () => {
  it('groups fade up on launch in reading order, 40 ms apart', () => {
    renderCanvas()
    const upper = region('Upper')
    const lower = region('Lower')
    // Hidden state: the css-reveal from-state, opacity var(--set-opacity).
    expect(upper).toHaveAttribute('data-reveal', 'hidden')
    expect(lower).toHaveAttribute('data-reveal', 'hidden')
    const hidden = rule(".group-window[data-reveal='hidden']")
    expect(hidden?.style.getPropertyValue('opacity')).toBe('var(--set-opacity)')
    // Top-left first: Upper (y 40) enters before Lower (y 600).
    expect(upper.style.getPropertyValue('--i')).toBe('0')
    expect(lower.style.getPropertyValue('--i')).toBe('1')
    expect(REVEAL_STAGGER_MS).toBe(40)
    const shown = rule(".group-window[data-reveal='shown']")
    expect(shown?.style.getPropertyValue('transition-delay')).toBe(
      `calc(var(--i, 0) * ${REVEAL_STAGGER_MS}ms)`
    )

    // Two frames later (the hidden state has been painted) the reveal starts.
    act(() => {
      vi.advanceTimersByTime(40)
    })
    expect(upper).toHaveAttribute('data-reveal', 'shown')
    expect(rule(".group-window[data-reveal='shown']")?.style.getPropertyValue('opacity')).toBe('1')

    // Once every entrance has run, the groups settle on their quick hover/roll-up transitions.
    act(() => {
      vi.advanceTimersByTime(2_000)
    })
    expect(upper).toHaveAttribute('data-reveal', 'settled')
    expect(lower).toHaveAttribute('data-reveal', 'settled')
  })

  it('a group made after launch appears at once (the entrance is for launch only)', () => {
    renderCanvas()
    act(() => {
      vi.advanceTimersByTime(LAUNCH_REVEAL_WINDOW_MS + 2_000)
    })
    act(() => {
      useLayoutStore.getState().updateDisplay(PRIMARY_INFO.id, (display) => ({
        ...display,
        groups: [...display.groups, makeGroup('late', { title: 'Late', x: 1500, z: 3 })]
      }))
    })
    expect(region('Late')).toHaveAttribute('data-reveal', 'settled')
  })

  it('a group the user makes during the launch window appears at once too', () => {
    renderCanvas()
    act(() => {
      useLayoutStore.getState().updateDisplay(PRIMARY_INFO.id, (display) => ({
        ...display,
        groups: [
          ...display.groups,
          makeGroup('new', { title: 'New', x: 1500, z: 3, createdAt: Date.now() + 1 })
        ]
      }))
    })
    expect(region('New')).toHaveAttribute('data-reveal', 'settled')
    expect(region('Upper')).toHaveAttribute('data-reveal', 'hidden')
  })

  it('hover lifts a group 2 px; roll-up animates its height over 160 ms', () => {
    const hover = flatRules().find(
      ({ rule }) =>
        rule.selectorText.includes('.group-window:hover') &&
        rule.style.getPropertyValue('translate') === '0 -2px'
    )
    expect(hover).toBeDefined()
    const settled = rule('.group-window')?.style.getPropertyValue('transition') ?? ''
    expect(settled).toMatch(/height 160ms/)
    expect(settled).toMatch(/translate 160ms/)
  })

  it('a group being dragged or resized does not animate its size (no lag behind the pointer)', () => {
    const dragging = flatRules().find(({ rule }) =>
      rule.selectorText.includes('.group-window[data-dragging]')
    )
    expect(dragging?.rule.style.getPropertyValue('transition')).not.toContain('height')
  })
})
