/**
 * Scripts the shell runs inside a site's page, in an isolated world so the
 * page's own code can neither see nor tamper with them. Both are poll-free:
 * they react to DOM mutations the page already makes and keep no interval.
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
  notice.style.cssText = [
    "position:fixed",
    "left:50%",
    "bottom:24px",
    "transform:translateX(-50%)",
    "z-index:2147483647",
    "max-width:min(480px,calc(100vw - 32px))",
    "padding:10px 14px",
    "border-radius:10px",
    "background:rgba(24,24,27,0.94)",
    "color:#fafafa",
    "font:500 13px/1.4 -apple-system,BlinkMacSystemFont,'Segoe UI',system-ui,sans-serif",
    "box-shadow:0 12px 32px -12px rgba(0,0,0,0.6)",
    "pointer-events:none",
  ].join(";");
  root.append(notice);
  document.documentElement.append(host);
  setTimeout(() => host.remove(), ${NOTICE_DURATION_MS});
  return true;
})()`;
