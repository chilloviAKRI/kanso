/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { CHANGED_TOPIC, OmarchyTheme } from "resource:///modules/kanso/OmarchyTheme.sys.mjs";

export class KansoAppearanceParent extends JSWindowActorParent {
  onAppearanceChanged = () => this.update();

  actorCreated() {
    Services.obs.addObserver(this.onAppearanceChanged, CHANGED_TOPIC);
  }

  didDestroy() {
    Services.obs.removeObserver(this.onAppearanceChanged, CHANGED_TOPIC);
  }

  receiveMessage({ name }) {
    if (name === "Kanso:GetAppearance") {
      this.update();
    }
  }

  update() {
    if (
      this.browsingContext.currentWindowGlobal !== this.manager ||
      this.manager.documentURI?.spec !== "about:newtab" ||
      this.manager.documentPrincipal.originAttributes.privateBrowsingId
    ) {
      return;
    }

    this.sendAsyncMessage("Kanso:Appearance", {
      appearance: OmarchyTheme.newTabAppearance,
    });
  }
}
