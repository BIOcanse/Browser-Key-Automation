interface ChromeInstalledDetails {
  readonly reason: "install" | "update" | "chrome_update" | "shared_module_update";
  readonly previousVersion?: string;
}

interface ChromeManifestDescriptor {
  readonly name: string;
  readonly version: string;
}

interface ChromeTab {
  readonly id?: number;
  readonly index: number;
  readonly windowId: number;
  readonly active: boolean;
  readonly highlighted: boolean;
  readonly pinned: boolean;
  readonly incognito: boolean;
  readonly status?: "loading" | "complete" | "unloaded";
  readonly title?: string;
  readonly url?: string;
  readonly pendingUrl?: string;
  readonly audible?: boolean;
  readonly discarded?: boolean;
  readonly autoDiscardable?: boolean;
  readonly mutedInfo?: { readonly muted: boolean };
}

interface ChromeWindow {
  readonly id?: number;
  readonly focused: boolean;
  readonly state?: "normal" | "minimized" | "maximized" | "fullscreen" | "locked-fullscreen";
  readonly left?: number;
  readonly top?: number;
  readonly width?: number;
  readonly height?: number;
}

interface ChromeMessageSender {
  readonly id?: string;
  readonly url?: string;
  readonly tab?: ChromeTab;
  readonly frameId?: number;
  readonly documentId?: string;
}

interface ChromeInjectionTarget {
  readonly tabId: number;
  readonly allFrames?: boolean;
  readonly documentIds?: readonly string[];
  readonly frameIds?: readonly number[];
}

interface ChromeScriptingInjectionResult<T = unknown> {
  readonly documentId: string;
  readonly frameId: number;
  readonly result?: T;
}

interface ChromeWebNavigationFrame {
  readonly frameId: number;
  readonly parentFrameId: number;
  readonly url: string;
  readonly errorOccurred?: boolean;
  readonly documentId?: string;
  readonly documentLifecycle?: string;
}

interface ChromeDebuggerTarget {
  readonly tabId: number;
  readonly sessionId?: string;
}

interface ChromeDownloadItem {
  readonly id: number; readonly url: string; readonly finalUrl: string; readonly filename: string; readonly mime: string;
  readonly state: "in_progress" | "interrupted" | "complete"; readonly paused: boolean; readonly canResume: boolean;
  readonly danger: string; readonly error?: string; readonly bytesReceived: number; readonly totalBytes: number;
  readonly fileSize: number; readonly exists: boolean; readonly startTime: string; readonly endTime?: string;
}

interface ChromeBookmarkNode {
  readonly id: string; readonly title: string; readonly parentId?: string; readonly index?: number; readonly url?: string;
  readonly dateAdded?: number; readonly dateGroupModified?: number; readonly dateLastUsed?: number;
  readonly folderType?: "bookmarks-bar" | "other" | "mobile" | "managed"; readonly syncing: boolean;
  readonly unmodifiable?: "managed"; readonly children?: readonly ChromeBookmarkNode[];
}

interface ChromeHistoryItem {
  readonly id: string; readonly url?: string; readonly title?: string; readonly lastVisitTime?: number;
  readonly visitCount?: number; readonly typedCount?: number;
}

interface ChromeHistoryVisit {
  readonly id: string; readonly visitId: string; readonly referringVisitId: string; readonly transition: string;
  readonly isLocal: boolean; readonly visitTime?: number;
}

type ChromeUserScriptInjectionResult<T = unknown> =
  | {
      readonly documentId: string;
      readonly frameId: number;
      readonly error: string;
      readonly result?: never;
    }
  | {
      readonly documentId: string;
      readonly frameId: number;
      readonly error?: never;
      readonly result?: T;
    };

interface ChromeRuntimePort {
  readonly name: string;
  readonly sender?: ChromeMessageSender;
  readonly onMessage: {
    addListener(callback: (message: unknown) => void): void;
  };
  readonly onDisconnect: {
    addListener(callback: () => void): void;
  };
  postMessage(message: unknown): void;
  disconnect(): void;
}

