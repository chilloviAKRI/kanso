/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { parsePalette, themeDetails } from "resource:///modules/kanso/OmarchyPalette.sys.mjs";
import { setInterval, clearInterval, setTimeout, clearTimeout } from "resource://gre/modules/Timer.sys.mjs";
import { LightweightThemeManager } from "resource://gre/modules/LightweightThemeManager.sys.mjs";
import { Subprocess } from "resource://gre/modules/Subprocess.sys.mjs";

export const FOLLOW_PREF = "browser.kanso.follow-omarchy";
export const CHANGED_TOPIC = "kanso-appearance-changed";
const KANSO_THEME = "kanso-omarchy@local";
const POLL_MS = 700;
const HYPR_POLL_MS = 1200;
const HYPR_ROUNDING = "decoration:rounding";
const HYPR_BORDER = "general:border_size";
const PALETTE_LIMIT = 32 * 1024;
const MEDIA_LIMIT = 512 * 1024 * 1024;
const COLOR_SAMPLE_SIZE = 24;
const MEDIA_FORMAT = /\.(?:jpe?g|png|gif|bmp|webp|mp4|m4v|mov|webm|mkv|avi)$/i;
const decoder = new TextDecoder("utf-8", { fatal: true });

async function fileInfo(path) {
  try {
    const info = await IOUtils.stat(path);
    return info.type === "regular" ? info : null;
  } catch {
    return null;
  }
}

function fingerprint(info) {
  return info ? `${info.path}\0${info.lastModified}\0${info.size}` : "";
}

async function readPalette(path, legacyLight) {
  try {
    const info = await fileInfo(path);
    if (!info || info.size > PALETTE_LIMIT) {
      return null;
    }
    const bytes = await IOUtils.read(path, { maxBytes: PALETTE_LIMIT + 1 });
    return bytes.length <= PALETTE_LIMIT ? parsePalette(decoder.decode(bytes), legacyLight) : null;
  } catch {
    return null;
  }
}

async function run(command, args, byteLimit, timeoutMs) {
  const process = await Subprocess.call({ command, arguments: args });
  const timeout = setTimeout(() => process.kill(0), timeoutMs);
  const buffers = [];
  let length = 0;
  try {
    for (;;) {
      const bytes = new Uint8Array(await process.stdout.read());
      if (!bytes.length) {
        break;
      }
      length += bytes.length;
      if (length > byteLimit) {
        throw new Error("Kanso appearance command exceeded its output limit");
      }
      buffers.push(bytes);
    }
    if ((await process.wait()).exitCode !== 0) {
      return null;
    }
    const output = new Uint8Array(length);
    let offset = 0;
    for (const bytes of buffers) {
      output.set(bytes, offset);
      offset += bytes.length;
    }
    return output;
  } finally {
    clearTimeout(timeout);
    await process.kill(0);
  }
}

async function fontFamily() {
  const data = await run("/usr/bin/fc-match", ["-f", "%{family}\n", "monospace"], 4096, 1500);
  if (!data) {
    return null;
  }
  const family = decoder.decode(data).split(",")[0].trim();
  return family && family.length <= 160 && !/[\u0000-\u001f\u007f]/.test(family) ? family : null;
}

async function wallpaperInfo(link) {
  try {
    const file = Cc["@mozilla.org/file/local;1"].createInstance(Ci.nsIFile);
    file.initWithPath(link);
    if (!file.isSymlink()) {
      return null;
    }
    // Omarchy permits setting a wallpaper anywhere under the user's account.
    // Resolve only its dedicated current/background link.
    const info = await fileInfo(file.target);
    return info && MEDIA_FORMAT.test(info.path) && info.size <= MEDIA_LIMIT ? info : null;
  } catch {
    return null;
  }
}

