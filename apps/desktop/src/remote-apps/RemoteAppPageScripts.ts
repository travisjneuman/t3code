/**
 * Scripts the shell runs inside a site's page, in an isolated world so the
 * page's own code can neither see nor tamper with them. All are poll-free:
 * they run on a user action or react to DOM mutations the page already makes,
 * and keep no interval.
 */

// Shared by every remote site; each document gets its own copy of the world.
export const REMOTE_APP_PAGE_WORLD_ID = 1_101;

export type RemoteAppActivitySignal = "finished";
export type RemoteAppPromptFillOutcome = "filled" | "input-not-found";

/**
 * Resolves "finished" once the page finishes a reply, then is re-run for the
 * next one; the observer it installs lives as long as the document.
 *
 * Primary rule: one of the site's `generating` selectors (its Stop button)
 * appears, then stays gone for SETTLE_MS. Matching is coalesced to one check
 * per CHECK_MS while the DOM is changing, so a streaming reply costs a few
 * querySelector calls a second, and an idle page costs nothing.
 *
 * Fallback, used only while no `generating` selector has ever matched in this
 * document (a redesign broke them): after a user-initiated send (Enter in an
 * editable, or a click on a send/submit button), at least MIN_HIDDEN_BATCHES
 * mutation batches while the page is hidden, then QUIET_MS without one. The
 * trade-offs, accepted because it only runs when the selectors are stale:
 * - a pause mid-reply (a tool call, a slow search) longer than QUIET_MS badges
 *   early, and the reply keeps streaming after the badge;
 * - a reply that finished before the user left the site never badges, since
 *   only hidden mutations count;
 * - unrelated hidden churn (a live sidebar, an ad) after a send can badge;
 * - hidden pages run timers with about 1s of slack, so the quiet window is
 *   3-4s in practice. The timer is re-armed from mutation callbacks, not from
 *   another timer, so Chromium's intensive wake-up throttling does not apply.
 */
export const buildRemoteAppActivityScript = (generating: ReadonlyArray<string>): string => `(() => {
  const existing = window.__t3codeActivity;
  if (existing) return existing.next();
  const generating = ${JSON.stringify(generating)};
  const CHECK_MS = 250;
  const SETTLE_MS = 1500;
  const QUIET_MS = 3000;
  const MIN_HIDDEN_BATCHES = 20;
  const SEND_WINDOW_MS = 30 * 60 * 1000;
  let waiter = null;
  let pending = null;
  let missed = false;
  const finish = () => {
    if (waiter === null) {
      missed = true;
      return;
    }
    const resolve = waiter;
    waiter = null;
    pending = null;
    resolve("finished");
  };
  const next = () => {
    if (missed) {
      missed = false;
      return Promise.resolve("finished");
    }
    pending ??= new Promise((resolve) => {
      waiter = resolve;
    });
    return pending;
  };
  const matches = (selector) => {
    try {
      return document.querySelector(selector) !== null;
    } catch {
      return false;
    }
  };
  let selectorSeen = false;
  let wasGenerating = false;
  let checkTimer = 0;
  let settleTimer = 0;
  const check = () => {
    checkTimer = 0;
    if (generating.some(matches)) {
      selectorSeen = true;
      wasGenerating = true;
      clearTimeout(settleTimer);
      settleTimer = 0;
      return;
    }
    if (!wasGenerating || settleTimer !== 0) return;
    settleTimer = setTimeout(() => {
      settleTimer = 0;
      if (generating.some(matches)) return;
      wasGenerating = false;
      finish();
    }, SETTLE_MS);
  };
  let sentAt = 0;
  let hiddenBatches = 0;
  let quietTimer = 0;
  const markSend = () => {
    sentAt = Date.now();
    hiddenBatches = 0;
    clearTimeout(quietTimer);
  };
  const onBatch = () => {
    if (generating.length > 0 && checkTimer === 0) checkTimer = setTimeout(check, CHECK_MS);
    if (selectorSeen || sentAt === 0) return;
    if (Date.now() - sentAt > SEND_WINDOW_MS) {
      sentAt = 0;
      return;
    }
    if (document.visibilityState !== "hidden") return;
    hiddenBatches += 1;
    clearTimeout(quietTimer);
    quietTimer = setTimeout(() => {
      if (selectorSeen || sentAt === 0 || hiddenBatches < MIN_HIDDEN_BATCHES) return;
      if (document.visibilityState !== "hidden") return;
      sentAt = 0;
      hiddenBatches = 0;
      finish();
    }, QUIET_MS);
  };
  document.addEventListener("keydown", (event) => {
    if (!event.isTrusted || event.key !== "Enter" || event.shiftKey || event.isComposing) return;
    const target = event.target;
    if (target instanceof HTMLTextAreaElement || (target instanceof HTMLElement && target.isContentEditable)) {
      markSend();
    }
  }, true);
  document.addEventListener("click", (event) => {
    if (!event.isTrusted || !(event.target instanceof Element)) return;
    const send = event.target.closest(
      'button[type="submit"], button[aria-label*="send" i], button[data-testid*="send" i]',
    );
    if (send !== null) markSend();
  }, true);
  new MutationObserver(onBatch).observe(document.documentElement, {
    childList: true,
    subtree: true,
    characterData: true,
    attributes: true,
    attributeFilter: ["aria-label", "data-testid", "disabled"],
  });
  window.__t3codeActivity = { next };
  return next();
})()`;

