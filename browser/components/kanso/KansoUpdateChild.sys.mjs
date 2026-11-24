/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

const english = {
  title: "Kanso update available",
  description: "Your tabs will reopen after the update.",
  installed: "Installed",
  available: "Available",
  apply: "Update and restart",
  restarting: "Restarting Kanso…",
  failed: "The update could not be completed. You can try again.",
  unavailable: "No update available",
};

const russian = {
  title: "Доступно обновление Kanso",
  description: "После обновления открытые вкладки восстановятся.",
  installed: "Установлено",
  available: "Доступно",
  apply: "Обновить и перезапустить",
  restarting: "Kanso перезапускается…",
  failed: "Не удалось завершить обновление. Можно попробовать ещё раз.",
  unavailable: "Обновлений нет",
};

export class KansoUpdateChild extends JSWindowActorChild {
  async handleEvent(event) {
    const document = this.document;
    if (!document || document.documentURI !== "about:kanso-update") {
      return;
    }
    const ru = /^ru(?:-|$)/i.test(this.contentWindow.navigator.language);
    const strings = ru ? russian : english;
    const button = document.getElementById("apply");
    const status = document.getElementById("status");

    if (event.type === "DOMContentLoaded") {
      const offer = await this.sendQuery("Kanso:UpdateOffer");
      document.documentElement.lang = ru ? "ru" : "en";
      document.title = offer ? strings.title : strings.unavailable;
      document.getElementById("title").textContent = document.title;
      if (offer) {
        for (const key of ["description", "installed", "available", "apply"]) {
          document.getElementById(key).textContent = strings[key];
        }
        document.getElementById("installed-version").textContent = offer.installed;
        document.getElementById("available-version").textContent = offer.available;
        status.textContent = offer.failed ? strings.failed : "";
        document.getElementById("offer").hidden = false;
      }
    } else if (event.isTrusted && event.target === button && !button.disabled) {
      button.disabled = true;
      status.textContent = strings.restarting;
      try {
        if (await this.sendQuery("Kanso:RequestUpdate")) {
          return;
        }
      } catch {
        // Shutdown can destroy the actor before its reply arrives.
      }
      if (button.isConnected) {
        button.disabled = false;
        status.textContent = "";
      }
    }
  }
}
