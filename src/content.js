/**
 * GitHub Push Force History — content script / userscript body.
 * WebExtensions (Chrome, Firefox, Edge) or userscript on GitHub PR pages.
 * DOM only; no browser.* / chrome.* APIs; no GitHub API.
 */

(function () {
  "use strict";

  const PANEL_ID = "gh-fph-panel";
  const FULL_SHA_LEN = 40;
  const SHA_FROM_TO_REGEX = /from\s+([a-f0-9]{7,40})\s+to\s+([a-f0-9]{7,40})/i;
  // GitHub force-push "Compare" uses two dots (A..B). Three dots (A...B) is merge-base compare.
  const COMPARE_RANGE_REGEX =
    /\/compare\/([a-f0-9]{7,40})(\.\.\.|\.\.)([a-f0-9]{7,40})/i;
  const FORCE_PUSH_RANGE_SEP = "..";
  const SHA_40_REGEX = /\b([a-f0-9]{40})\b/gi;

  /** @type {number} */
  let selectedIndex = 0;

  /** @type {boolean} */
  let panelMinimized = false;

  /** @type {ReturnType<typeof setTimeout> | null} */
  let debounceTimer = null;

  /**
   * Owner/repo from the current PR URL.
   * @returns {{ owner: string, repo: string } | null}
   */
  function getRepoContext() {
    const match = window.location.pathname.match(/^\/([^/]+)\/([^/]+)\/pull\/\d+/);
    if (!match) return null;
    return { owner: match[1], repo: match[2] };
  }

  /**
   * Builds a same-origin compare URL (no user-controlled host).
   * @param {string} oldSha
   * @param {string} newSha
   * @returns {string | null}
   */
  /**
   * Compare URLs must use 40-char SHAs (same as GitHub's "Compare" button).
   * Short SHAs make GitHub resolve ambiguously and show a much larger diff.
   */
  function createCompareUrl(oldSha, newSha) {
    const ctx = getRepoContext();
    if (!ctx) return null;
    const oldNorm = normalizeSha(oldSha);
    const newNorm = normalizeSha(newSha);
    if (!isFullSha(oldNorm) || !isFullSha(newNorm)) return null;
    const path = `/${ctx.owner}/${ctx.repo}/compare/${oldNorm}${FORCE_PUSH_RANGE_SEP}${newNorm}`;
    return new URL(path, window.location.origin).href;
  }

  /**
   * @param {string | null} sha
   */
  function isFullSha(sha) {
    return !!sha && /^[a-f0-9]{40}$/.test(sha);
  }

  /**
   * @param {string} sha
   * @returns {string | null}
   */
  function normalizeSha(sha) {
    if (!sha || typeof sha !== "string") return null;
    const trimmed = sha.trim().toLowerCase();
    if (!/^[a-f0-9]{7,40}$/.test(trimmed)) return null;
    return trimmed;
  }

  /**
   * Dedupe key (7-char prefixes) so short and full SHAs merge into one event.
   * @param {string} oldSha
   * @param {string} newSha
   */
  function eventKey(oldSha, newSha) {
    const o = normalizeSha(oldSha);
    const n = normalizeSha(newSha);
    if (!o || !n) return "";
    return `${o.slice(0, 7)}...${n.slice(0, 7)}`;
  }

  /**
   * Indexes every 40-char SHA found in links/attributes on the page.
   * Used to expand timeline abbreviations to full commit OIDs.
   * @returns {Map<string, string | null>} prefix -> fullSha, or null if ambiguous
   */
  function indexFullShasOnPage() {
    /** @type {Map<string, string | null>} */
    const index = new Map();

    const registerFull = (raw) => {
      const full = normalizeSha(raw);
      if (!isFullSha(full)) return;
      for (let len = 7; len <= FULL_SHA_LEN; len++) {
        const prefix = full.slice(0, len);
        const prev = index.get(prefix);
        if (prev === undefined) {
          index.set(prefix, full);
        } else if (prev !== full) {
          index.set(prefix, null);
        }
      }
    };

    const hrefSources = document.querySelectorAll(
      'a[href*="/commit/"], a[href*="/compare/"], a[href*="oid="]'
    );
    for (const el of hrefSources) {
      const href = el.getAttribute("href") || "";
      let match;
      SHA_40_REGEX.lastIndex = 0;
      while ((match = SHA_40_REGEX.exec(href)) !== null) {
        registerFull(match[1]);
      }
    }

    // data-url / hovercards occasionally embed the full oid
    const withOid = document.querySelectorAll("[data-url], [data-hovercard-url]");
    for (const el of withOid) {
      for (const attr of ["data-url", "data-hovercard-url"]) {
        const value = el.getAttribute(attr) || "";
        let match;
        SHA_40_REGEX.lastIndex = 0;
        while ((match = SHA_40_REGEX.exec(value)) !== null) {
          registerFull(match[1]);
        }
      }
    }

    return index;
  }

  /**
   * @param {string} sha
   * @param {Map<string, string | null>} index
   */
  function resolveFullSha(sha, index) {
    const normalized = normalizeSha(sha);
    if (!normalized) return null;
    if (isFullSha(normalized)) return normalized;

    for (let len = normalized.length; len <= FULL_SHA_LEN; len++) {
      const prefix = normalized.slice(0, len);
      const candidate = index.get(prefix);
      if (candidate) return candidate;
    }

    const short = index.get(normalized.slice(0, 7));
    return short || null;
  }

  /**
   * @param {string | null} url
   */
  function compareUrlUsesFullShas(url) {
    if (!url) return false;
    const parsed = parseComparePath(url);
    if (!parsed) return false;
    return isFullSha(parsed.oldSha) && isFullSha(parsed.newSha);
  }

  /**
   * Prefer entries that mirror GitHub's own Compare link (full OID range).
   * @param {ForcePushEvent} a
   * @param {ForcePushEvent} b
   */
  function mergeEvents(a, b) {
    const score = (e) =>
      (compareUrlUsesFullShas(e.compareUrl) ? 4 : 0) +
      (isFullSha(e.oldSha) ? 2 : 0) +
      (isFullSha(e.newSha) ? 2 : 0);

    return score(a) >= score(b) ? { ...a } : { ...b, domOrder: a.domOrder };
  }

  /**
   * @param {Map<string, ForcePushEvent>} map
   * @param {ForcePushEvent} event
   * @param {Map<string, string | null>} shaIndex
   */
  function upsertEvent(map, event, shaIndex) {
    const enriched = enrichEvent(event, shaIndex);
    const key = eventKey(enriched.oldSha, enriched.newSha);
    if (!key) return;

    const existing = map.get(key);
    if (!existing) {
      map.set(key, enriched);
      return;
    }

    const merged = mergeEvents(existing, enriched);
    merged.domOrder = Math.min(existing.domOrder, enriched.domOrder);
    if (!compareUrlUsesFullShas(merged.compareUrl)) {
      const fromA = compareUrlUsesFullShas(existing.compareUrl) ? existing.compareUrl : null;
      const fromB = compareUrlUsesFullShas(enriched.compareUrl) ? enriched.compareUrl : null;
      merged.compareUrl = fromA || fromB || merged.compareUrl;
    }
    map.set(key, enrichEvent(merged, shaIndex));
  }

  /**
   * @param {ForcePushEvent} event
   * @param {Map<string, string | null>} shaIndex
   */
  function enrichEvent(event, shaIndex) {
    let oldSha = resolveFullSha(event.oldSha, shaIndex) || event.oldSha;
    let newSha = resolveFullSha(event.newSha, shaIndex) || event.newSha;

    let compareUrl = event.compareUrl;
    const fromHref = compareUrl && parseComparePath(compareUrl);
    if (fromHref) {
      if (isFullSha(fromHref.oldSha) && isFullSha(fromHref.newSha)) {
        oldSha = fromHref.oldSha;
        newSha = fromHref.newSha;
        compareUrl = resolveCompareHref(compareUrl) || compareUrl;
      } else if (!compareUrlUsesFullShas(compareUrl)) {
        compareUrl = null;
      }
    }

    if (!compareUrlUsesFullShas(compareUrl)) {
      compareUrl = createCompareUrl(oldSha, newSha);
    }

    return {
      ...event,
      oldSha,
      newSha,
      compareUrl: compareUrl || null,
    };
  }

  /**
   * Opens compare URL in a new tab (noopener for tab opener isolation).
   * @param {string} url
   */
  function openCompareInNewTab(url) {
    if (!isSafeGithubCompareUrl(url)) return;
    window.open(url, "_blank", "noopener,noreferrer");
  }

  /**
   * Only allow compare links on the current github.com origin and repo path.
   * @param {string} url
   */
  function isSafeGithubCompareUrl(url) {
    try {
      const parsed = new URL(url, window.location.origin);
      if (parsed.origin !== window.location.origin) return false;
      const ctx = getRepoContext();
      if (!ctx) return false;
      const expectedPrefix = `/${ctx.owner}/${ctx.repo}/compare/`;
      if (!parsed.pathname.startsWith(expectedPrefix)) return false;
      const rest = parsed.pathname.slice(expectedPrefix.length);
      return /^[a-f0-9]{7,40}(\.\.|\.\.\.)[a-f0-9]{7,40}$/i.test(rest);
    } catch {
      return false;
    }
  }

  /**
   * Resolves compare href (absolute, same-origin).
   * @param {string} href
   * @returns {string | null}
   */
  function resolveCompareHref(href) {
    if (!href) return null;
    try {
      const url = new URL(href, window.location.origin);
      if (!isSafeGithubCompareUrl(url.href)) return null;
      return url.href;
    } catch {
      return null;
    }
  }

  /**
   * Parses compare link pathname or href.
   * @param {string} input
   * @returns {{ oldSha: string, newSha: string } | null}
   */
  /**
   * @param {string} input
   * @returns {{ oldSha: string, newSha: string, rangeSep: string } | null}
   */
  function parseComparePath(input) {
    const m = input.match(COMPARE_RANGE_REGEX);
    if (!m) return null;
    const oldSha = normalizeSha(m[1]);
    const newSha = normalizeSha(m[3]);
    if (!oldSha || !newSha) return null;
    return { oldSha, newSha, rangeSep: m[2] };
  }

  /**
   * @param {string} href
   */
  function isCompareRangeHref(href) {
    return COMPARE_RANGE_REGEX.test(href);
  }

  /**
   * Strategy 1: anchor[href*="/compare/"] with .. or ... range.
   * @param {Map<string, ForcePushEvent>} map
   * @param {{ value: number }} orderCounter
   */
  function collectFromCompareLinks(map, orderCounter, shaIndex) {
    const links = document.querySelectorAll('a[href*="/compare/"]');
    for (const link of links) {
      const href = link.getAttribute("href") || "";
      if (!isCompareRangeHref(href)) continue;

      const parsed = parseComparePath(href);
      if (!parsed) continue;

      const timelineRoot = findTimelineContainer(link);
      const textBlob = getNearbyForcePushText(link, timelineRoot);
      // Ignore generic compare links not tied to a force-push timeline entry.
      if (!textBlob || !/force-pushed/i.test(textBlob)) {
        continue;
      }

      const compareUrl = resolveCompareHref(href);
      const timeText = extractTimeText(link, timelineRoot);

      upsertEvent(
        map,
        {
          oldSha: parsed.oldSha,
          newSha: parsed.newSha,
          timeText,
          compareUrl,
          domOrder: orderCounter.value++,
        },
        shaIndex
      );
    }
  }

  /**
   * Strategy 2 & 3: timeline blocks containing "force-pushed" + regex on text.
   * @param {Map<string, ForcePushEvent>} map
   * @param {{ value: number }} orderCounter
   */
  function collectFromTimelineText(map, orderCounter, shaIndex) {
    // GitHub timeline item selectors change often — try several containers.
    const candidates = document.querySelectorAll(
      [
        ".TimelineItem",
        "[data-testid='timeline-item']",
        ".js-timeline-item",
        "div[id^='issuecomment-']",
        ".TimelineItem-body",
      ].join(", ")
    );

    const seenElements = new Set();

    for (const el of candidates) {
      if (seenElements.has(el)) continue;
      const text = (el.textContent || "").replace(/\s+/g, " ").trim();
      if (!/force-pushed/i.test(text)) continue;

      const compareLink = el.querySelector('a[href*="/compare/"]');
      let oldSha = null;
      let newSha = null;
      let compareUrl = null;

      // GitHub's Compare href carries the exact 40-char range — always prefer it.
      if (compareLink) {
        const href = compareLink.getAttribute("href") || "";
        const parsed = parseComparePath(href);
        compareUrl = resolveCompareHref(href);
        if (parsed) {
          oldSha = parsed.oldSha;
          newSha = parsed.newSha;
        }
      }

      if (!oldSha || !newSha) {
        const match = text.match(SHA_FROM_TO_REGEX);
        if (!match) continue;
        oldSha = normalizeSha(match[1]);
        newSha = normalizeSha(match[2]);
      }

      if (!oldSha || !newSha) continue;

      upsertEvent(
        map,
        {
          oldSha,
          newSha,
          timeText: extractTimeText(el, el),
          compareUrl,
          domOrder: orderCounter.value++,
        },
        shaIndex
      );

      seenElements.add(el);
    }

    // Fallback: any element whose text matches force-push pattern (narrow scope).
    if (map.size === 0) {
      const all = document.body?.querySelectorAll("*") || [];
      for (const el of all) {
        if (el.children.length > 8) continue;
        const text = (el.textContent || "").replace(/\s+/g, " ").trim();
        if (text.length > 500 || text.length < 20) continue;
        if (!/force-pushed/i.test(text)) continue;
        const m = text.match(SHA_FROM_TO_REGEX);
        if (!m) continue;

        const oldSha = normalizeSha(m[1]);
        const newSha = normalizeSha(m[2]);
        if (!oldSha || !newSha) continue;

        upsertEvent(
          map,
          {
            oldSha,
            newSha,
            timeText: extractTimeText(el, el),
            compareUrl: null,
            domOrder: orderCounter.value++,
          },
          shaIndex
        );
      }
    }
  }

  /**
   * Walk up to a timeline-like container (fragile — GitHub class names).
   * @param {Element} start
   */
  function findTimelineContainer(start) {
    let node = start;
    for (let i = 0; i < 12 && node; i++) {
      if (
        node.classList?.contains("TimelineItem") ||
        node.getAttribute?.("data-testid") === "timeline-item" ||
        node.classList?.contains("js-timeline-item")
      ) {
        return node;
      }
      node = node.parentElement;
    }
    return start.parentElement || start;
  }

  /**
   * @param {Element} link
   * @param {Element | null} root
   */
  function getNearbyForcePushText(link, root) {
    const scope = root || link.closest(".TimelineItem, [data-testid='timeline-item']") || link.parentElement;
    return (scope?.textContent || "").replace(/\s+/g, " ");
  }

  /**
   * Relative time or datetime from timeline markup.
   * @param {Element} el
   * @param {Element | null} root
   */
  function extractTimeText(el, root) {
    const scope = root || el;
    const relative = scope.querySelector("relative-time");
    if (relative) {
      return (
        relative.getAttribute("title") ||
        relative.textContent?.trim() ||
        ""
      );
    }
    const time = scope.querySelector("time");
    if (time) {
      return time.getAttribute("datetime") || time.textContent?.trim() || "";
    }
    return "";
  }

  /**
   * Extracts force-push events from the visible PR timeline DOM.
   * @returns {ForcePushEvent[]}
   */
  function extractForcePushEvents() {
    /** @type {Map<string, ForcePushEvent>} */
    const map = new Map();
    const orderCounter = { value: 0 };
    const shaIndex = indexFullShasOnPage();

    collectFromCompareLinks(map, orderCounter, shaIndex);
    collectFromTimelineText(map, orderCounter, shaIndex);

    const events = Array.from(map.values());
    events.sort((a, b) => a.domOrder - b.domOrder);

    // GitHub timeline is usually newest-first; user wants chronological (oldest first).
    events.reverse();

    return events;
  }

  /**
   * Ensures a single panel root exists.
   * @returns {HTMLElement}
   */
  function ensurePanelRoot() {
    let panel = document.getElementById(PANEL_ID);
    if (panel) return panel;

    panel = document.createElement("aside");
    panel.id = PANEL_ID;
    panel.setAttribute("role", "complementary");
    panel.setAttribute("aria-label", "GitHub Push Force History");
    document.body.appendChild(panel);
    return panel;
  }

  /**
   * @param {HTMLElement} panel
   */
  function applyPanelMinimizedState(panel) {
    panel.classList.toggle("gh-fph-panel--minimized", panelMinimized);
    const toggle = panel.querySelector(".gh-fph-minimize-btn");
    if (toggle) {
      toggle.textContent = panelMinimized ? "Expand" : "Minimize";
      toggle.setAttribute("aria-expanded", String(!panelMinimized));
      toggle.title = panelMinimized ? "Expand panel" : "Minimize panel";
    }
  }

  /**
   * @returns {HTMLButtonElement}
   */
  function createMinimizeButton() {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "gh-fph-btn gh-fph-minimize-btn";
    btn.textContent = panelMinimized ? "Expand" : "Minimize";
    btn.setAttribute("aria-expanded", String(!panelMinimized));
    btn.title = panelMinimized ? "Expand panel" : "Minimize panel";
    btn.addEventListener("click", () => {
      panelMinimized = !panelMinimized;
      const panel = document.getElementById(PANEL_ID);
      if (panel) applyPanelMinimizedState(panel);
    });
    return btn;
  }

  /**
   * Short display SHA (7 chars like GitHub UI).
   * @param {string} sha
   */
  function shortSha(sha) {
    return sha.length > 7 ? sha.slice(0, 7) : sha;
  }

  /**
   * Renders or updates the panel content.
   * @param {ForcePushEvent[]} events
   */
  function renderPanel(events) {
    const panel = ensurePanelRoot();

    if (events.length === 0) {
      selectedIndex = 0;
    } else if (selectedIndex >= events.length) {
      selectedIndex = events.length - 1;
    } else if (selectedIndex < 0) {
      selectedIndex = 0;
    }

    panel.innerHTML = "";

    const header = document.createElement("div");
    header.className = "gh-fph-header";
    header.appendChild(createMinimizeButton());
    panel.appendChild(header);

    const body = document.createElement("div");
    body.className = "gh-fph-body";

    const toolbar = document.createElement("div");
    toolbar.className = "gh-fph-toolbar";

    const refreshBtn = document.createElement("button");
    refreshBtn.type = "button";
    refreshBtn.className = "gh-fph-btn";
    refreshBtn.textContent = "Refresh";
    refreshBtn.addEventListener("click", () => {
      const fresh = extractForcePushEvents();
      renderPanel(fresh);
    });

    const prevBtn = document.createElement("button");
    prevBtn.type = "button";
    prevBtn.className = "gh-fph-btn";
    prevBtn.textContent = "Open previous";
    prevBtn.disabled = events.length === 0;

    const nextBtn = document.createElement("button");
    nextBtn.type = "button";
    nextBtn.className = "gh-fph-btn";
    nextBtn.textContent = "Open next";
    nextBtn.disabled = events.length === 0;

    prevBtn.addEventListener("click", () => {
      if (events.length === 0) return;
      selectedIndex = Math.max(0, selectedIndex - 1);
      renderPanel(events);
      openEventCompare(events[selectedIndex]);
    });

    nextBtn.addEventListener("click", () => {
      if (events.length === 0) return;
      selectedIndex = Math.min(events.length - 1, selectedIndex + 1);
      renderPanel(events);
      openEventCompare(events[selectedIndex]);
    });

    toolbar.append(refreshBtn, prevBtn, nextBtn);
    body.appendChild(toolbar);

    if (events.length === 0) {
      const empty = document.createElement("p");
      empty.className = "gh-fph-empty";
      empty.textContent = "No force-push history found in this PR timeline.";
      body.appendChild(empty);
      panel.appendChild(body);
      applyPanelMinimizedState(panel);
      return;
    }

    const list = document.createElement("ol");
    list.className = "gh-fph-list";

    events.forEach((event, index) => {
      const item = document.createElement("li");
      item.className = "gh-fph-item";
      if (index === selectedIndex) {
        item.classList.add("gh-fph-item--active");
      }

      const line = document.createElement("div");
      const idx = document.createElement("span");
      idx.className = "gh-fph-item-index";
      idx.textContent = `${index + 1}.`;

      const shas = document.createElement("span");
      shas.className = "gh-fph-shas";
      shas.textContent = `${shortSha(event.oldSha)} → ${shortSha(event.newSha)}`;

      line.append(idx, shas);
      item.appendChild(line);

      if (event.timeText) {
        const meta = document.createElement("div");
        meta.className = "gh-fph-meta";
        meta.textContent = event.timeText;
        item.appendChild(meta);
      }

      const canOpen =
        compareUrlUsesFullShas(event.compareUrl) ||
        (isFullSha(event.oldSha) && isFullSha(event.newSha));

      const diffBtn = document.createElement("button");
      diffBtn.type = "button";
      diffBtn.className = "gh-fph-link";
      diffBtn.textContent = "Open diff";
      diffBtn.disabled = !canOpen;
      if (!canOpen) {
        diffBtn.title =
          "Full commit SHAs not found on this page — scroll the timeline or click Refresh.";
      }
      diffBtn.addEventListener("click", () => {
        if (!canOpen) return;
        selectedIndex = index;
        renderPanel(events);
        openEventCompare(event);
      });

      item.addEventListener("click", (e) => {
        if (e.target === diffBtn) return;
        selectedIndex = index;
        renderPanel(events);
      });

      item.appendChild(diffBtn);
      list.appendChild(item);
    });

    body.appendChild(list);
    panel.appendChild(body);
    applyPanelMinimizedState(panel);
  }

  /**
   * @param {ForcePushEvent} event
   */
  function openEventCompare(event) {
    if (event.compareUrl && compareUrlUsesFullShas(event.compareUrl)) {
      openCompareInNewTab(event.compareUrl);
      return;
    }
    const url = createCompareUrl(event.oldSha, event.newSha);
    if (url) openCompareInNewTab(url);
  }

  /**
   * Re-scan DOM and update panel (debounced).
   */
  function refreshFromDom() {
    const events = extractForcePushEvents();
    renderPanel(events);
  }

  /**
   * Watches dynamic timeline loads (GitHub SPA / lazy timeline).
   */
  function observePageChanges() {
    const observer = new MutationObserver(() => {
      if (debounceTimer) clearTimeout(debounceTimer);
      debounceTimer = setTimeout(() => {
        debounceTimer = null;
        if (!document.getElementById(PANEL_ID)) {
          refreshFromDom();
          return;
        }
        const events = extractForcePushEvents();
        const panel = document.getElementById(PANEL_ID);
        const countEl = panel?.querySelector(".gh-fph-list");
        const currentCount = countEl?.children.length ?? 0;
        if (events.length !== currentCount) {
          renderPanel(events);
        }
      }, 400);
    });

    observer.observe(document.body, {
      childList: true,
      subtree: true,
    });
  }

  function init() {
    if (!getRepoContext()) return;
    refreshFromDom();
    observePageChanges();
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();

/**
 * @typedef {Object} ForcePushEvent
 * @property {string} oldSha
 * @property {string} newSha
 * @property {string} timeText
 * @property {string | null} compareUrl
 * @property {number} domOrder
 */