// How long a fill waits for the prompt box to render on a page still hydrating.
const PROMPT_INPUT_WAIT_MS = 5_000;

/**
 * Finds the site's prompt box, puts the caret at its end, and inserts the
 * text there as typing would, so the site's own editor (React textarea,
 * ProseMirror, Quill) sees ordinary input events. It never presses Enter and
 * never clicks send; the user reviews and submits. Existing draft text is
 * kept, with a blank line before the inserted text.
 */
export const buildRemoteAppPromptFillScript = (
  promptInput: ReadonlyArray<string>,
  text: string,
): string => `(() => new Promise((resolve) => {
  const selectors = ${JSON.stringify(promptInput)};
  const text = ${JSON.stringify(text)};
  const isEditable = (element) =>
    element instanceof HTMLTextAreaElement ||
    (element instanceof HTMLInputElement && element.type === "text") ||
    (element instanceof HTMLElement && element.isContentEditable);
  const find = () => {
    for (const selector of selectors) {
      let candidates = [];
      try {
        candidates = document.querySelectorAll(selector);
      } catch {
        continue;
      }
      for (const element of candidates) {
        if (!isEditable(element) || element.disabled || element.readOnly) continue;
        if (element.getClientRects().length === 0) continue;
        return element;
      }
    }
    return null;
  };
  const fill = (element) => {
    element.focus();
    if (document.activeElement !== element && !element.contains(document.activeElement)) {
      return "input-not-found";
    }
    const control = element instanceof HTMLTextAreaElement || element instanceof HTMLInputElement;
    const current = control ? element.value : element.innerText;
    if (control) {
      element.setSelectionRange(element.value.length, element.value.length);
    } else {
      const range = document.createRange();
      range.selectNodeContents(element);
      range.collapse(false);
      const selection = document.getSelection();
      selection?.removeAllRanges();
      selection?.addRange(range);
    }
    const insertion = current.trim().length > 0 ? "\\n\\n" + text : text;
    return document.execCommand("insertText", false, insertion) ? "filled" : "input-not-found";
  };
  const found = find();
  if (found !== null) {
    resolve(fill(found));
    return;
  }
  let timer = 0;
  const observer = new MutationObserver(() => {
    const element = find();
    if (element === null) return;
    observer.disconnect();
    clearTimeout(timer);
    resolve(fill(element));
  });
  observer.observe(document.documentElement, { childList: true, subtree: true });
  timer = setTimeout(() => {
    observer.disconnect();
    resolve("input-not-found");
  }, ${PROMPT_INPUT_WAIT_MS});
}))()`;

const NOTICE_DURATION_MS = 6_000;
const ACTION_NOTICE_DURATION_MS = 12_000;

