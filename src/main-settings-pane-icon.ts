import { setIcon } from "obsidian";

export function enableSettingsPaneIcon(host: any, iconId: string): void {
  if (typeof document === "undefined") {
    return;
  }

  syncSettingsPaneIconObserver(host, iconId);
  host.register(() => {
    host.settingsPaneIconObserver?.disconnect();
    host.settingsPaneIconObserverRoot = null;
  });
}

export function syncSettingsPaneIconObserver(host: any, iconId: string): void {
  if (typeof document === "undefined") {
    return;
  }

  const settingsRoot = document.querySelector<HTMLElement>(".mod-settings");

  if (!settingsRoot) {
    host.settingsPaneIconObserver?.disconnect();
    host.settingsPaneIconObserverRoot = null;
    return;
  }

  scheduleSettingsPaneIconSync(host, iconId);

  if (typeof MutationObserver === "undefined") {
    return;
  }

  if (!host.settingsPaneIconObserver) {
    host.settingsPaneIconObserver = new MutationObserver(() => {
      scheduleSettingsPaneIconSync(host, iconId);
    });
  }

  if (host.settingsPaneIconObserverRoot === settingsRoot) {
    return;
  }

  host.settingsPaneIconObserver.disconnect();
  host.settingsPaneIconObserver.observe(settingsRoot, {
    childList: true,
    subtree: true
  });
  host.settingsPaneIconObserverRoot = settingsRoot;
}

function scheduleSettingsPaneIconSync(host: any, iconId: string): void {
  if (host.settingsPaneIconSyncScheduled) {
    return;
  }

  if (typeof window === "undefined" || typeof window.requestAnimationFrame !== "function") {
    applySettingsPaneIcon(host, iconId);
    return;
  }

  host.settingsPaneIconSyncScheduled = true;
  window.requestAnimationFrame(() => {
    host.settingsPaneIconSyncScheduled = false;
    applySettingsPaneIcon(host, iconId);
  });
}

function applySettingsPaneIcon(host: any, iconId: string): void {
  const pluginName = host.manifest.name.trim();
  if (!pluginName) {
    return;
  }

  const matchedItems = new Set<HTMLElement>();
  for (const selector of [
    `.vertical-tab-nav-item[data-tab-id="${host.manifest.id}"]`,
    `.vertical-tab-nav-item[data-tab-id="community-plugins-${host.manifest.id}"]`
  ]) {
    for (const matchedEl of Array.from(document.querySelectorAll<HTMLElement>(selector))) {
      matchedItems.add(matchedEl);
    }
  }

  if (matchedItems.size === 0) {
    for (const itemEl of Array.from(document.querySelectorAll<HTMLElement>(".vertical-tab-nav-item"))) {
      const titleEl = itemEl.querySelector<HTMLElement>(".vertical-tab-nav-item-title");
      if (titleEl?.textContent?.trim() !== pluginName) {
        continue;
      }
      matchedItems.add(itemEl);
    }
  }

  for (const itemEl of matchedItems) {
    itemEl.classList.add("mod-has-icon");

    let iconContainer = itemEl.querySelector<HTMLElement>(".vertical-tab-nav-item-icon");
    if (!iconContainer) {
      iconContainer = document.createElement("div");
      iconContainer.className = "vertical-tab-nav-item-icon";
      itemEl.prepend(iconContainer);
    }

    itemEl.classList.add("chats2md-settings-nav-item");
    setIcon(iconContainer, iconId);
  }
}