async function wallpaperColors(path) {
  const sampleBytes = COLOR_SAMPLE_SIZE ** 2 * 3;
  const pixels = await run("/usr/bin/ffmpeg", [
    "-nostdin", "-hide_banner", "-loglevel", "error",
    "-threads", "1", "-filter_threads", "1", "-max_alloc", "100663296",
    "-protocol_whitelist", "file,pipe",
    "-format_whitelist", "image2,jpeg_pipe,png_pipe,gif,bmp_pipe,webp_pipe,mov,matroska,avi,m4v",
    "-i", path, "-map", "0:v:0", "-an", "-sn", "-dn", "-frames:v", "1",
    "-vf", `scale=${COLOR_SAMPLE_SIZE}:${COLOR_SAMPLE_SIZE}:flags=area,format=rgb24`,
    "-c:v", "rawvideo", "-threads:v", "1", "-f", "rawvideo", "pipe:1",
  ], sampleBytes, 4000);
  if (pixels?.length !== sampleBytes) {
    return [];
  }

  const buckets = new Map();
  for (let index = 0; index < pixels.length; index += 3) {
    const red = pixels[index];
    const green = pixels[index + 1];
    const blue = pixels[index + 2];
    const chroma = Math.max(red, green, blue) - Math.min(red, green, blue);
    // Favor distinct wallpaper colors over neutral areas such as letterboxing.
    const weight = 1 + chroma ** 2 / 256;
    const key = (red >> 5) * 64 + (green >> 5) * 8 + (blue >> 5);
    if (!buckets.has(key)) {
      buckets.set(key, { channels: [0, 0, 0], weight: 0 });
    }
    const bucket = buckets.get(key);
    bucket.channels[0] += red * weight;
    bucket.channels[1] += green * weight;
    bucket.channels[2] += blue * weight;
    bucket.weight += weight;
  }

  const colors = [];
  for (const { channels, weight } of [...buckets.values()].sort((a, b) => b.weight - a.weight)) {
    const color = channels.map(total => Math.round(total / weight));
    if (colors.every(other => other.reduce((distance, value, i) =>
      distance + (value - color[i]) ** 2, 0) >= 28 ** 2)) {
      colors.push(color);
      if (colors.length === 6) {
        break;
      }
    }
  }
  return colors.map(color =>
    "#" + color.map(value => value.toString(16).padStart(2, "0")).join("")
  );
}