const NOTICE_STYLE = [
  "position:fixed",
  "left:50%",
  "bottom:24px",
  "transform:translateX(-50%)",
  "z-index:2147483647",
  "display:flex",
  "align-items:center",
  "gap:12px",
  "max-width:min(480px,calc(100vw - 32px))",
  "padding:10px 14px",
  "border-radius:10px",
  "background:rgba(24,24,27,0.94)",
  "color:#fafafa",
  "font:500 13px/1.4 -apple-system,BlinkMacSystemFont,'Segoe UI',system-ui,sans-serif",
  "box-shadow:0 12px 32px -12px rgba(0,0,0,0.6)",
].join(";");

const NOTICE_BUTTON_STYLE = [
  "flex:none",
  "padding:4px 10px",
  "border:1px solid rgba(250,250,250,0.3)",
  "border-radius:6px",
  "background:transparent",
  "color:inherit",
  "font:inherit",
  "cursor:pointer",
].join(";");

/**
 * Shows a short, static notice at the bottom of the site's page; the T3
 * renderer's own toasts sit beneath the site's view and would go unseen. It
 * lives in a closed shadow root so neither page styles nor page scripts reach
 * it, and removes itself. Resolves true once it is on the page.
 */
export const buildRemoteAppNoticeScript = (message: string): string => `(() => {
  document.getElementById("t3code-remote-app-notice")?.remove();
  const host = document.createElement("div");
  host.id = "t3code-remote-app-notice";
  const root = host.attachShadow({ mode: "closed" });
  const notice = document.createElement("div");
  notice.setAttribute("role", "status");
  notice.textContent = ${JSON.stringify(message)};
  notice.style.cssText = ${JSON.stringify(`${NOTICE_STYLE};pointer-events:none`)};
  root.append(notice);
  document.documentElement.append(host);
  setTimeout(() => host.remove(), ${NOTICE_DURATION_MS});
  return true;
})()`;

export type RemoteAppActionNoticeOutcome = "action" | "ignored";

/**
 * The notice above with one button. Resolves "action" on a trusted click of
 * the button, or "ignored" when it times out, is replaced by another notice,
 * or the page is hidden because the user switched away. Like the plain notice
 * it is static and poll-free: one timer and two listeners, all removed with it.
 */
export const buildRemoteAppActionNoticeScript = (
  message: string,
  action: string,
): string => `(() => new Promise((resolve) => {
  document.getElementById("t3code-remote-app-notice")?.remove();
  const host = document.createElement("div");
  host.id = "t3code-remote-app-notice";
  const root = host.attachShadow({ mode: "closed" });
  const notice = document.createElement("div");
  notice.setAttribute("role", "status");
  notice.style.cssText = ${JSON.stringify(NOTICE_STYLE)};
  const text = document.createElement("span");
  text.textContent = ${JSON.stringify(message)};
  const button = document.createElement("button");
  button.type = "button";
  button.textContent = ${JSON.stringify(action)};
  button.style.cssText = ${JSON.stringify(NOTICE_BUTTON_STYLE)};
  notice.append(text, button);
  root.append(notice);
  let timer = 0;
  const finish = (outcome) => {
    clearTimeout(timer);
    document.removeEventListener("visibilitychange", onHidden);
    observer.disconnect();
    host.remove();
    resolve(outcome);
  };
  const onHidden = () => {
    if (document.visibilityState === "hidden") finish("ignored");
  };
  // A newer notice removes this host; settle instead of waiting for the timer.
  const observer = new MutationObserver(() => {
    if (!host.isConnected) finish("ignored");
  });
  button.addEventListener("click", (event) => {
    if (event.isTrusted) finish("action");
  });
  document.addEventListener("visibilitychange", onHidden);
  document.documentElement.append(host);
  observer.observe(document.documentElement, { childList: true });
  timer = setTimeout(() => finish("ignored"), ${ACTION_NOTICE_DURATION_MS});
}))()`;

/** Longest a caller should wait on an action notice before treating it as ignored. */
export const REMOTE_APP_ACTION_NOTICE_TIMEOUT_MS = ACTION_NOTICE_DURATION_MS + 2_000;

