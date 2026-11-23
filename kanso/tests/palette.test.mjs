import assert from "node:assert/strict";
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { test } from "node:test";
import { contrast, parsePalette, themeDetails } from "../kanso-components/OmarchyPalette.sys.mjs";

const basic = 'background = "#282828"\nforeground = "#d4be98"\naccent = "#7daea3"\n';

test("keeps the source palette wherever it is readable", () => {
  const palette = parsePalette('mode = "dark"\n' + basic);
  assert.equal(palette.background, "#282828");
  assert.equal(palette.foreground, "#d4be98");
  assert.equal(palette.accent, "#7daea3");
  assert.equal(themeDetails(palette).properties.content_color_scheme, "dark");
});

test("supports light mode, old themes, inline comments and literal strings", () => {
  const light = "background='#FFFFFF' # panel\nforeground='#222222'\naccent='#888888'\n";
  assert.equal(parsePalette(light).mode, "light");
  assert.equal(parsePalette(basic, true).mode, "light");
  assert.equal(parsePalette('mode="dark"\n' + light).mode, "dark");
});

test("uses the shell's legacy terminal palette with named colors taking priority", () => {
  const colors = 'color0="#282828"\ncolor7="#d4be98"\ncolor4="#7daea3"\ncolor8="#665c54"';
  const legacy = parsePalette(colors);
  assert.equal(legacy.background, "#282828");
  assert.equal(legacy.foreground, "#d4be98");
  assert.equal(legacy.accent, "#7daea3");
  assert.equal(legacy.border, "#665c54");
  assert.equal(parsePalette(colors + '\naccent="#88aa22"').accent, "#88aa22");
});

test("rejects incomplete palettes, CSS values and keys outside the root table", () => {
  assert.equal(parsePalette('background = "red"\n'), null);
  assert.equal(parsePalette(basic.replace("#7daea3", 'url(https://example.com)')), null);
  assert.equal(parsePalette(basic.replace('accent', '[nested]\naccent')), null);
});

test("repairs contrast independently on panels, fields and selections", () => {
  const palette = parsePalette(basic +
    'lighter_background="#d4be98"\nselection="#d4be98"\ndark_background="#d4be98"');
  assert.ok(contrast(palette.surfaceText, palette.surface) >= 4.5);
  assert.ok(contrast(palette.selectionText, palette.selection) >= 4.5);
  assert.ok(contrast(palette.frameText, palette.frame) >= 4.5);
});

test("parses the stock Omarchy themes present on this machine", {
  skip: !existsSync("/usr/share/omarchy/themes"),
}, () => {
  for (const theme of readdirSync("/usr/share/omarchy/themes")) {
    const path = "/usr/share/omarchy/themes/" + theme + "/colors.toml";
    if (existsSync(path)) {
      const palette = parsePalette(readFileSync(path, "utf8"));
      assert.ok(palette, theme);
      assert.ok(contrast(palette.foreground, palette.background) >= 4.5, theme);
    }
  }
});
