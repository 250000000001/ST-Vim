/**
 * SillyTavern-aware clickable element discovery, ultra-fast region-scoped &
 * viewport-pruned scanning (zero elementFromPoint hit-testing), deduplication,
 * prioritization, badge placement, and smart activation.
 */

export const INTERACTIVE_SELECTOR = [
    // Standard HTML interactive elements
    'button:not([disabled])',
    'a[href]',
    'summary',
    'input:not([type="hidden"]):not([disabled])',
    'select:not([disabled])',
    'textarea:not([disabled])',
    '[role="button"]',
    '[role="link"]',
    '[role="tab"]',
    '[role="menuitem"]',
    '[role="option"]',
    '[role="checkbox"]',
    '[role="radio"]',
    '[role="switch"]',
    '[role="combobox"]',
    '[tabindex]:not([tabindex="-1"])',
    '[onclick]',
    'label[for]',
    'label.checkbox_label',

    // SillyTavern core UI, floating panels (Author's Note, CFG, etc.), & menus
    '.menu_button',
    '.menu_button_icon',
    '.right_menu_button',
    '.interactable',
    '.drawer-toggle',
    '.drawer-icon',
    '.inline-drawer-toggle',
    '.inline-drawer-header',
    '.inline-drawer-maximize',
    '.floating_panel_close',
    '.mes_button',
    '.mes_buttons > div',
    '.extraMesButtons > div',
    '.extraMesButtonsHint',
    '.swipe_left',
    '.swipe_right',
    '.list-group-item',
    '.options-content a',
    '#options a',
    '#options .list-group-item',
    '#extensionsMenu > .extension_container > div',
    '#extensionsMenu > div:not(.extension_container)',
    '#extensionsMenu a',

    // SillyTavern Welcome Screen (Recent Chats), Chat History, Personas, Characters, Backgrounds
    '.recentChat',
    '.pinChat',
    '.renameChat',
    '.deleteChat',
    '.showMoreChats',
    '.openTemporaryChat',
    '.select_chat_block',
    '.avatar-container',
    '.persona_container',
    '.character_select',
    '.group_select',
    '.group_member',
    '.bogus_folder_select',
    '.bg_example',
    '.bg_element',

    // Popups, Quick Replies, Select2, Pagination, Chat/Extension item actions
    '.qr--button',
    '.popup-button-ok',
    '.popup-button-cancel',
    '.popup-button-custom',
    '.popup-button-close',
    '.dialogue_popup_ok',
    '.dialogue_popup_cancel',
    '.tag_remove',
    '.select2-selection',
    '.select2-results__option',
    '.paginationjs-page',
    '.paginationjs-prev',
    '.paginationjs-next',
    '.restore_chat',
    '.rename_chat',
    '.delete_chat',
    '.export_chat',
    '.favorite_toggle_icon',
    '.extensions_block',
].join(', ');

// Lightweight selector used inside visible `.mes` blocks (avoids scanning prose tags)
const MES_INTERACTIVE_SELECTOR = [
    '.mes_button',
    '.mes_buttons > div',
    '.extraMesButtons > div',
    '.extraMesButtonsHint',
    '.swipe_left',
    '.swipe_right',
    '.right_menu_button',
    '.menu_button',
    '.interactable',
    'button:not([disabled])',
    'a[href]',
    'summary',
    'input:not([type="hidden"]):not([disabled])',
    'select:not([disabled])',
    'textarea:not([disabled])',
    '[role="button"]',
    '[onclick]',
].join(', ');

const TEXT_INPUT_SELECTOR =
    'textarea, input:not([type="checkbox"]):not([type="radio"]):not([type="button"]):not([type="submit"]):not([type="reset"]):not([type="range"]):not([type="color"]):not([type="file"]):not([type="hidden"]), [contenteditable="true"], [contenteditable=""]';

const HOVER_REVEAL_SELECTOR = '.mes_button, .swipe_left, .swipe_right';

const IGNORED_CONTAINER_IDS = new Set([
    'chat',
    'sheld',
    'bg1',
    'bg_custom',
    'top-bar',
    'top-settings-holder',
    'left-nav-panel',
    'right-nav-panel',
    'movingDivs',
    'st-vimium-overlay',
]);

const IGNORED_CONTAINER_SELECTOR =
    '.mes, .mes_block, .mes_text, .drawer-content, .drawer-settings, .popup, dialog, #dialogue_popup, #options, #extensionsMenu, .extension_container';

