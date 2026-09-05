import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const css = readFileSync(resolve(process.cwd(), 'src/app/globals.css'), 'utf8');

function luminance(hex: string) {
  const channels = hex.match(/../g)!.map((value) => Number.parseInt(value, 16) / 255)
    .map((value) => value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4);
  return 0.2126 * channels[0]! + 0.7152 * channels[1]! + 0.0722 * channels[2]!;
}

function contrast(foreground: string, background: string) {
  const values = [luminance(foreground), luminance(background)].sort((a, b) => b - a);
  return (values[0]! + 0.05) / (values[1]! + 0.05);
}

describe('accessible text colors', () => {
  it('keeps normal muted text above the WCAG AA contrast threshold', () => {
    const muted = css.match(/--muted:\s*#([0-9a-f]{6})/i)?.[1];
    const paper = css.match(/--paper:\s*#([0-9a-f]{6})/i)?.[1];
    expect(muted).toBeDefined();
    expect(paper).toBeDefined();
    expect(contrast(muted!, paper!)).toBeGreaterThanOrEqual(4.5);
    expect(contrast(muted!, 'ffffff')).toBeGreaterThanOrEqual(4.5);
  });

  it.each([
    '.search-form input::placeholder',
    '.empty',
    '.brand',
    'footer',
  ])('uses the accessible muted color for %s', (selector) => {
    const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    expect(css).toMatch(new RegExp(`${escaped}\\s*\\{[^}]*color:\\s*var\\(--muted\\)`));
  });

  it('honors reduced-motion preferences for scrolling and loading feedback', () => {
    const reducedMotion = css.match(
      /@media\s*\(prefers-reduced-motion:\s*reduce\)\s*\{([\s\S]+)\}\s*$/,
    )?.[1];
    expect(reducedMotion).toContain('scroll-behavior: auto');
    expect(reducedMotion).toContain('animation: none');
  });

  it('keeps the keyboard focus indicator distinct from every adjacent surface', () => {
    const focus = css.match(/:focus-visible[^{}]*\{[^}]*outline:\s*3px solid #([0-9a-f]{6})/i)?.[1];
    const paper = css.match(/--paper:\s*#([0-9a-f]{6})/i)?.[1];
    const cream = css.match(/--cream:\s*#([0-9a-f]{6})/i)?.[1];
    const ink = css.match(/--ink:\s*#([0-9a-f]{6})/i)?.[1];
    expect(focus).toBeDefined();
    expect(paper).toBeDefined();
    expect(cream).toBeDefined();
    expect(ink).toBeDefined();
    for (const background of ['ffffff', paper!, cream!, ink!]) {
      expect(contrast(focus!, background)).toBeGreaterThanOrEqual(3);
    }
  });

  it.each([
    '.recent button',
    '.brand',
    '.product-card h3',
  ])('wraps unbroken external or user text in %s', (selector) => {
    const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    expect(css).toMatch(new RegExp(`${escaped}\\s*\\{[^}]*overflow-wrap:\\s*anywhere`));
  });

  it('allows the recent-search flex group and buttons to shrink to the viewport', () => {
    expect(css).toMatch(/\.recent div\s*\{[^}]*min-width:\s*0/);
    expect(css).toMatch(/\.recent button\s*\{[^}]*max-width:\s*100%/);
  });
});
