import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

describe('semantic code surface stylesheet tokens', () => {
  it('defines semantic code tokens across light, dark, system-dark, translucent, and forced-colors stylesheets', () => {
    const stylesDir = resolve(import.meta.dirname, '../renderer/src/styles')
    const tokensCss = readFileSync(resolve(stylesDir, 'tokens.css'), 'utf8')
    const lightCss = readFileSync(resolve(stylesDir, 'theme-light.css'), 'utf8')
    const darkCss = readFileSync(resolve(stylesDir, 'theme-dark.css'), 'utf8')
    const baseCss = readFileSync(resolve(stylesDir, 'base.css'), 'utf8')

    for (const twToken of [
      '--color-code-surface: var(--pact-code-surface);',
      '--color-code-block-surface: var(--pact-code-block-surface);',
      '--color-code-foreground: var(--pact-code-foreground);',
      '--color-code-border: var(--pact-code-border);',
    ]) {
      expect(tokensCss).toContain(twToken)
    }

    for (const cssVar of [
      '--pact-code-surface',
      '--pact-code-block-surface',
      '--pact-code-foreground',
      '--pact-code-border',
    ]) {
      expect(lightCss).toContain(cssVar)
      expect(darkCss).toContain(cssVar)
    }
    expect(lightCss).toContain('--pact-material-code:')
    expect(lightCss).toContain("[data-theme='light'][data-material='translucent']")

    const explicitDarkTranslucentIdx = darkCss.indexOf(
      "[data-theme='dark'][data-material='translucent']",
    )
    const mediaDarkIdx = darkCss.indexOf('@media (prefers-color-scheme: dark)')
    const systemDarkTranslucentIdx = darkCss.indexOf(
      ":root:not([data-theme])[data-material='translucent']",
    )
    expect(explicitDarkTranslucentIdx).toBeGreaterThan(-1)
    expect(mediaDarkIdx).toBeGreaterThan(explicitDarkTranslucentIdx)
    expect(systemDarkTranslucentIdx).toBeGreaterThan(mediaDarkIdx)
    for (const cssVar of [
      '--pact-code-surface',
      '--pact-code-block-surface',
      '--pact-code-foreground',
      '--pact-code-border',
    ]) {
      expect(darkCss.slice(0, mediaDarkIdx)).toContain(cssVar)
      expect(darkCss.slice(mediaDarkIdx)).toContain(cssVar)
    }

    const forcedColorsIdx = baseCss.indexOf('@media (forced-colors: active)')
    expect(forcedColorsIdx).toBeGreaterThan(-1)
    const forcedBlock = baseCss.slice(forcedColorsIdx)
    expect(forcedBlock).toContain('--pact-code-surface: Canvas;')
    expect(forcedBlock).toContain('--pact-code-block-surface: Canvas;')
    expect(forcedBlock).toContain('--pact-code-foreground: CanvasText;')
    expect(forcedBlock).toContain('--pact-code-border: ButtonBorder;')
    expect(forcedBlock).toContain('code:not(pre > code)')
  })
})