declare const chrome: {
  readonly bookmarks?: {
    get(id: string): Promise<ChromeBookmarkNode[]>;
    getTree(): Promise<ChromeBookmarkNode[]>;
    getChildren(id: string): Promise<ChromeBookmarkNode[]>;
    search(query: string): Promise<ChromeBookmarkNode[]>;
    create(details: {readonly parentId?: string; readonly index?: number; readonly title: string; readonly url?: string}): Promise<ChromeBookmarkNode>;
    update(id: string, changes: {readonly title?: string; readonly url?: string}): Promise<ChromeBookmarkNode>;
    move(id: string, destination: {readonly parentId?: string; readonly index?: number}): Promise<ChromeBookmarkNode>;
    remove(id: string): Promise<void>; removeTree(id: string): Promise<void>;
  };
  readonly history?: {
    search(query: {readonly text: string; readonly startTime: number; readonly endTime: number; readonly maxResults: number}): Promise<ChromeHistoryItem[]>;
    getVisits(details: {readonly url: string}): Promise<ChromeHistoryVisit[]>;
    addUrl(details: {readonly url: string}): Promise<void>;
    deleteUrl(details: {readonly url: string}): Promise<void>;
    deleteRange(range: {readonly startTime: number; readonly endTime: number}): Promise<void>;
    deleteAll(): Promise<void>;
  };
  readonly downloads?: {
    download(options: {readonly url: string; readonly filename: string; readonly saveAs: boolean; readonly conflictAction: "uniquify" | "overwrite"}): Promise<number>;
    search(query: {readonly id?: number; readonly query?: readonly string[]; readonly limit?: number; readonly orderBy?: readonly string[]; readonly startedBefore?: string}): Promise<ChromeDownloadItem[]>;
    pause(id: number): Promise<void>; resume(id: number): Promise<void>; cancel(id: number): Promise<void>;
    readonly onChanged: {
      addListener(callback: (delta: {readonly id: number}) => void): void;
      removeListener(callback: (delta: {readonly id: number}) => void): void;
    };
  };
  readonly debugger?: {
    attach(target: { readonly tabId: number }, requiredVersion: string): Promise<void>;
    detach(target: { readonly tabId: number }): Promise<void>;
    sendCommand(target: ChromeDebuggerTarget, method: string, params?: Readonly<Record<string, unknown>>): Promise<unknown>;
    readonly onEvent: {
      addListener(callback: (source: { readonly tabId?: number; readonly sessionId?: string }, method: string, params?: Record<string, unknown>) => void): void;
    };
    readonly onDetach: {
      addListener(callback: (source: { readonly tabId?: number }, reason: string) => void): void;
    };
  };
  readonly runtime: {
    readonly id: string;
    readonly onInstalled: {
      addListener(callback: (details: ChromeInstalledDetails) => void): void;
    };
    readonly onStartup: {
      addListener(callback: () => void): void;
    };
    readonly onConnect: {
      addListener(callback: (port: ChromeRuntimePort) => void): void;
    };
    readonly onMessage: {
      addListener(
        callback: (
          message: unknown,
          sender: ChromeMessageSender,
          sendResponse: (response?: unknown) => void,
        ) => boolean | void,
      ): void;
    };
    connect(connectInfo: { readonly name: string }): ChromeRuntimePort;
    sendMessage(message: unknown): Promise<unknown>;
    getManifest(): ChromeManifestDescriptor;
    getURL(path: string): string;
    openOptionsPage(): Promise<void>;
  };
  readonly action: {
    readonly onClicked: {
      addListener(callback: (tab: ChromeTab) => void): void;
    };
  };
  readonly offscreen: {
    hasDocument(): Promise<boolean>;
    createDocument(options: {
      readonly url: string;
      readonly reasons: readonly ["WORKERS"];
      readonly justification: string;
    }): Promise<void>;
  };
  readonly storage: {
    readonly session: {
      get(key: string | null): Promise<Record<string, unknown>>;
      set(items: Readonly<Record<string, unknown>>): Promise<void>;
      remove(keys: string | readonly string[]): Promise<void>;
      setAccessLevel(options: { readonly accessLevel: "TRUSTED_CONTEXTS" }): Promise<void>;
    };
  };
  readonly scripting: {
    executeScript(injection: {
      readonly target: ChromeInjectionTarget;
      readonly files: readonly string[];
      readonly world?: "ISOLATED" | "MAIN";
      readonly injectImmediately?: boolean;
    }): Promise<ChromeScriptingInjectionResult[]>;
    executeScript<T, Args extends readonly unknown[]>(injection: {
      readonly target: ChromeInjectionTarget;
      readonly func: (...args: Args) => T | Promise<T>;
      readonly args?: Args;
      readonly world?: "ISOLATED" | "MAIN";
      readonly injectImmediately?: boolean;
    }): Promise<ChromeScriptingInjectionResult<Awaited<T>>[]>;
  };
  readonly permissions?: {
    contains(permissions: { readonly origins: readonly string[] }): Promise<boolean>;
  };
  readonly userScripts?: {
    getScripts(): Promise<readonly unknown[]>;
    execute<T = unknown>(injection: {
      readonly target: ChromeInjectionTarget;
      readonly js: readonly [{ readonly code: string }];
      readonly world?: "MAIN" | "USER_SCRIPT";
      readonly worldId?: string;
      readonly injectImmediately?: boolean;
    }): Promise<ChromeUserScriptInjectionResult<T>[]>;
  };
  readonly tabs: {
    query(queryInfo: Readonly<Record<string, never>>): Promise<ChromeTab[]>;
    get(tabId: number): Promise<ChromeTab>;
    create(createProperties: {
      readonly url: string;
      readonly active: boolean;
      readonly windowId?: number;
    }): Promise<ChromeTab>;
    update(tabId: number, updateProperties: { readonly url?: string; readonly active?: boolean }): Promise<ChromeTab>;
    reload(tabId: number, reloadProperties: { readonly bypassCache: boolean }): Promise<void>;
    remove(tabId: number): Promise<void>;
    getZoom(tabId: number): Promise<number>;
    setZoom(tabId: number, zoomFactor: number): Promise<void>;
    captureVisibleTab(
      windowId: number,
      options: { readonly format: "jpeg" | "png"; readonly quality: number },
    ): Promise<string>;
    readonly onRemoved: {
      addListener(callback: (tabId: number) => void): void;
    };
    readonly onReplaced: {
      addListener(callback: (addedTabId: number, removedTabId: number) => void): void;
    };
    readonly onActivated: {
      addListener(callback: (info: { readonly tabId: number; readonly windowId: number }) => void): void;
    };
    readonly onZoomChange?: { addListener(callback: (info: { readonly tabId: number; readonly oldZoomFactor: number; readonly newZoomFactor: number }) => void): void };
    readonly onCreated: { addListener(callback: (tab: ChromeTab) => void): void };
    readonly onDetached: { addListener(callback: (tabId: number, info: { readonly oldWindowId: number; readonly oldPosition: number }) => void): void };
    readonly onAttached: { addListener(callback: (tabId: number, info: { readonly newWindowId: number; readonly newPosition: number }) => void): void };
  };
  readonly windows: {
    get(windowId: number): Promise<ChromeWindow>;
    getLastFocused(): Promise<ChromeWindow>;
    update(windowId: number, updateInfo: {
      readonly focused?: boolean;
      readonly state?: "normal" | "minimized" | "maximized" | "fullscreen";
      readonly left?: number;
      readonly top?: number;
      readonly width?: number;
      readonly height?: number;
    }): Promise<ChromeWindow>;
    readonly onRemoved: { addListener(callback: (windowId: number) => void): void };
    readonly onBoundsChanged?: { addListener(callback: (window: ChromeWindow) => void): void };
  };
  readonly pageCapture: {
    saveAsMHTML(details: { readonly tabId: number }): Promise<Blob | undefined>;
  };
  readonly webNavigation: {
    getAllFrames(details: { readonly tabId: number }): Promise<ChromeWebNavigationFrame[]>;
    readonly onCommitted: {
      addListener(callback: (details: { readonly tabId: number; readonly frameId: number; readonly documentId: string; readonly url?: string; readonly transitionType?: string; readonly transitionQualifiers?: readonly string[] }) => void): void;
    };
    readonly onHistoryStateUpdated?: { addListener(callback: (details: { readonly tabId: number; readonly frameId: number; readonly documentId: string; readonly url: string; readonly transitionType?: string; readonly transitionQualifiers?: readonly string[] }) => void): void };
    readonly onReferenceFragmentUpdated?: { addListener(callback: (details: { readonly tabId: number; readonly frameId: number; readonly documentId: string; readonly url: string; readonly transitionType?: string; readonly transitionQualifiers?: readonly string[] }) => void): void };
  };
};
