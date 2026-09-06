interface AdminEntryChromeApi {
  readonly action: {
    readonly onClicked: {
      addListener(callback: () => void): void;
    };
  };
  readonly runtime: {
    openOptionsPage(): Promise<void>;
  };
}

export function attachAdminEntry(chromeApi: AdminEntryChromeApi = chrome): void {
  chromeApi.action.onClicked.addListener(() => {
    void chromeApi.runtime.openOptionsPage().catch((error: unknown) => {
      console.error("Failed to open Browser Key Automation admin page", error);
    });
  });
}

interface WelcomeEntryChromeApi {
  readonly runtime: { getURL(path: string): string };
  readonly tabs: { create(properties: { readonly url: string; readonly active: boolean }): Promise<unknown> };
}

export async function openWelcomeOnInstall(reason: ChromeInstalledDetails["reason"], chromeApi: WelcomeEntryChromeApi = chrome): Promise<boolean> {
  if (reason !== "install") return false;
  await chromeApi.tabs.create({ url: chromeApi.runtime.getURL("admin/welcome.html"), active: true });
  return true;
}
