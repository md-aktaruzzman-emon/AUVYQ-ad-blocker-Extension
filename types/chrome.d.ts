/*
 * Minimal, deliberately narrow typings for the Chrome extension API surface AUVYQ uses.
 * Anything not used by the implementation is intentionally absent.
 */
declare namespace chrome {
  interface Event<Cb extends (...args: never[]) => unknown> {
    addListener(cb: Cb): void;
    removeListener(cb: Cb): void;
    hasListener(cb: Cb): boolean;
  }

  namespace runtime {
    interface MessageSender {
      tab?: { id?: number | undefined; url?: string | undefined; incognito?: boolean | undefined };
      id?: string | undefined;
      url?: string | undefined;
      origin?: string | undefined;
    }
    interface OnInstalledDetails {
      reason: 'install' | 'update' | 'chrome_update' | 'shared_module_update';
      previousVersion?: string;
    }
    interface ManifestV3 {
      version: string;
      manifest_version: number;
      name: string;
    }
    const onInstalled: Event<(details: OnInstalledDetails) => void>;
    const onStartup: Event<() => void>;
    const onMessage: Event<(
      message: unknown,
      sender: MessageSender,
      sendResponse: (response?: unknown) => void
    ) => boolean | void>;
    function sendMessage(message: unknown): Promise<unknown>;
    function getURL(path: string): string;
    function getManifest(): ManifestV3;
    const id: string;
  }

  namespace storage {
    interface StorageChange {
      oldValue?: unknown;
      newValue?: unknown;
    }
    interface StorageArea {
      get(keys?: string | string[] | Record<string, unknown> | null): Promise<Record<string, unknown>>;
      set(items: Record<string, unknown>): Promise<void>;
      remove(keys: string | string[]): Promise<void>;
      clear(): Promise<void>;
    }
    const local: StorageArea;
    const session: StorageArea;
    const onChanged: Event<(changes: Record<string, StorageChange>, areaName: string) => void>;
  }

  namespace tabs {
    interface Tab {
      id?: number;
      url?: string;
      pendingUrl?: string;
      title?: string;
      active?: boolean;
      windowId?: number;
      index?: number;
      incognito?: boolean;
    }
    function query(queryInfo: { active?: boolean; currentWindow?: boolean; url?: string[] }): Promise<Tab[]>;
    function get(tabId: number): Promise<Tab>;
    function create(createProperties: { url: string; active?: boolean }): Promise<Tab>;
    function update(tabId: number, updateProperties: { url?: string; active?: boolean }): Promise<Tab>;
    function sendMessage(tabId: number, message: unknown): Promise<unknown>;
    const onRemoved: Event<(tabId: number, removeInfo: { windowId: number; isWindowClosing: boolean }) => void>;
    const onUpdated: Event<(tabId: number, changeInfo: { url?: string; status?: string }, tab: Tab) => void>;
  }

  namespace alarms {
    interface Alarm {
      name: string;
      scheduledTime: number;
      periodInMinutes?: number;
    }
    function create(name: string, alarmInfo: { when?: number; delayInMinutes?: number; periodInMinutes?: number }): void;
    function clear(name: string): Promise<boolean>;
    function getAll(): Promise<Alarm[]>;
    const onAlarm: Event<(alarm: Alarm) => void>;
  }

  namespace webRequest {
    interface WebRequestDetails {
      requestId: string;
      url: string;
      initiator?: string;
      tabId: number;
      type: string;
      frameId?: number;
      timeStamp: number;
    }
    interface WebRequestFilter {
      urls: string[];
      types?: string[];
      tabId?: number;
      windowId?: number;
    }
    interface WebRequestEvent {
      addListener(cb: (details: WebRequestDetails) => void, filter?: WebRequestFilter): void;
      removeListener(cb: (details: WebRequestDetails) => void): void;
      hasListener(cb: (details: WebRequestDetails) => void): boolean;
    }
    const onBeforeRequest: WebRequestEvent;
  }

  namespace declarativeNetRequest {
    type ResourceType =
      | 'main_frame' | 'sub_frame' | 'stylesheet' | 'script' | 'image' | 'font'
      | 'object' | 'xmlhttprequest' | 'ping' | 'csp_report' | 'media'
      | 'websocket' | 'webtransport' | 'webbundle' | 'other';