const CARD_CONTAINER_SELECTOR =
    '.recentChat, .select_chat_block, .avatar-container, .persona_container, .character_select, .group_select, .extensions_block, .bg_example, .bg_element';

const DISTINCT_CHILD_SELECTOR =
    'button, a[href], input, select, textarea, .menu_button, .right_menu_button, .mes_button, .interactable, .swipe_left, .swipe_right, .pinChat, .renameChat, .deleteChat, .rename_chat, .delete_chat, .export_chat, .restore_chat, .tag_remove, .favorite_toggle_icon, [role="button"]';

const KNOWN_BODY_REGIONS = new Set([
    'sheld',
    'chat',
    'form_sheld',
    'send_form',
    'top-settings-holder',
    'top-bar',
    'movingDivs',
    'options',
    'extensionsMenu',
    'st-vimium-overlay',
    'bg1',
    'bg_custom',
    'bg_tabs',
    'preloader',
    'dialogue_popup',
    'shadow_popup',
    'shadow_select_chat_popup',
    'left-nav-panel',
    'right-nav-panel',
    'message_template',
    'user_avatar_template',
    'visual-novel-wrapper',
]);

const SKIP_TAGS = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'TEMPLATE', 'LINK', 'META', 'SVG']);

const MAX_VISIBLE_TARGETS = 320;

/**
 * Intersect two rectangles `{ left, top, right, bottom }`.
 * Returns null if there is no positive-area intersection.
 *
 * @param {{ left: number, top: number, right: number, bottom: number }} a
 * @param {{ left: number, top: number, right: number, bottom: number }} b
 */
export function intersectRects(a, b) {
    const left = Math.max(a.left, b.left);
    const top = Math.max(a.top, b.top);
    const right = Math.min(a.right, b.right);
    const bottom = Math.min(a.bottom, b.bottom);
    if (right - left <= 1 || bottom - top <= 1) return null;
    return { left, top, right, bottom, width: right - left, height: bottom - top };
}

/**
 * Return true if the center of `rect` is covered by any higher-layer overlay rect.
 * Pure arithmetic O(K) check (K <= ~5 overlays) — replaces hundreds of expensive
 * `document.elementFromPoint()` browser hit-tests that caused lag on long chats.
 *
 * @param {{ left: number, top: number, right: number, bottom: number, width: number, height: number }} rect
 * @param {Array<{ left: number, top: number, right: number, bottom: number }>} overlayRects
 * @returns {boolean}
 */
export function isOccludedByRects(rect, overlayRects) {
    if (!overlayRects || overlayRects.length === 0) return false;
    const cx = rect.left + rect.width * 0.5;
    const cy = rect.top + rect.height * 0.5;
    for (let i = 0; i < overlayRects.length; i++) {
        const o = overlayRects[i];
        if (cx >= o.left && cx <= o.right && cy >= o.top && cy <= o.bottom) {
            return true;
        }
    }
    return false;
}

/**
 * Binary-search a vertically ordered list of `.mes` elements inside `#chat` to return
 * ONLY the slice whose vertical bounding boxes intersect `[clipTop, clipBottom]`.
 * Runs in O(log N + K) where K is the number of messages actually visible on screen.
 *
 * @param {ArrayLike<Element>} mesList
 * @param {number} clipTop
 * @param {number} clipBottom
 * @returns {Element[]}
 */
export function findVisibleMessagesInRange(mesList, clipTop, clipBottom) {
    const n = mesList?.length ?? 0;
    if (n === 0) return [];

    let lo = 0;
    let hi = n;
    while (lo < hi) {
        const mid = (lo + hi) >>> 1;
        const rect = mesList[mid].getBoundingClientRect();
        if (rect.bottom <= clipTop) {
            lo = mid + 1;
        } else {
            hi = mid;
        }
    }

    const visible = [];
    const start = Math.max(0, lo - 1);
    for (let i = start; i < n; i++) {
        const el = mesList[i];
        const rect = el.getBoundingClientRect();
        if (rect.top >= clipBottom) {
            if (i >= lo) break;
            continue;
        }
        if (rect.bottom > clipTop && rect.height > 0) {
            visible.push(el);
        }
    }

    return visible;
}

/**
 * Assign a SillyTavern workflow priority tier so the most frequently used buttons
 * receive shorter (1-character) hints.
 * Lower number = higher priority.
 *
 * @param {Element} el
 * @param {Element | null} lastVisibleMes
 * @returns {number}
 */
