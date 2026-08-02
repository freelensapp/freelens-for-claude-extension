/**
 * Copyright (c) Freelens Authors. All rights reserved.
 * Licensed under MIT License. See LICENSE in root directory for more information.
 */

// Colors for the context-usage breakdown. The Agent SDK carries a `color` per
// category, but older Claude Code builds (and some categories) leave it empty,
// which would paint the bar segment transparent. To keep the bar readable we
// fall back to a fixed palette keyed by category name, mirroring the colors the
// Claude Code `/context` command uses in the VS Code extension.

/** VS Code `/context`-style colors keyed by the normalized category name. */
const NAMED_COLORS: Record<string, string> = {
  "system prompt": "#d4a13a", // gold
  "system tools": "#c9704b", // terracotta (Claude clay)
  "mcp tools": "#9b72cf", // purple
  "custom agents": "#3f9e7c", // teal-green
  agents: "#3f9e7c",
  "memory files": "#4f8fd0", // blue
  messages: "#c15c8f", // rose
  "autocompact buffer": "#7a828c", // slate
  "reserved for autocompaction": "#7a828c",
};

/** Cycled for any category not covered by name or by an SDK-provided color. */
const FALLBACK_PALETTE = ["#d4a13a", "#c9704b", "#9b72cf", "#3f9e7c", "#4f8fd0", "#c15c8f", "#7a828c"];

/** A usable CSS color from the SDK is a hex or an rgb()/hsl() function value. */
function isUsableColor(color: string): boolean {
  const value = color.trim().toLowerCase();
  return /^#[0-9a-f]{3,8}$/.test(value) || value.startsWith("rgb") || value.startsWith("hsl");
}

/**
 * Resolve the color for a context category: prefer a usable SDK-provided color,
 * then a name match against the VS Code-like palette, then a stable per-index
 * fallback so every segment and swatch always shows a color.
 */
export function categoryColor(name: string, sdkColor: string, index: number): string {
  if (isUsableColor(sdkColor)) return sdkColor;
  const named = NAMED_COLORS[name.trim().toLowerCase()];
  if (named) return named;
  return FALLBACK_PALETTE[index % FALLBACK_PALETTE.length];
}