/**
 * Reads the user's current selection, and nothing else, as a small JSON tree
 * for RemoteAppMarkdown.ts to turn into Markdown. Run only when the user picks
 * a selection action from the context menu.
 *
 * Terms-of-service basis: text the user selected themselves, read on their
 * explicit menu action, the same content a copy would take.
 *
 * Buttons, form controls, media, SVG, and visually hidden text are dropped;
 * images keep their alt text and KaTeX keeps its TeX source. A selection that
 * starts and ends inside a code block, list, table, or quote is rewrapped in
 * that container so its structure survives. Returns null when nothing is
 * selected in this frame or the selection is too large to walk.
 */
export const buildRemoteAppSelectionScript = (): string => `(() => {
  const MAX_NODES = 50000;
  const MAX_DEPTH = 64;
  const MAX_TEXT = 2000000;
  const SKIP = new Set([
    "script", "style", "noscript", "template", "svg", "button", "textarea", "select",
    "canvas", "video", "audio", "iframe", "object", "embed", "head",
  ]);
  const WRAPPERS = "pre, code, ul, ol, table, thead, tbody, tfoot, tr, blockquote";
  const selection = document.getSelection();
  if (selection === null || selection.rangeCount === 0 || selection.isCollapsed) return null;
  const languageOf = (element) => {
    const candidates = [element, ...element.querySelectorAll("code")];
    for (const candidate of candidates) {
      const match = /(?:^|\\s)(?:language|lang)-([\\w+#.-]+)/i.exec(candidate.className || "");
      if (match) return match[1].toLowerCase();
      const data = candidate.getAttribute("data-language");
      if (data) return data.toLowerCase();
    }
    return undefined;
  };
  const container = document.createElement("div");
  for (let index = 0; index < selection.rangeCount; index += 1) {
    const range = selection.getRangeAt(index);
    const fragment = range.cloneContents();
    const ancestor = range.commonAncestorContainer;
    const element = ancestor.nodeType === 1 ? ancestor : ancestor.parentElement;
    const source = element === null ? null : element.closest(WRAPPERS);
    if (source === null) {
      container.append(fragment);
      continue;
    }
    const wrapper = source.cloneNode(false);
    const language = source.localName === "pre" || source.localName === "code" ? languageOf(source) : undefined;
    if (language) wrapper.setAttribute("data-t3code-language", language);
    wrapper.append(fragment);
    container.append(wrapper);
  }
  let nodes = 0;
  let text = 0;
  let overflow = false;
  const katex = (element) => {
    const tex = element.querySelector('annotation[encoding="application/x-tex"]')?.textContent;
    const fallback = element.querySelector(".katex-mathml")?.textContent ?? element.textContent ?? "";
    return {
      tag: "math",
      tex: (tex ?? fallback).trim(),
      display: element.closest(".katex-display") !== null,
      children: [],
    };
  };
  const walk = (node, depth) => {
    nodes += 1;
    if (overflow || nodes > MAX_NODES || depth > MAX_DEPTH) {
      overflow = true;
      return null;
    }
    if (node.nodeType === 3) {
      text += node.data.length;
      if (text > MAX_TEXT) overflow = true;
      return node.data;
    }
    if (node.nodeType !== 1) return null;
    const tag = node.localName;
    if (node.classList.contains("katex")) return katex(node);
    if (tag === "input") {
      return node.type === "checkbox" ? (node.checked ? "[x] " : "[ ] ") : null;
    }
    if (SKIP.has(tag) || node.hidden || node.getAttribute("aria-hidden") === "true") return null;
    if (node.classList.contains("sr-only")) return null;
    if (tag === "img") return { tag, alt: node.getAttribute("alt") || "", children: [] };
    const result = { tag, children: [] };
    if (tag === "a" && node.href) result.href = node.href;
    if (tag === "ol" && node.start !== 1) result.start = node.start;
    if (tag === "pre" || tag === "code") {
      const language = node.getAttribute("data-t3code-language") || languageOf(node);
      if (language) result.lang = language;
    }
    for (const child of node.childNodes) {
      const value = walk(child, depth + 1);
      if (value !== null) result.children.push(value);
    }
    return result;
  };
  const tree = walk(container, 0);
  return overflow || tree === null ? null : tree.children;
})()`;
