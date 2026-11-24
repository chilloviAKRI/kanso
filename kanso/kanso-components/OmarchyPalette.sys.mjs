/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

const COLOR = /^#[\da-f]{6}$/i;
const LINE = /^\s*([a-z_0-9]+)\s*=\s*(?:"([^"]*)"|'([^']*)')\s*(?:#.*)?$/i;
const KEYS = new Set([
  "mode",
  "background",
  "foreground",
  "accent",
  "dark_background",
  "lighter_background",
  "selection",
  "muted",
  "color0",
  "color4",
  "color7",
  "color8",
]);

function luminance(color) {
  const channels = color.slice(1).match(/../g).map(component => {
    const value = parseInt(component, 16) / 255;
    return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
  });
  return channels[0] * 0.2126 + channels[1] * 0.7152 + channels[2] * 0.0722;
}

export function contrast(a, b) {
  const [low, high] = [luminance(a), luminance(b)].sort((x, y) => x - y);
  return (high + 0.05) / (low + 0.05);
}

function blend(a, b, weight) {
  const components = [1, 3, 5].map(index => {
    const start = parseInt(a.slice(index, index + 2), 16);
    const end = parseInt(b.slice(index, index + 2), 16);
    return Math.round(start + (end - start) * weight).toString(16).padStart(2, "0");
  });
  return "#" + components.join("");
}

function readable(color, surface, ratio = 4.5) {
  if (contrast(color, surface) >= ratio) {
    return color;
  }

  const black = contrast("#000000", surface);
  const white = contrast("#ffffff", surface);
  const endpoint = black >= white ? "#000000" : "#ffffff";
  for (let step = 1; step <= 10; step++) {
    const candidate = blend(color, endpoint, step / 10);
    if (contrast(candidate, surface) >= ratio) {
      return candidate;
    }
  }
  return endpoint;
}

// The Omarchy theme contract is a flat list of strings. Accept only known
// tokens and hex colors so the theme cannot inject rules or URLs into chrome.
export function parsePalette(source, legacyLight = false) {
  const values = Object.create(null);
  for (const line of source.replace(/^\uFEFF/, "").split("\n")) {
    if (/^\s*\[/.test(line)) {
      break;
    }
    const match = LINE.exec(line);
    if (match && KEYS.has(match[1])) {
      const value = (match[2] ?? match[3]).toLowerCase();
      if (match[1] === "mode" ? ["light", "dark"].includes(value) : COLOR.test(value)) {
        values[match[1]] = value;
      }
    }
  }

  const background = values.background ?? values.color0;
  const foreground = values.foreground ?? values.color7;
  const accent = values.accent ?? values.color4;
  if (!background || !foreground || !accent) {
    return null;
  }

  const mode = values.mode ?? (legacyLight || luminance(background) > 0.35 ? "light" : "dark");
  const frame = values.dark_background ?? background;
  const surface = values.lighter_background ?? blend(background, foreground, 0.08);
  const selection = values.selection ?? blend(background, foreground, 0.18);
  const border = values.muted ?? values.color8 ?? blend(background, foreground, 0.28);
  const action = readable(accent, surface);

  return {
    mode,
    background,
    foreground: readable(foreground, background),
    accent: readable(accent, background, 3),
    frame,
    frameText: readable(foreground, frame),
    surface,
    surfaceText: readable(foreground, surface),
    selection,
    selectionText: readable(foreground, selection),
    action,
    actionText: readable(background, action),
    border,
  };
}

export function themeDetails(palette) {
  const {
    mode, background, foreground, accent, frame, frameText,
    surface, surfaceText, selection, selectionText, border,
  } = palette;
  return {
    properties: { color_scheme: mode, content_color_scheme: mode },
    colors: {
      frame,
      frame_inactive: frame,
      tab_background_text: frameText,
      tab_text: surfaceText,
      tab_selected: surface,
      tab_line: accent,
      tab_loading: accent,
      toolbar: background,
      toolbar_text: foreground,
      toolbar_field: surface,
      toolbar_field_text: surfaceText,
      toolbar_field_border: border,
      toolbar_field_focus: surface,
      toolbar_field_text_focus: surfaceText,
      toolbar_field_border_focus: accent,
      toolbar_bottom_separator: border,
      icons: foreground,
      icons_attention: accent,
      button_background_hover: surface,
      button_background_active: selection,
      popup: surface,
      popup_text: surfaceText,
      popup_border: border,
      popup_highlight: selection,
      popup_highlight_text: selectionText,
      sidebar: background,
      sidebar_text: foreground,
      sidebar_border: border,
      sidebar_highlight: selection,
      sidebar_highlight_text: selectionText,
      ntp_background: background,
      ntp_card_background: surface,
      ntp_text: foreground,
    },
  };
}