export function getTargetPriority(el, lastVisibleMes = null) {
    // Tier 0: Active popups, dialogs, floating menus, & floating panels (Author's Note, CFG, etc.)
    if (
        el.closest?.(
            'dialog[open], .popup, #dialogue_popup, #shadow_select_chat_popup, #options, #extensionsMenu, #movingDivs, .select2-dropdown, .list-group',
        )
    ) {
        return 0;
    }

    // Tier 1: Chat send bar, Quick Replies, and latest visible message's buttons / swipes
    if (el.closest?.('#form_sheld, #send_form, #non_stream_continue_btn, .qr--bar, #qr--bar')) {
        return 1;
    }
    if (lastVisibleMes && lastVisibleMes.contains(el)) {
        return 1;
    }

    // Tier 2: Top bar drawers, open drawer panels, and Welcome Screen recent chats
    if (el.closest?.('#top-settings-holder, .drawer-content.openDrawer, .welcomePanel')) {
        return 2;
    }

    // Tier 3: Everything else (older messages, etc.)
    return 3;
}

/**
 * Deduplicate nested and overlapping clickable candidates so a single visual button
 * only receives ONE hint badge, while distinct smaller sub-controls inside a card
 * (e.g. rename/delete inside `.recentChat` or `.select_chat_block`) are preserved.
 *
 * @param {Array<{ el: Element, rect: { left: number, top: number, right: number, bottom: number, width: number, height: number } }>} candidates
 * @returns {Array<{ el: Element, rect: { left: number, top: number, right: number, bottom: number, width: number, height: number } }>}
 */
export function deduplicateTargets(candidates) {
    const skipped = new Set();
    const byEl = new Map(candidates.map((c) => [c.el, c]));

    for (const item of candidates) {
        const el = item.el;
        if (el.tagName === 'LABEL') {
            const forId = el.getAttribute?.('for');
            let linkedInput = null;
            if (forId && typeof el.ownerDocument?.getElementById === 'function') {
                linkedInput = el.ownerDocument.getElementById(forId);
            }
            if (!linkedInput) {
                linkedInput = el.querySelector?.('input, select, textarea') ?? null;
            }
            if (linkedInput && byEl.has(linkedInput)) {
                skipped.add(el);
            }
        }
    }

    const filtered = candidates.filter((c) => !skipped.has(c.el));
    const kept = [];

    for (const candidate of filtered) {
        let shouldSkip = false;

        for (let i = 0; i < kept.length; i++) {
            const existing = kept[i];
            const existingArea = existing.rect.width * existing.rect.height;
            const candArea = candidate.rect.width * candidate.rect.height;

            if (existing.el.contains(candidate.el)) {
                const isContainerCard = existing.el.matches?.(CARD_CONTAINER_SELECTOR);
                const isDistinctSubControl =
                    isContainerCard &&
                    candArea < existingArea * 0.45 &&
                    candidate.el.matches?.(DISTINCT_CHILD_SELECTOR);

                if (!isDistinctSubControl) {
                    shouldSkip = true;
                    break;
                }
            } else if (candidate.el.contains(existing.el)) {
                const isContainerCard = candidate.el.matches?.(CARD_CONTAINER_SELECTOR);
                const existingIsDistinct =
                    isContainerCard &&
                    existingArea < candArea * 0.45 &&
                    existing.el.matches?.(DISTINCT_CHILD_SELECTOR);

                if (!existingIsDistinct) {
                    kept[i] = candidate;
                    shouldSkip = true;
                    break;
                }
            } else {
                const dx = Math.abs(existing.rect.left - candidate.rect.left);
                const dy = Math.abs(existing.rect.top - candidate.rect.top);
                const dw = Math.abs(existing.rect.width - candidate.rect.width);
                const dh = Math.abs(existing.rect.height - candidate.rect.height);
                if (dx <= 4 && dy <= 4 && dw <= 6 && dh <= 6) {
                    shouldSkip = true;
                    break;
                }
            }
        }

        if (!shouldSkip) {
            kept.push(candidate);
        }
    }

    return kept;
}

/**
 * Build validated selectors combining built-in and optional user-defined selectors.
 *
 * @param {Document} doc
 * @param {string} [customSelectors]
 * @returns {{ fullSelector: string, mesSelector: string }}
 */
