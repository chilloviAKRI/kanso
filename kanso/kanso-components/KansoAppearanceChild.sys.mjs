/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

const paletteProperties = [
  ["background", "background"],
  ["foreground", "foreground"],
  ["accent", "accent"],
  ["muted", "muted"],
  ["frame", "frame"],
  ["frameText", "frame-text"],
  ["surface", "surface"],
  ["surfaceText", "surface-text"],
  ["selection", "selection"],
  ["selectionText", "selection-text"],
  ["action", "action"],
  ["actionText", "action-text"],
];

export class KansoAppearanceChild extends JSWindowActorChild {
  #loadedSheet = false;

  handleEvent() {
    this.sendAsyncMessage("Kanso:GetAppearance");
  }

  receiveMessage({ name, data }) {
    const win = this.contentWindow;
    if (name !== "Kanso:Appearance" || !win) {
      return;
    }

    const { appearance, surface } = data;
    const root = win.document.documentElement;
    if (surface !== "newtab" && appearance && !this.#loadedSheet) {
      win.windowUtils.loadSheetUsingURIString(
        "resource://kanso/internal.css",
        Ci.nsIDOMWindowUtils.AUTHOR_SHEET
      );
      this.#loadedSheet = true;
    }
    root.toggleAttribute("omarchy", Boolean(appearance));
    if (surface !== "newtab") {
      if (appearance) {
        root.setAttribute("kanso-page", surface);
      } else {
        root.removeAttribute("kanso-page");
      }
    }

    for (const [key, cssName] of paletteProperties) {
      setProperty(root, "--omarchy-" + cssName, appearance?.[key]);
    }
    setProperty(root, "--kanso-font", appearance?.font && JSON.stringify(appearance.font));
    setProperty(root, "--kanso-radius", appearance && appearance.radius + "px");
    setProperty(root, "--kanso-border-width", appearance && appearance.borderWidth + "px");
    if (surface === "newtab") {
      setProperty(root, "color-scheme", appearance?.mode);
      setProperty(root, "--kanso-wallpaper-colors", appearance?.wallpaperColors.join(" "));
    } else {
      setProperty(root, "--kanso-color-scheme", appearance?.mode);
    }
  }
}

function setProperty(root, name, value) {
  if (value) {
    root.style.setProperty(name, value);
  } else {
    root.style.removeProperty(name);
  }
}
