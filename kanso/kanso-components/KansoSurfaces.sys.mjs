/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

const surfaces = new Map([
  ["about:newtab", "newtab"],
  ["about:preferences", "preferences"],
  ["about:settings", "preferences"],
  ["about:addons", "addons"],
  ["about:downloads", "downloads"],
  ["about:protections", "protections"],
  ["about:logins", "logins"],
  ["about:loginsimportreport", "logins"],
  ["about:firefoxview", "firefoxview"],
  ["about:opentabs", "firefoxview"],
  ["about:support", "diagnostics"],
  ["about:config", "diagnostics"],
  ["about:processes", "diagnostics"],
  ["about:performance", "diagnostics"],
  ["about:networking", "diagnostics"],
  ["about:memory", "diagnostics"],
  ["about:cache", "diagnostics"],
  ["about:crashes", "diagnostics"],
  ["about:policies", "diagnostics"],
  ["about:certificate", "diagnostics"],
  ["about:debugging", "diagnostics"],
  ["about:compat", "diagnostics"],
  ["about:serviceworkers", "diagnostics"],
  ["about:logging", "diagnostics"],
  ["about:telemetry", "diagnostics"],
  ["about:profiles", "profiles"],
  ["about:editprofile", "profiles"],
  ["about:newprofile", "profiles"],
  ["about:deleteprofile", "profiles"],
  ["about:profilemanager", "profiles"],
  ["about:sessionrestore", "diagnostics"],
  ["about:welcomeback", "diagnostics"],
  ["chrome://browser/content/places/places.xhtml", "library"],
  ["chrome://browser/content/downloads/contentAreaDownloadsView.xhtml", "downloads"],
  ["chrome://browser/content/places/historySidebar.xhtml", "sidebar"],
  ["chrome://browser/content/places/bookmarksSidebar.xhtml", "sidebar"],
  ["chrome://global/content/commonDialog.xhtml", "dialog"],
  ["chrome://global/content/selectDialog.xhtml", "dialog"],
]);

const directories = new Map([
  ["chrome://browser/content/preferences/dialogs/", "dialog"],
  ["chrome://browser/content/sidebar/", "sidebar"],
  ["chrome://browser/content/syncedtabs/", "sidebar"],
]);

export const SURFACE_MATCHES = [...surfaces.keys(), ...directories.keys()].map(
  url => url + "*"
);

export function surfaceForURL(url) {
  const base = url?.split(/[?#]/, 1)[0];
  if (surfaces.has(base)) {
    return surfaces.get(base);
  }
  for (const [prefix, surface] of directories) {
    if (base?.startsWith(prefix)) {
      return surface;
    }
  }
  return null;
}