function buildSelectors(doc, customSelectors) {
    if (!customSelectors || typeof customSelectors !== 'string') {
        return { fullSelector: INTERACTIVE_SELECTOR, mesSelector: MES_INTERACTIVE_SELECTOR };
    }
    const extras = customSelectors
        .split(/[\n,]/)
        .map((s) => s.trim())
        .filter(Boolean);
    if (extras.length === 0) {
        return { fullSelector: INTERACTIVE_SELECTOR, mesSelector: MES_INTERACTIVE_SELECTOR };
    }

    const extraJoined = extras.join(', ');
    try {
        doc.querySelector(extraJoined);
        return {
            fullSelector: `${INTERACTIVE_SELECTOR}, ${extraJoined}`,
            mesSelector: `${MES_INTERACTIVE_SELECTOR}, ${extraJoined}`,
        };
    } catch {
        return { fullSelector: INTERACTIVE_SELECTOR, mesSelector: MES_INTERACTIVE_SELECTOR };
    }
}

/**
 * Fast visibility check for a container/panel element.
 * Returns its viewport-clipped rect if visible, or null if hidden/off-screen.
 */
function getVisiblePanelRect(el, viewportRect, getStyle) {
    if (!el || el.nodeType !== 1 || el.hidden) return null;
    if (el.style?.display === 'none') return null;
    const cl = el.classList;
    if (cl && (cl.contains('closedDrawer') || cl.contains('displayNone'))) return null;

    const raw = el.getBoundingClientRect?.();
    if (!raw || raw.width < 4 || raw.height < 4) return null;

    const clipped = intersectRects(raw, viewportRect);
    if (!clipped) return null;

    const style = getStyle(el);
    if (!style || style.display === 'none' || style.visibility === 'hidden' || style.visibility === 'collapse') {
        return null;
    }
    return clipped;
}

/**
 * Ultra-fast SillyTavern region-scoped clickable target collector:
 * - Zero `document.elementFromPoint()` calls (uses O(1) layer-rect occlusion instead).
 * - Never scans closed drawers or off-screen `#chat` turns (O(log N) binary search on `#chat`).
 * - Properly scans `#movingDivs` floating subtabs (Author's Note `#floatingPrompt`, CFG Scale, etc.),
 *   `#options`, `#extensionsMenu`, open drawers, modals, top bar, send bar, Welcome Screen, and custom panels.
 *
 * @param {{
 *   doc?: Document,
 *   win?: Window,
 *   includeInputs?: boolean,
 *   customSelectors?: string,
 * }} [options]
 * @returns {Array<{ el: Element, rect: { left: number, top: number, right: number, bottom: number, width: number, height: number }, priority: number }>}
 */