export const OmarchyTheme = {
  radius: 0,
  borderWidth: 1,

  startup() {
    if (this.timer || Services.appinfo.inSafeMode) {
      return;
    }
    const home = Services.dirsvc.get("Home", Ci.nsIFile).path;
    const current = Services.env.get("KANSO_OMARCHY_CURRENT_DIR");
    this.current = current?.startsWith("/")
      ? current
      : PathUtils.join(home, ".local", "state", "omarchy", "current");
    const config = Services.env.get("XDG_CONFIG_HOME") || PathUtils.join(home, ".config");
    const fontFile = Services.env.get("FONTCONFIG_FILE");
    this.fontConfig = fontFile?.startsWith("/") ? fontFile : PathUtils.join(config, "fontconfig", "fonts.conf");
    Services.prefs.addObserver(FOLLOW_PREF, this);
    Services.obs.addObserver(this, "quit-application-granted");
    this.timer = setInterval(() => this.refresh(), POLL_MS);
    if (Services.env.get("HYPRLAND_INSTANCE_SIGNATURE")) {
      this.hyprTimer = setInterval(() => this.refreshHyprland(), HYPR_POLL_MS);
      this.refreshHyprland();
    }
    this.refresh();
  },

  observe(_subject, topic) {
    if (topic === "quit-application-granted") {
      clearInterval(this.timer);
      clearInterval(this.hyprTimer);
      this.timer = null;
      Services.obs.removeObserver(this, topic);
      Services.prefs.removeObserver(FOLLOW_PREF, this);
      return;
    }

    this.notify();
    this.refresh();
    if (this.hyprTimer) {
      this.refreshHyprland();
    }
  },

  get enabled() {
    return Boolean(this.timer && Services.prefs.getBoolPref(FOLLOW_PREF, true));
  },

  get themeData() {
    return this.enabled ? this.nativeTheme : null;
  },

  get interfaceFont() {
    return this.enabled && this.font;
  },

  get newTabAppearance() {
    if (!this.enabled || !this.palette) {
      return null;
    }
    const { mode, background, foreground, accent, border: muted } = this.palette;
    return {
      mode, background, foreground, accent, muted,
      wallpaperColors: this.wallpaper?.colors ?? [],
      font: this.font ?? null,
      radius: this.radius,
      borderWidth: this.borderWidth,
    };
  },

  notify() {
    Services.obs.notifyObservers(null, CHANGED_TOPIC);
  },

  async refresh() {
    if (!this.enabled || this.refreshing) {
      return;
    }

    this.refreshing = true;
    try {
      const bgLink = PathUtils.join(this.current, "background");
      const themeDir = PathUtils.join(this.current, "theme");
      const legacyLight = await IOUtils.exists(PathUtils.join(themeDir, "light.mode"));
      const [palette, fontInfo, background] = await Promise.all([
        readPalette(PathUtils.join(themeDir, "colors.toml"), legacyLight),
        fileInfo(this.fontConfig),
        wallpaperInfo(bgLink),
      ]);
      if (!this.enabled) {
        return;
      }
      if (palette && JSON.stringify(palette) !== JSON.stringify(this.palette)) {
        this.palette = palette;
        this.nativeTheme = LightweightThemeManager.themeDataFrom(
          themeDetails(palette), null, null, null, KANSO_THEME, "1", null
        );
        this.notify();
      }
      this.refreshFont(fingerprint(fontInfo));
      // The active theme directory disappears briefly while Omarchy swaps it.
      if (palette) {
        this.refreshWallpaper(background);
      }
    } catch (error) {
      console.warn("Kanso could not read the active Omarchy appearance", error);
    } finally {
      this.refreshing = false;
    }
  },

  async refreshHyprland() {
    if (!this.enabled || this.hyprReading) {
      return;
    }

    this.hyprReading = true;
    try {
      const output = await run("/usr/bin/hyprctl", [
        "-j", "--batch", `getoption ${HYPR_ROUNDING};getoption ${HYPR_BORDER}`,
      ], 4096, 850);
      if (!output) {
        return;
      }
      // hyprctl concatenates its JSON objects for batch queries.
      const options = decoder.decode(output).trim().replace(/}\s*{/g, "},{");
      let changed = false;
      for (const { option, int: value } of JSON.parse(`[${options}]`)) {
        const property = option === HYPR_ROUNDING ? "radius" :
          option === HYPR_BORDER ? "borderWidth" : null;
        if (this.enabled && property && Number.isInteger(value) && value >= 0 &&
            value !== this[property]) {
          this[property] = value;
          changed = true;
        }
      }
      if (changed) {
        this.notify();
      }
    } catch {
      // Keep the last known value while the compositor is unavailable.
    } finally {
      this.hyprReading = false;
    }
  },

  async refreshFont(key) {
    if (key === this.fontKey) {
      return;
    }
    this.fontKey = key;
    let font;
    try {
      font = await fontFamily();
    } catch {
      font = null;
    }
    if (key === this.fontKey && font !== this.font) {
      this.font = font;
      this.notify();
    }
  },

  async refreshWallpaper(info) {
    const key = fingerprint(info);
    if (key === this.wallpaper?.key) {
      return;
    }
    const current = { key, colors: key ? this.wallpaper?.colors : [] };
    this.wallpaper = current;
    if (key) {
      let colors;
      try {
        colors = await wallpaperColors(info.path);
      } catch {
        colors = [];
      }
      if (this.wallpaper !== current) {
        return;
      }
      current.colors = colors;
    }
    this.notify();
  },
};
