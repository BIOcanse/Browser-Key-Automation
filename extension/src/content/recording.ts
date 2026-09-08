// Classic isolated-world script. It observes only after an explicit start and never dispatches page input.
(() => {
  interface Config { readonly recordingId: string; readonly maximumPending: number; readonly maximumBatch: number; readonly maximumText: number; readonly maximumDepth: number; readonly maximumShadowRoots: number; readonly maximumScanNodes: number; readonly flushIntervalMs: number }
  interface RawEvent { readonly documentSequence: number; readonly at: number; readonly gesture: number; readonly kind: string; readonly [key: string]: unknown }
  interface Locator { readonly selector: string; readonly shadowPath: readonly string[]; readonly role: null; readonly name: null; readonly nameMatch: "exact"; readonly match: "unique" }
  interface State { config: Config; collecting: boolean; sequence: number; gesture: number; lost: number; pending: RawEvent[]; sent: number; terminal: string | null }
  interface Recorder { start(config: Config): unknown; control(recordingId: string, operation: "pause" | "resume" | "stop" | "read"): Promise<unknown> }
  const globals = globalThis as typeof globalThis & { __BKA_RECORDER_V1__?: Recorder };
  if (globals.__BKA_RECORDER_V1__ !== undefined) return;
  let state: State | null = null, timer: ReturnType<typeof setInterval> | null = null, sending: Promise<void> | null = null;
  let listeners: AbortController | null = null;
  let mutations: MutationObserver | null = null;
  const shadowRoots = new Set<ShadowRoot>(), observedEvents = new WeakSet<Event>();
  let pointer: { target: Element; locator: Locator; x: number; y: number; fromOffset: {x:number;y:number}; points: {x: number; y: number}[]; html5: boolean } | null = null;
  let composing: Element | null = null, compositionSerial = 0, suppressClick = false, forwardedControl: Element | null = null;
  const unfinished = () => [...(pointer === null ? [] : ["UNFINISHED_POINTER"]), ...(composing === null ? [] : ["UNFINISHED_COMPOSITION"])];
  const snapshot = () => state === null ? null : { recordingId: state.config.recordingId, collecting: state.collecting, capturedThrough: state.sequence, sentThrough: state.sent, lost: state.lost, terminal: state.terminal, unfinished: unfinished(), pending: [...state.pending] };
  const endTimer = () => { if (timer !== null) clearInterval(timer); timer = null; };
  function emit(kind: string, data: Record<string, unknown> = {}): void {
    if (state === null || !state.collecting) return;
    if (state.pending.length >= state.config.maximumPending) { state.lost += 1; state.collecting = false; state.terminal = "BUFFER_OVERFLOW"; return; }
    state.pending.push({ ...data, kind, documentSequence: ++state.sequence, at: performance.timeOrigin + performance.now(), gesture: state.gesture });
    if (state.pending.length >= state.config.maximumBatch) void flush();
  }
  async function flush(): Promise<void> {
    if (sending !== null) return sending;
    const current = state;
    if (current === null || current.pending.length === 0 && current.lost === 0) return;
    const batch = current.pending.slice(0, current.config.maximumBatch);
    const operation = (async () => {
      try {
        const response = await chrome.runtime.sendMessage({ kind: "recording.events", recordingId: current.config.recordingId, events: batch, lost: current.lost });
        if (typeof response !== "object" || response === null || (response as {ok?: unknown}).ok !== true ||
          !Number.isSafeInteger((response as {acceptedThrough?: unknown}).acceptedThrough)) throw new Error("Recording acknowledgement unavailable");
        const through = (response as {acceptedThrough: number}).acceptedThrough;
        if (batch.length > 0 && through < batch[batch.length - 1]!.documentSequence) throw new Error("Recording acknowledgement incomplete");
        current.pending = current.pending.filter((event) => event.documentSequence > through); current.sent = through;
        if ((response as {continueRecording?: unknown}).continueRecording === false) { current.collecting = false; endTimer(); }
        if (current.lost > 0) { current.collecting = false; endTimer(); }
      } catch { current.collecting = false; current.terminal ??= "CHANNEL_INTERRUPTED"; endTimer(); }
    })();
    sending = operation;
    try { await operation; } finally { if (sending === operation) sending = null; }
  }
  function selector(element: Element): string {
    const config = state!.config, root = element.getRootNode() as Document | ShadowRoot;
    for (const attribute of ["id", "data-testid", "data-test", "name"]) {
      const value = element.getAttribute(attribute);
      if (value === null || value.length === 0 || value.length > config.maximumText) continue;
      const candidate = `[${attribute}="${CSS.escape(value)}"]`;
      if (root.querySelectorAll(candidate).length === 1) return candidate;
    }
    const path: string[] = [];
    let current: Element | null = element, depth = 0;
    while (current !== null) {
      if (++depth > config.maximumDepth) throw new Error("LOCATOR_DEPTH_LIMIT");
      let ordinal = 1, sibling = current.previousElementSibling;
      while (sibling !== null) { if (sibling.localName === current.localName) ordinal += 1; sibling = sibling.previousElementSibling; }
      path.unshift(`${CSS.escape(current.localName)}:nth-of-type(${ordinal})`);
      current = current.parentElement;
    }
    const result = path.join(" > ");
    if (result.length > config.maximumText) throw new Error("LOCATOR_TEXT_LIMIT");
    return result;
  }
  function locator(element: Element): Locator {
    const shadowPath: string[] = [];
    let scope = element.getRootNode(), depth = 0;
    while (scope instanceof ShadowRoot) {
      if (++depth > state!.config.maximumDepth) throw new Error("SHADOW_DEPTH_LIMIT");
      shadowPath.unshift(selector(scope.host)); scope = scope.host.getRootNode();
    }
    return { selector: selector(element), shadowPath, role: null, name: null, nameMatch: "exact", match: "unique" };
  }
  function element(event: Event): Element | null {
    const target = event.composedPath()[0];
    return target instanceof Element ? target : target === document ? document.scrollingElement : target instanceof Node ? target.parentElement : null;
  }
  function text(value: string): string {
    if (value.length > state!.config.maximumText) throw new Error("TEXT_LIMIT");
    return value;
  }
  function editable(target: Element, event: Event, commit: boolean): void {
    if (target instanceof HTMLSelectElement) {
      if (commit) emit("select", { target: locator(target), values: [...target.selectedOptions].map((option) => text(option.value)) });
      return;
    }
    if (target instanceof HTMLInputElement && ["checkbox", "radio", "button", "submit", "reset", "file"].includes(target.type)) {
      if (target.type === "file" && commit) emit("unsupported", { reason: "FILE_SELECTION_REQUIRES_EXPLICIT_FILE_SOURCE", target: locator(target) });
      return;
    }
    if (composing === target && !commit) return;
    let value: string;
    if (target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement) value = target.value;
    else if (target instanceof HTMLElement && target.isContentEditable) {
      value = target.innerText;
      if (target.children.length > 0) emit("unsupported", { reason: "RICH_TEXT_STRUCTURE", target: locator(target) });
    }
    else return;
    emit("input", { target: locator(target), value: text(value), events: commit ? "change" : "input",
      inputType: event instanceof InputEvent ? text(event.inputType) : "insertCompositionText", data: event instanceof InputEvent ? event.data === null ? null : text(event.data) : null,
      contentEditable: target instanceof HTMLElement && target.isContentEditable });
  }
  function observe(event: Event): void {
    if (!event.isTrusted || state === null || !state.collecting) return;
    if (observedEvents.has(event)) return;
    observedEvents.add(event);
    try {
      // Trusted composed input discovers newly attached open roots before its
      // default action can produce a non-composed scroll/change inside them.
      for (const item of event.composedPath()) if (item instanceof ShadowRoot) registerShadowRoot(item);
      const target = element(event);
      if (event.type === "pagehide") {
        for (const reason of unfinished()) emit("unsupported", { reason });
        emit("boundary", { reason: "DOCUMENT_UNLOADING" }); void flush(); return;
      }
      if (target === null) return;
      if (event.type === "compositionstart") { composing = target; compositionSerial++; return; }
      if (event.type === "compositionend") {
        composing = null; const serial = ++compositionSerial;
        queueMicrotask(() => { if (state?.collecting && compositionSerial === serial) { try { editable(target, event, false); } catch (error) { emit("unsupported", { reason: error instanceof Error ? error.message : "INPUT_UNAVAILABLE" }); } } });
        return;
      }
      if (event.type === "input" || event.type === "change") {
        if (event.type === "input" && !(event instanceof InputEvent && event.isComposing)) compositionSerial++;
        editable(target, event, event.type === "change"); return;
      }
      if (event.type === "scroll") { emit("scroll", { target: locator(target), left: target.scrollLeft, top: target.scrollTop }); return; }
      if (event.type === "pointerdown" && event instanceof PointerEvent) {
        state.gesture++; suppressClick = false; forwardedControl = null;
        if (event.button === 0) { const bounds=target.getBoundingClientRect();pointer = { target, locator: locator(target), x: event.clientX, y: event.clientY, fromOffset:{x:event.clientX-bounds.x,y:event.clientY-bounds.y}, points: [], html5: false }; }
        else emit("unsupported", { reason: "NON_PRIMARY_POINTER", target: locator(target), button: event.button });
        return;
      }
      if (event.type === "pointermove" && event instanceof PointerEvent && pointer !== null) {
        if (pointer.points.length >= state.config.maximumPending) { emit("unsupported", { reason: "DRAG_PATH_LIMIT" }); pointer = null; }
        else pointer.points.push({x:event.clientX,y:event.clientY});
        return;
      }
      if (event.type === "dragstart" && pointer !== null) {
        pointer.html5 = true; const started = pointer;
        queueMicrotask(() => { if (state?.collecting && pointer === started && event.defaultPrevented) { emit("unsupported", { reason: "CANCELED_HTML5_DRAG" }); pointer = null; } });
        return;
      }
      if ((event.type === "pointerup" || event.type === "drop") && event instanceof MouseEvent && pointer !== null) {
        if (pointer.html5 && event.type !== "drop") return;
        const moved = Math.hypot(event.clientX - pointer.x, event.clientY - pointer.y) > 4;
        if (moved || pointer.html5) {
          const to = target.getBoundingClientRect();
          emit("drag", { from: pointer.locator, to: locator(target), mode: pointer.html5 ? "html5" : "pointer",
            fromOffset:pointer.fromOffset,toOffset:{x:event.clientX-to.x,y:event.clientY-to.y},fromClient:{x:pointer.x,y:pointer.y},toClient:{x:event.clientX,y:event.clientY},points:pointer.points });
          suppressClick = true;
        }
        pointer = null; return;
      }
      if (event.type === "dragend" || event.type === "pointercancel") {
        if (pointer !== null && (event.type === "dragend" || !pointer.html5)) { emit("unsupported", { reason: pointer.html5 ? "CANCELED_HTML5_DRAG" : "CANCELED_POINTER" }); pointer=null; }
        return;
      }
      if (event.type === "click") {
        if (suppressClick) { suppressClick=false; return; }
        if (target === forwardedControl) { forwardedControl = null; return; }
        if (target instanceof HTMLSelectElement || target instanceof HTMLOptionElement) return;
        const label = target.closest("label");
        if (label instanceof HTMLLabelElement && target !== label.control) forwardedControl = label.control;
        emit("click", { target: locator(target) }); return;
      }
      if (event.type === "focusin") { emit("focus", {target:locator(target)});return; }
      if ((event.type === "pointerover" || event.type === "pointerout") && pointer === null && event instanceof MouseEvent) {
        if (event.relatedTarget instanceof Node && target.contains(event.relatedTarget)) return;
        emit("hover", { target: locator(target), phase: event.type === "pointerover" ? "enter" : "leave" });
      }
    } catch (error) { emit("unsupported", { reason: error instanceof Error ? error.message : "OBSERVATION_UNAVAILABLE" }); }
  }
  const eventTypes = ["click", "focusin", "input", "change", "compositionstart", "compositionend", "scroll", "wheel", "keydown", "pointerdown", "pointermove", "pointerup", "pointerover", "pointerout", "pointercancel", "dragstart", "dragend", "drop", "pagehide"];
  function registerShadowRoot(root: ShadowRoot): void {
    if (listeners === null || shadowRoots.has(root)) return;
    if (shadowRoots.size >= state!.config.maximumShadowRoots) throw new Error("SHADOW_ROOT_LIMIT");
    shadowRoots.add(root);
    for (const type of eventTypes) root.addEventListener(type, observe, { capture: true, passive: true, signal: listeners.signal });
    mutations?.observe(root, { childList: true, subtree: true });
  }
  function scanOpenRoots(roots: readonly Node[]): void {
    const pending = [...roots], visited = new Set<Node>(); let scanned = 0;
    while (pending.length > 0) {
      const root = pending.pop()!;
      if (visited.has(root)) continue;
      visited.add(root);
      const walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT); let current: Node | null = root;
      while (current !== null) {
        if (++scanned > state!.config.maximumScanNodes) throw new Error("SHADOW_SCAN_LIMIT");
        if (current instanceof Element && current.shadowRoot !== null) { registerShadowRoot(current.shadowRoot); pending.push(current.shadowRoot); }
        current = walker.nextNode();
      }
    }
  }
  const removeListeners = () => { listeners?.abort(); listeners = null; mutations?.disconnect(); mutations = null; shadowRoots.clear(); };
  const installListeners = () => {
    if (listeners !== null) return;
    listeners = new AbortController();
    for (const type of eventTypes) addEventListener(type, observe, { capture: true, passive: true, signal: listeners.signal });
    mutations = new MutationObserver((records) => {
      if (!state?.collecting) return;
      const added: Node[] = [];
      for (const mutation of records) for (const node of mutation.addedNodes) {
        if (added.length >= state.config.maximumScanNodes) { emit("unsupported", { reason: "SHADOW_SCAN_LIMIT" }); return; }
        added.push(node);
      }
      try { scanOpenRoots(added); } catch (error) { emit("unsupported", { reason: error instanceof Error ? error.message : "SHADOW_SCAN_FAILED" }); }
    });
    mutations.observe(document, { childList: true, subtree: true });
    try { scanOpenRoots([document]); } catch (error) { emit("unsupported", { reason: error instanceof Error ? error.message : "SHADOW_SCAN_FAILED" }); }
  };
  const startTimer = () => { if (timer === null && state !== null) timer=setInterval(()=>{void flush();},state.config.flushIntervalMs); };
  globals.__BKA_RECORDER_V1__ = {
    start(config) {
      if (state?.collecting && state.config.recordingId !== config.recordingId) throw new Error("Another recording owns this document");
      if (state !== null && state.config.recordingId === config.recordingId) return snapshot();
      endTimer(); removeListeners(); state = { config, collecting: true, sequence: 0, gesture: 0, lost: 0, pending: [], sent: 0, terminal: null };
      pointer = null; composing = null; suppressClick = false; forwardedControl = null;
      installListeners(); startTimer(); emit("boundary", { reason: "DOCUMENT_ATTACHED", url: location.href });
      return snapshot();
    },
    async control(recordingId, operation) {
      if (state === null || state.config.recordingId !== recordingId) return null;
      if (operation === "read") return snapshot();
      if (operation === "resume") {
        if (state.terminal !== null) throw new Error(state.terminal);
        state.collecting = true; installListeners(); startTimer(); return snapshot();
      }
      const incomplete = unfinished();
      for (const reason of incomplete) emit("unsupported", { reason });
      state.collecting = false; endTimer(); removeListeners();
      pointer = null; composing = null; compositionSerial++; suppressClick = false; forwardedControl = null;
      const maximumBatches = Math.ceil(state.config.maximumPending / state.config.maximumBatch) + 1;
      for (let batch = 0; batch < maximumBatches && state.pending.length > 0; batch += 1) {
        const before = state.pending.length; await flush(); if (state.pending.length === before) break;
      }
      return { ...snapshot(), unfinished: incomplete };
    },
  };
})();