export function collectClickableTargets(options = {}) {
    const doc = options.doc ?? document;
    const win = options.win ?? window;
    const includeInputs = options.includeInputs !== false;
    const { fullSelector, mesSelector } = buildSelectors(doc, options.customSelectors);

    const vw = win.innerWidth || 1280;
    const vh = win.innerHeight || 720;
    const viewportRect = { left: 0, top: 0, right: vw, bottom: vh, width: vw, height: vh };

    /** @type {Map<Element, CSSStyleDeclaration>} */
    const styleCache = new Map();
    const getStyle = (el) => {
        let s = styleCache.get(el);
        if (!s) {
            s = win.getComputedStyle(el);
            styleCache.set(el, s);
        }
        return s;
    };

    /** @type {Map<Element, { left: number, top: number, right: number, bottom: number } | null>} */
    const ancestorClipCache = new Map();

    /**
     * Compute effective clip rect for `el` within `regionRoot` by checking scrollable
     * ancestors ONLY up to `regionRoot` (cached so shared parents are computed once).
     */
    const getElementClipRect = (el, regionRoot, regionClip) => {
        let cur = el.parentElement;
        const chain = [];
        let baseClip = regionClip;

        while (cur && cur !== regionRoot && cur.tagName !== 'BODY' && cur.tagName !== 'HTML') {
            if (ancestorClipCache.has(cur)) {
                baseClip = ancestorClipCache.get(cur);
                break;
            }
            chain.push(cur);
            cur = cur.parentElement;
        }

        let currentClip = baseClip;
        for (let i = chain.length - 1; i >= 0; i--) {
            const anc = chain[i];
            if (!currentClip) {
                ancestorClipCache.set(anc, null);
                continue;
            }
            if (anc.style?.display === 'none') {
                currentClip = null;
                ancestorClipCache.set(anc, null);
                continue;
            }
            const st = getStyle(anc);
            if (!st || st.display === 'none' || st.visibility === 'hidden') {
                currentClip = null;
                ancestorClipCache.set(anc, null);
                continue;
            }
            const ox = st.overflowX || st.overflow;
            const oy = st.overflowY || st.overflow;
            const clipsX = ox === 'hidden' || ox === 'auto' || ox === 'scroll' || ox === 'clip';
            const clipsY = oy === 'hidden' || oy === 'auto' || oy === 'scroll' || oy === 'clip';
            if (clipsX || clipsY) {
                const ar = anc.getBoundingClientRect();
                currentClip = intersectRects(currentClip, {
                    left: clipsX ? ar.left : -Infinity,
                    right: clipsX ? ar.right : Infinity,
                    top: clipsY ? ar.top : -Infinity,
                    bottom: clipsY ? ar.bottom : Infinity,
                });
            }
            ancestorClipCache.set(anc, currentClip);
        }

        return currentClip;
    };

    const candidates = [];
    const seen = new Set();
    let lastVisibleMes = null;

    const addCandidate = (el, regionRoot, regionClip, occluders) => {
        if (seen.has(el)) return;
        if (el.id && IGNORED_CONTAINER_IDS.has(el.id)) return;
        if (el.matches?.(IGNORED_CONTAINER_SELECTOR)) return;
        if (el.hasAttribute?.('disabled') || el.getAttribute?.('aria-disabled') === 'true') return;
        if (el.hidden || el.style?.display === 'none') return;

        if (!includeInputs && el.matches?.(`${TEXT_INPUT_SELECTOR}, input[type="range"]`)) {
            return;
        }

        // Fast rect check FIRST — eliminates 100% of display:none descendants & off-screen nodes
        // with ZERO getComputedStyle calls!
        const rawRect = el.getBoundingClientRect?.();
        if (!rawRect || rawRect.width < 3 || rawRect.height < 3) return;

        if (
            rawRect.bottom <= regionClip.top ||
            rawRect.top >= regionClip.bottom ||
            rawRect.right <= regionClip.left ||
            rawRect.left >= regionClip.right
        ) {
            return;
        }

        const tag = el.tagName?.toUpperCase() || '';
        if (tag !== 'TEXTAREA' && tag !== 'INPUT' && rawRect.width > vw * 0.65 && rawRect.height > vh * 0.55) {
            return;
        }

        const effectiveClip = getElementClipRect(el, regionRoot, regionClip);
        if (!effectiveClip) return;

        const clipped = intersectRects(rawRect, effectiveClip);
        if (!clipped || clipped.width < 4 || clipped.height < 4) return;

        if (isOccludedByRects(clipped, occluders)) return;

        const style = getStyle(el);
        if (!style) return;
        if (style.display === 'none' || style.visibility === 'hidden' || style.visibility === 'collapse') return;
        if (style.pointerEvents === 'none') return;

        const opacity = parseFloat(style.opacity);
        if (opacity === 0 && !el.matches?.(HOVER_REVEAL_SELECTOR)) return;

        seen.add(el);
        candidates.push({ el, rect: clipped });
    };

    const scanContainer = (container, regionClip, occluders, selector = fullSelector) => {
        if (!container || !regionClip) return;
        if (container.matches?.(selector)) {
            addCandidate(container, container, regionClip, occluders);
        }
        const nodes = container.querySelectorAll?.(selector);
        if (!nodes) return;
        for (let i = 0; i < nodes.length; i++) {
            addCandidate(nodes[i], container, regionClip, occluders);
        }
    };

    // -----------------------------------------------------------------------
    // Layer 4: Blocking Modals (if open, ONLY scan the top-most modal!)
    // -----------------------------------------------------------------------
    const modalNodes = doc.querySelectorAll?.('dialog[open], .popup, #shadow_select_chat_popup, #dialogue_popup') ?? [];
    let topModal = null;
    let topModalRect = null;
    for (let i = modalNodes.length - 1; i >= 0; i--) {
        const m = modalNodes[i];
        const r = getVisiblePanelRect(m, viewportRect, getStyle);
        if (r) {
            topModal = m;
            topModalRect = r;
            break;
        }
    }

    if (topModal && topModalRect) {
        // Also include any visible Select2 dropdown opened from inside the modal
        const modalOccluders = [];
        const select2Drops = doc.querySelectorAll?.('.select2-dropdown') ?? [];
        for (const drop of select2Drops) {
            const dr = getVisiblePanelRect(drop, viewportRect, getStyle);
            if (dr) {
                scanContainer(drop, dr, []);
                modalOccluders.push(dr);
            }
        }
        scanContainer(topModal, topModalRect, modalOccluders);
    } else {
        // Track rects of higher layers so lower layers skip occluded elements in O(1)
        const activeOccluders = [];

        // -------------------------------------------------------------------
        // Layer 3: Floating Menus (#options, #extensionsMenu, .select2-dropdown)
        // -------------------------------------------------------------------
        const menuEls = [];
        const optionsEl = doc.getElementById?.('options');
        if (optionsEl) menuEls.push(optionsEl);
        const extMenuEl = doc.getElementById?.('extensionsMenu');
        if (extMenuEl) menuEls.push(extMenuEl);
        const select2Drops = doc.querySelectorAll?.('.select2-dropdown') ?? [];
        for (const drop of select2Drops) menuEls.push(drop);

        for (const menu of menuEls) {
            const mr = getVisiblePanelRect(menu, viewportRect, getStyle);
            if (mr) {
                scanContainer(menu, mr, activeOccluders);
                activeOccluders.push(mr);
            }
        }

        // -------------------------------------------------------------------
        // Layer 2: Floating Subtabs inside `#movingDivs` (Author's Note
        // `#floatingPrompt`, CFG Scale `#cfgConfig`, Logprobs, WorldInfo, etc.)
        // plus any custom visible floating extension panels on `document.body`
        // -------------------------------------------------------------------
        const floatingPanels = [];
        const movingDivs = doc.getElementById?.('movingDivs');
        if (movingDivs?.children) {
            for (let i = movingDivs.children.length - 1; i >= 0; i--) {
                const panel = movingDivs.children[i];
                const pr = getVisiblePanelRect(panel, viewportRect, getStyle);
                if (pr) floatingPanels.push({ el: panel, rect: pr });
            }
        }

        // Check direct children of body for third-party floating extension panels
        if (doc.body?.children) {
            for (let i = doc.body.children.length - 1; i >= 0; i--) {
                const child = doc.body.children[i];
                if (SKIP_TAGS.has(child.tagName)) continue;
                if (child.id && KNOWN_BODY_REGIONS.has(child.id)) continue;
                if (child.classList?.contains('select2-container')) continue;
                if (child.classList?.contains('toast-top-right') || child.id === 'toast-container') continue;
                const cr = getVisiblePanelRect(child, viewportRect, getStyle);
                if (!cr) continue;
                const st = getStyle(child);
                const occludes =
                    st?.pointerEvents !== 'none' &&
                    !(cr.width > vw * 0.9 && cr.height > vh * 0.9);
                floatingPanels.push({ el: child, rect: cr, occludes });
            }
        }

        for (const panel of floatingPanels) {
            scanContainer(panel.el, panel.rect, activeOccluders);
            if (panel.occludes !== false) {
                activeOccluders.push(panel.rect);
            }
        }

        // -------------------------------------------------------------------
        // Layer 1.5: Open Drawers (`.drawer-content.openDrawer` ONLY!)
        // Closed drawers are completely untouched!
        // -------------------------------------------------------------------
        const openDrawers = doc.querySelectorAll?.('.drawer-content.openDrawer') ?? [];
        for (let i = openDrawers.length - 1; i >= 0; i--) {
            const drawer = openDrawers[i];
            const dr = getVisiblePanelRect(drawer, viewportRect, getStyle);
            if (dr) {
                scanContainer(drawer, dr, activeOccluders);
                activeOccluders.push(dr);
            }
        }

        // -------------------------------------------------------------------
        // Layer 1: Top Navigation Bar & Bottom Send Bar
        // -------------------------------------------------------------------
        const topHolder = doc.getElementById?.('top-settings-holder');
        if (topHolder) {
            const topToggles = topHolder.querySelectorAll?.('.drawer-toggle, .drawer-icon, .menu_button, button, a[href]') ?? [];
            for (let i = 0; i < topToggles.length; i++) {
                const el = topToggles[i];
                // Skip anything inside a drawer-content (already handled if open, ignored if closed)
                if (el.closest?.('.drawer-content')) continue;
                addCandidate(el, topHolder, viewportRect, activeOccluders);
            }
            const topBarEl = doc.getElementById?.('top-bar') ?? topHolder;
            const topRect = getVisiblePanelRect(topBarEl, viewportRect, getStyle);
            if (topRect && topRect.height < 120) {
                activeOccluders.push(topRect);
            }
        }

        const formSheld = doc.getElementById?.('form_sheld') ?? doc.getElementById?.('send_form');
        if (formSheld) {
            const fr = getVisiblePanelRect(formSheld, viewportRect, getStyle);
            if (fr) {
                scanContainer(formSheld, fr, activeOccluders);
                activeOccluders.push(fr);
            }
        }

        // -------------------------------------------------------------------
        // Layer 0: `#chat` (O(log N) binary search on `.mes` + Welcome Panel)
        // -------------------------------------------------------------------
        const chatEl = doc.getElementById?.('chat');
        if (chatEl) {
            const chatRect = getVisiblePanelRect(chatEl, viewportRect, getStyle);
            if (chatRect) {
                const mesChildren = [];
                const otherChildren = [];
                for (let i = 0; i < chatEl.children.length; i++) {
                    const child = chatEl.children[i];
                    if (child.classList?.contains('mes')) {
                        mesChildren.push(child);
                    } else {
                        otherChildren.push(child);
                    }
                }

                // Scan non-.mes children (e.g. .welcomePanel, #show_more_messages)
                for (const other of otherChildren) {
                    if (other.classList?.contains('welcomePanel')) {
                        // Fast Welcome Screen scan: prune off-screen .recentChat rows
                        const headerControls = other.querySelectorAll?.(
                            '.welcomeHeaderTitle *, .welcomeHeader *, .showMoreChats, .openTemporaryChat',
                        ) ?? [];
                        for (let i = 0; i < headerControls.length; i++) {
                            if (headerControls[i].matches?.(fullSelector)) {
                                addCandidate(headerControls[i], chatEl, chatRect, activeOccluders);
                            }
                        }
                        const recentRows = other.querySelectorAll?.('.recentChat') ?? [];
                        for (let i = 0; i < recentRows.length; i++) {
                            const row = recentRows[i];
                            const rr = row.getBoundingClientRect?.();
                            if (!rr || rr.height < 4) continue;
                            if (rr.bottom <= chatRect.top) continue;
                            if (rr.top >= chatRect.bottom) break; // Vertically ordered!
                            addCandidate(row, chatEl, chatRect, activeOccluders);
                            const rowBtns = row.querySelectorAll?.('button, .menu_button, a[href]') ?? [];
                            for (let j = 0; j < rowBtns.length; j++) {
                                addCandidate(rowBtns[j], chatEl, chatRect, activeOccluders);
                            }
                        }
                    } else {
                        const or = getVisiblePanelRect(other, chatRect, getStyle);
                        if (or) {
                            scanContainer(other, or, activeOccluders);
                        }
                    }
                }

                // O(log N) binary search for visible `.mes` turns ONLY!
                const visibleMes = findVisibleMessagesInRange(mesChildren, chatRect.top, chatRect.bottom);
                if (visibleMes.length > 0) {
                    lastVisibleMes = visibleMes[visibleMes.length - 1];
                }
                for (let i = 0; i < visibleMes.length; i++) {
                    const mes = visibleMes[i];
                    const nodes = mes.querySelectorAll?.(mesSelector);
                    if (!nodes) continue;
                    for (let j = 0; j < nodes.length; j++) {
                        addCandidate(nodes[j], chatEl, chatRect, activeOccluders);
                    }
                }
            }
        }
    }

    const deduped = deduplicateTargets(candidates).slice(0, MAX_VISIBLE_TARGETS);

    const prioritized = deduped.map((item) => ({
        ...item,
        priority: getTargetPriority(item.el, lastVisibleMes),
    }));

    prioritized.sort((a, b) => {
        if (a.priority !== b.priority) return a.priority - b.priority;
        const rowDiff = Math.round(a.rect.top / 16) - Math.round(b.rect.top / 16);
        if (rowDiff !== 0) return rowDiff;
        return a.rect.left - b.rect.left;
    });

    return prioritized;
}

