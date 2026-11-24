# Kanso

Kanso is a Firefox fork for [Omarchy](https://omarchy.org/) on Arch Linux. Its menus, settings, and internal pages follow the Omarchy palette, fonts, and Hyprland styling. The browser supports both horizontal and vertical tabs. It has its own browser profile and a minimal new tab with animated pixel waves colored from the current wallpaper.

## Install on Omarchy

Download the x86-64 package from the [Kanso releases](https://github.com/chilloviAKRI/kanso/releases) and install it with `sudo pacman -U ./kanso-browser-160.0.1-15-x86_64.pkg.tar.zst`. Open **Kanso** from the application launcher.

Kanso checks GitHub Releases when it starts after being fully closed. When a newer version is available, Kanso opens an Omarchy-themed tab with an **Update and restart** button. System-wide updates use the desktop authorization dialog.

Kanso starts its Tor client when it first connects to a .onion address and stops the client when the browser exits. The Arch package installs Tor as a dependency.

See the [installation and build guide in Russian](kanso/README.md) for settings, source verification, and manual updates. The [Arch build recipe](kanso/PKGBUILD) builds Kanso from Mozilla's signed source archive and the [Kanso patches](kanso/patches/).

## Source

This branch is based on Mozilla's [Firefox 160.0.1 release](https://github.com/mozilla-firefox/firefox/tree/FIREFOX_160_0_1_RELEASE). The upstream [Firefox README](README.mozilla.md) and [license notices](toolkit/content/license.html) are included. Kanso is an independent project.
