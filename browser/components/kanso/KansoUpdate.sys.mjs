/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

const PAGE = "about:kanso-update";
const UPDATE_EXIT_STATUS = 83; // Hand back to the Kanso launcher to install.
const VERSION = /^[0-9]+(?:\.[0-9]+){1,2}-[0-9]+(?:\.[0-9]+)?$/;

function readOffer() {
  try {
    const offer = JSON.parse(Services.env.get("KANSO_UPDATE_OFFER"));
    if (typeof offer?.installed === "string" && VERSION.test(offer.installed) &&
        typeof offer?.available === "string" && VERSION.test(offer.available)) {
      return Object.freeze({
        installed: offer.installed,
        available: offer.available,
        failed: offer.failed === true,
      });
    }
  } catch {}
  return null;
}

const offer = readOffer();

export const KansoUpdate = {
  show(window) {
    const tabs = window?.gBrowser;
    if (!offer || window?.closed || !tabs ||
        tabs.selectedBrowser?.browsingContext.usePrivateBrowsing) {
      return;
    }
    const existing = tabs.tabs.find(tab => tab.linkedBrowser.currentURI.spec === PAGE);
    tabs.selectedTab = existing ?? tabs.addTrustedTab(PAGE);
  },

  request(browser) {
    const window = browser?.documentGlobal;
    const tabs = window?.gBrowser;
    const tab = tabs?.getTabForBrowser(browser);
    if (!offer || !tab || browser.currentURI.spec !== PAGE ||
        tabs.selectedTab !== tab || Services.startup.attemptingQuit) {
      return false;
    }

    const cancel = Cc["@mozilla.org/supports-PRBool;1"].createInstance(Ci.nsISupportsPRBool);
    Services.obs.notifyObservers(cancel, "quit-application-requested", "restart");
    if (cancel.data) {
      return false;
    }
    const restorePref = "browser.sessionstore.resume_session_once";
    const restore = Services.prefs.getBoolPref(restorePref, false);
    const hadUserValue = Services.prefs.prefHasUserValue(restorePref);
    Services.prefs.setBoolPref(restorePref, true);
    tabs.removeTab(tab, { skipSessionStore: true, closeWindowWithLastTab: false });
    Services.startup.quit(Ci.nsIAppStartup.eAttemptQuit, UPDATE_EXIT_STATUS);
    if (!Services.startup.attemptingQuit) {
      if (hadUserValue) {
        Services.prefs.setBoolPref(restorePref, restore);
      } else {
        Services.prefs.clearUserPref(restorePref);
      }
      this.show(window);
      return false;
    }
    return true;
  },
};

export class KansoUpdateParent extends JSWindowActorParent {
  receiveMessage({ name }) {
    if (this.browsingContext !== this.browsingContext.top ||
        this.browsingContext.currentWindowGlobal !== this.manager ||
        this.manager.documentURI?.spec !== PAGE ||
        this.manager.documentPrincipal.originAttributes.privateBrowsingId) {
      return null;
    }
    if (name === "Kanso:UpdateOffer") {
      return offer;
    }
    if (name === "Kanso:RequestUpdate") {
      return KansoUpdate.request(this.browsingContext.embedderElement);
    }
    return null;
  }
}