/**
 * Compute screen coordinates for a hint badge near `rect`, clamped to the viewport
 * and gently nudged if another badge already occupies the exact same anchor.
 *
 * @param {{ left: number, top: number, right: number, bottom: number, width: number, height: number }} rect
 * @param {{ width: number, height: number }} viewport
 * @param {Array<{ x: number, y: number }>} placed
 * @returns {{ x: number, y: number }}
 */
export function computeBadgePosition(rect, viewport, placed = []) {
    const pad = 2;
    const badgeApproxW = 28;
    const badgeApproxH = 18;

    let x = Math.max(pad, Math.min(rect.left - 2, viewport.width - badgeApproxW - pad));
    let y = Math.max(pad, Math.min(rect.top - 2, viewport.height - badgeApproxH - pad));

    for (let attempts = 0; attempts < 6; attempts++) {
        const collision = placed.some((p) => Math.abs(p.x - x) < 14 && Math.abs(p.y - y) < 14);
        if (!collision) break;
        x = Math.min(x + 14, viewport.width - badgeApproxW - pad);
    }

    return { x: Math.round(x), y: Math.round(y) };
}

/**
 * Activate a hinted element cleanly:
 * - Text inputs / textareas / contenteditable: focus & move caret to end
 * - Range sliders: focus (so arrow keys adjust value immediately)
 * - Select dropdowns: focus and open picker if supported
 * - Select2 widgets: dispatch mousedown (how Select2 opens)
 * - Buttons / toggles / menus / links / cards:
 *   Focus trigger buttons BEFORE `el.click()` so SillyTavern popup triggers like `#options_button`
 *   (whose document click-outside handler checks `button.is(':hover, :focus')`) stay open!
 *
 * @param {Element} el
 * @returns {'focus' | 'select' | 'click'}
 */
