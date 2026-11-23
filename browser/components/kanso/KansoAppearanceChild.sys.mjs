/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

export class KansoAppearanceChild extends JSWindowActorChild {
  handleEvent() {
    this.sendAsyncMessage("Kanso:GetAppearance");
  }

  receiveMessage({ name, data }) {
    const win = this.contentWindow;
    if (name !== "Kanso:Appearance" || !win) {
      return;
    }

    const root = win.document.documentElement;
    const appearance = data.appearance;
    root.toggleAttribute("omarchy", Boolean(appearance));
    for (const key of ["background", "foreground", "accent", "muted"]) {
      if (appearance?.[key]) {
        root.style.setProperty("--omarchy-" + key, appearance[key]);
      } else {
        root.style.removeProperty("--omarchy-" + key);
      }
    }
    if (appearance) {
      root.style.colorScheme = appearance.mode;
      root.style.setProperty("--kanso-radius", appearance.radius + "px");
      root.style.setProperty("--kanso-border-width", appearance.borderWidth + "px");
      root.style.setProperty("--kanso-wallpaper-colors", appearance.wallpaperColors.join(" "));
      root.style.setProperty("--kanso-font", appearance.font ? JSON.stringify(appearance.font) : "monospace");
    } else {
      root.style.removeProperty("color-scheme");
      root.style.removeProperty("--kanso-font");
      root.style.removeProperty("--kanso-radius");
      root.style.removeProperty("--kanso-border-width");
      root.style.removeProperty("--kanso-wallpaper-colors");
    }
  }
}