    interface QueryTransform { removeParams?: string[]; }
    interface URLTransform { queryTransform?: QueryTransform; }
    interface Redirect { url?: string; extensionPath?: string; transform?: URLTransform; }
    interface RuleAction {
      type: 'block' | 'allow' | 'redirect' | 'upgradeScheme' | 'modifyHeaders' | 'allowAllRequests';
      redirect?: Redirect;
    }
    interface RuleCondition {
      urlFilter?: string;
      regexFilter?: string;
      requestDomains?: string[];
      excludedRequestDomains?: string[];
      initiatorDomains?: string[];
      excludedInitiatorDomains?: string[];
      domainType?: 'firstParty' | 'thirdParty';
      resourceTypes?: ResourceType[];
      tabIds?: number[];
      excludedTabIds?: number[];
    }
    interface Rule {
      id: number;
      priority?: number;
      action: RuleAction;
      condition: RuleCondition;
    }
    interface MatchedRuleInfo {
      requestId: string;
      rule: Rule;
      tabId?: number;
      url: string;
      initiator?: string;
    }
    function getDynamicRules(): Promise<Rule[]>;
    function updateDynamicRules(options: { addRules?: Rule[]; removeRuleIds?: number[] }): Promise<void>;
    function getSessionRules(): Promise<Rule[]>;
    function updateSessionRules(options: { addRules?: Rule[]; removeRuleIds?: number[] }): Promise<void>;
    function updateEnabledRulesets(options: { enableRulesetIds?: string[]; disableRulesetIds?: string[] }): Promise<void>;
    function setExtensionActionOptions(options: { displayActionCountAsBadgeText?: boolean }): Promise<void>;
    const onRuleMatchedDebug: Event<(info: MatchedRuleInfo) => void>;
  }

  namespace scripting {
    interface ExecutionTarget { tabId: number; frameIds?: number[]; allFrames?: boolean; }
    interface InjectionResult { result?: unknown; error?: { message: string }; }
    function executeScript<Args extends unknown[]>(injection: {
      target: ExecutionTarget;
      world?: 'ISOLATED' | 'MAIN';
      injectImmediately?: boolean;
      func: (...args: Args) => unknown;
      args?: Args;
    }): Promise<InjectionResult[]>;
    function insertCSS(injection: { target: ExecutionTarget; css: string; origin?: 'AUTHOR' | 'USER' }): Promise<void>;
    function removeCSS(injection: { target: ExecutionTarget; css: string }): Promise<void>;
    interface RegisteredContentScript {
      id: string;
      matches: string[];
      js?: string[];
      runAt?: 'document_start' | 'document_end' | 'document_idle';
      world?: 'ISOLATED' | 'MAIN';
      persistAcrossSessions?: boolean;
    }
    function registerContentScripts(scripts: RegisteredContentScript[]): Promise<void>;
    function unregisterContentScripts(filter?: { ids?: string[] }): Promise<void>;
    function getRegisteredContentScripts(): Promise<RegisteredContentScript[]>;
  }

  namespace webNavigation {
    interface OnCommittedDetails {
      tabId: number;
      url: string;
      frameId: number;
      transitionType: string;
      transitionQualifiers?: string[];
    }
    const onCommitted: Event<(details: OnCommittedDetails) => void>;
  }

  namespace cookies {
    interface Cookie {
      name: string;
      domain: string;
      path: string;
      value: string;
      expirationDate?: number;
      secure?: boolean;
      storeId?: string;
    }
    interface CookieChangeInfo {
      removed: boolean;
      cookie: Cookie;
      cause?: string;
    }
    function getAll(details: { url?: string; domain?: string }): Promise<Cookie[]>;
    function remove(details: { url?: string; name: string; domain?: string; path?: string; storeId?: string }): Promise<void>;
    const onChanged: Event<(changeInfo: CookieChangeInfo) => void>;
  }

  namespace offscreen {
    type Reason = 'BLOBS' | 'DOM_PARSER' | 'DOM_SCRAPING';
    function createDocument(parameters: { url: string; reasons: Reason[]; justification: string }): Promise<void>;
    function closeDocument(): Promise<void>;
    function hasDocument(): Promise<boolean>;
  }

  namespace action {
    function setBadgeText(details: { text: string; tabId?: number }): Promise<void>;
    function setBadgeBackgroundColor(details: { color: string; tabId?: number }): Promise<void>;
    function setTitle(details: { title: string; tabId?: number }): Promise<void>;
  }

  namespace i18n {
    function getMessage(name: string): string;
  }
}