export function activateTarget(el) {
    if (!el) return 'click';

    const tag = el.tagName?.toUpperCase() || '';
    const inputType = tag === 'INPUT' ? String(el.getAttribute?.('type') ?? el.type ?? 'text').toLowerCase() : '';

    // 1. Text-entry controls
    if (
        tag === 'TEXTAREA' ||
        el.isContentEditable ||
        (tag === 'INPUT' &&
            !['checkbox', 'radio', 'button', 'submit', 'reset', 'range', 'color', 'file', 'image'].includes(inputType))
    ) {
        el.focus?.({ preventScroll: false });
        if (typeof el.value === 'string' && typeof el.setSelectionRange === 'function') {
            try {
                const len = el.value.length;
                el.setSelectionRange(len, len);
            } catch {
                // Some input types (e.g. number, email) throw on setSelectionRange
            }
        }
        return 'focus';
    }

    // 2. Sliders
    if (tag === 'INPUT' && inputType === 'range') {
        el.focus?.({ preventScroll: false });
        return 'focus';
    }

    // 3. Native <select>
    if (tag === 'SELECT') {
        el.focus?.({ preventScroll: false });
        if (typeof el.showPicker === 'function') {
            try {
                el.showPicker();
            } catch {
                // Ignore if browser blocks showPicker
            }
        }
        return 'select';
    }

    // 4. Select2 dropdown trigger (opens on mousedown rather than click)
    if (el.matches?.('.select2-selection')) {
        const rect = el.getBoundingClientRect?.() ?? { left: 0, top: 0, width: 0, height: 0 };
        const view = el.ownerDocument?.defaultView ?? (typeof window !== 'undefined' ? window : undefined);
        const opts = {
            bubbles: true,
            cancelable: true,
            composed: true,
            view,
            clientX: rect.left + rect.width / 2,
            clientY: rect.top + rect.height / 2,
            button: 0,
            buttons: 1,
        };
        try {
            el.dispatchEvent(new MouseEvent('mousedown', opts));
            el.dispatchEvent(new MouseEvent('mouseup', { ...opts, buttons: 0 }));
        } catch {
            // Fall through to click
        }
        el.click?.();
        return 'click';
    }

    // 5. Clicking an item INSIDE `#options` should blur `#options_button` so `#options`
    //    auto-closes cleanly after the chosen option runs.
    const doc = el.ownerDocument ?? (typeof document !== 'undefined' ? document : null);
    const insideOptionsMenu = Boolean(el.closest?.('#options'));
    if (insideOptionsMenu) {
        if (doc?.activeElement?.id === 'options_button') {
            doc.activeElement.blur?.();
        }
    } else if (typeof el.focus === 'function') {
        const isPopupTrigger =
            el.id === 'options_button' ||
            el.id === 'extensionsMenuButton' ||
            el.id === 'export_button' ||
            el.matches?.('.interactable, .menu_button, .drawer-toggle, button, a[href]');

        if (isPopupTrigger) {
            const hasTabIndex = el.hasAttribute?.('tabindex');
            if (!hasTabIndex && (el.tabIndex === undefined || el.tabIndex < 0)) {
                el.setAttribute?.('tabindex', '-1');
            }
            try {
                el.focus({ preventScroll: true });
            } catch {
                // Ignore if element cannot receive focus
            }
        }
    }

    if (typeof el.click === 'function') {
        el.click();
    } else {
        const view = el.ownerDocument?.defaultView ?? (typeof window !== 'undefined' ? window : undefined);
        el.dispatchEvent?.(new MouseEvent('click', { bubbles: true, cancelable: true, composed: true, view, button: 0 }));
    }

    return 'click';
}
