/**
 * SillyTavern-aware Vimium scrolling (j / k / d / u / gg / G).
 *
 * Unlike typical web pages where `window` scrolls, SillyTavern scrolls specific
 * containers: `#chat`, open `.drawer-content.openDrawer` panels (and inner scroll
 * panes like `#rm_print_characters_block` or `#user_avatar_block`), or active modals
 * (`dialog[open]`, `.popup`, `#select_chat_div`).
 */

/**
 * Return true if `el` can currently scroll vertically.
 *
 * @param {Element | null | undefined} el
 * @param {Window} [win]
 * @returns {boolean}
 */
export function isVerticallyScrollable(el, win = typeof window !== 'undefined' ? window : undefined) {
    if (!el) return false;
    const scrollHeight = el.scrollHeight ?? 0;
    const clientHeight = el.clientHeight ?? 0;
    if (scrollHeight <= clientHeight + 4) return false;

    if (win && typeof win.getComputedStyle === 'function') {
        const style = win.getComputedStyle(el);
        if (!style) return false;
        if (style.display === 'none' || style.visibility === 'hidden') return false;
        const oy = style.overflowY || style.overflow || '';
        if (oy !== 'auto' && oy !== 'scroll' && oy !== 'overlay') {
            // Root scrolling element may have overflowY: 'visible'
            const doc = el.ownerDocument;
            if (!doc || el !== doc.scrollingElement) {
                return false;
            }
        }
    }

    return true;
}

/**
 * Walk upward from `startEl` to find the nearest vertically scrollable ancestor
 * inside `boundary` (if provided).
 *
 * @param {Element | null} startEl
 * @param {Element | null} boundary
 * @param {Window} win
 * @returns {Element | null}
 */
function findScrollableAncestor(startEl, boundary, win) {
    let cur = startEl;
    while (cur && cur.nodeType === 1) {
        if (isVerticallyScrollable(cur, win)) return cur;
        if (boundary && cur === boundary) break;
        cur = cur.parentElement;
    }
    return null;
}

/**
 * Pick the largest visible vertically scrollable container inside `root`.
 *
 * @param {Element} root
 * @param {Window} win
 * @returns {Element | null}
 */
function findLargestScrollableIn(root, win) {
    if (!root) return null;

    let best = null;
    let bestArea = -1;

    const consider = (el) => {
        if (!isVerticallyScrollable(el, win)) return;
        const rect = el.getBoundingClientRect?.();
        const area = rect ? rect.width * rect.height : (el.clientWidth || 1) * (el.clientHeight || 1);
        if (rect && (rect.width < 20 || rect.height < 20)) return;
        if (area > bestArea) {
            bestArea = area;
            best = el;
        }
    };

    consider(root);

    const descendants = root.querySelectorAll?.('div, section, ul, main, aside, article, .popup-content, #select_chat_div, #rm_print_characters_block, #user_avatar_block') ?? [];
    for (const child of descendants) {
        consider(child);
    }

    return best;
}

/**
 * Determine the best active scroll container in SillyTavern right now.
 *
 * Priority:
 * 1. Active modal/popup (`dialog[open]`, visible `.popup`, `#dialogue_popup`, `#shadow_select_chat_popup`)
 * 2. Active open drawer (`.drawer-content.openDrawer`) — preferring the hovered pane if mouse is over it
 * 3. Hovered scrollable element (e.g. `#chat` when a drawer isn't covering it)
 * 4. `#chat` (active chat log or Welcome Screen recent chats)
 * 5. `document.scrollingElement`
 *
 * @param {{ doc?: Document, win?: Window, hoveredEl?: Element | null }} [options]
 * @returns {Element | null}
 */
export function findScrollContainer(options = {}) {
    const doc = options.doc ?? (typeof document !== 'undefined' ? document : null);
    const win = options.win ?? (typeof window !== 'undefined' ? window : undefined);
    const hoveredEl = options.hoveredEl ?? null;
    if (!doc) return null;

    // 1. Open modal popups (highest layer)
    const modalSelectors = [
        'dialog[open]',
        '.popup:not([style*="display: none"])',
        '#shadow_select_chat_popup',
        '#dialogue_popup',
    ];
    for (const sel of modalSelectors) {
        const nodes = doc.querySelectorAll?.(sel) ?? [];
        for (let i = nodes.length - 1; i >= 0; i--) {
            const modal = nodes[i];
            const style = win?.getComputedStyle?.(modal);
            if (style && (style.display === 'none' || style.visibility === 'hidden')) continue;
            const rect = modal.getBoundingClientRect?.();
            if (rect && (rect.width < 10 || rect.height < 10)) continue;

            if (hoveredEl && modal.contains?.(hoveredEl)) {
                const hoveredScroll = findScrollableAncestor(hoveredEl, modal, win);
                if (hoveredScroll) return hoveredScroll;
            }
            const inner = findLargestScrollableIn(modal, win);
            if (inner) return inner;
        }
    }

    // 2. Open floating menus if scrollable (e.g. #extensionsMenu / #options)
    for (const menuId of ['extensionsMenu', 'options']) {
        const menu = doc.getElementById?.(menuId);
        if (menu && isVerticallyScrollable(menu, win)) {
            if (!hoveredEl || menu.contains?.(hoveredEl)) {
                return menu;
            }
        }
    }

    // 2.5 Open floating subtabs in `#movingDivs` (e.g. Author's Note `#floatingPrompt`, CFG Scale)
    const movingDivs = doc.getElementById?.('movingDivs');
    if (movingDivs?.children?.length) {
        const chatEl = doc.getElementById?.('chat');
        const hoveringChat = Boolean(hoveredEl && chatEl && chatEl.contains?.(hoveredEl));
        if (!hoveringChat) {
            for (let i = movingDivs.children.length - 1; i >= 0; i--) {
                const panel = movingDivs.children[i];
                const style = win?.getComputedStyle?.(panel);
                if (style && (style.display === 'none' || style.visibility === 'hidden')) continue;
                const rect = panel.getBoundingClientRect?.();
                if (rect && (rect.width < 10 || rect.height < 10)) continue;

                if (hoveredEl && panel.contains?.(hoveredEl)) {
                    const hoveredScroll = findScrollableAncestor(hoveredEl, panel, win);
                    if (hoveredScroll) return hoveredScroll;
                }
                const inner = findLargestScrollableIn(panel, win);
                if (inner) return inner;
            }
        }
    }

    // 3. Open drawer panels (.drawer-content.openDrawer)
    const openDrawers = doc.querySelectorAll?.('.drawer-content.openDrawer') ?? [];
    if (openDrawers.length > 0) {
        // If mouse is explicitly hovering #chat while a side drawer is open, scroll #chat
        const chatEl = doc.getElementById?.('chat');
        if (hoveredEl && chatEl && chatEl.contains?.(hoveredEl) && isVerticallyScrollable(chatEl, win)) {
            return chatEl;
        }

        for (let i = openDrawers.length - 1; i >= 0; i--) {
            const drawer = openDrawers[i];
            const style = win?.getComputedStyle?.(drawer);
            if (style && (style.display === 'none' || style.visibility === 'hidden')) continue;

            if (hoveredEl && drawer.contains?.(hoveredEl)) {
                const hoveredScroll = findScrollableAncestor(hoveredEl, drawer, win);
                if (hoveredScroll) return hoveredScroll;
            }
            const inner = findLargestScrollableIn(drawer, win);
            if (inner) return inner;
        }
    }

    // 4. Hovered scrollable element
    if (hoveredEl) {
        const hoveredScroll = findScrollableAncestor(hoveredEl, null, win);
        if (hoveredScroll) return hoveredScroll;
    }

    // 5. Primary SillyTavern chat / welcome container
    const chat = doc.getElementById?.('chat');
    if (isVerticallyScrollable(chat, win)) {
        return chat;
    }

    // 6. Welcome panel recent chat list fallback
    const welcomeList = doc.querySelector?.('.welcomeRecent, .recentChatList');
    if (isVerticallyScrollable(welcomeList, win)) {
        return welcomeList;
    }

    // 7. Document root fallback
    if (isVerticallyScrollable(doc.scrollingElement, win)) {
        return doc.scrollingElement;
    }

    return chat ?? doc.scrollingElement ?? null;
}

/**
 * Scroll `container` vertically by `deltaY` pixels.
 * Uses `behavior: 'auto'` when repeating (key held down) for zero-lag continuous scrolling,
 * and `behavior: 'smooth'` on single taps.
 *
 * @param {Element | null} container
 * @param {number} deltaY
 * @param {{ smooth?: boolean }} [opts]
 * @returns {boolean}
 */
export function scrollContainerBy(container, deltaY, { smooth = true } = {}) {
    if (!container || !Number.isFinite(deltaY) || deltaY === 0) return false;

    if (typeof container.scrollBy === 'function') {
        container.scrollBy({
            top: deltaY,
            left: 0,
            behavior: smooth ? 'smooth' : 'auto',
        });
    } else if (typeof container.scrollTop === 'number') {
        container.scrollTop += deltaY;
    } else {
        return false;
    }
    return true;
}

/**
 * Scroll `container` to the very top or very bottom.
 *
 * @param {Element | null} container
 * @param {'top' | 'bottom'} edge
 * @param {{ smooth?: boolean }} [opts]
 * @returns {boolean}
 */
export function scrollContainerToEdge(container, edge, { smooth = true } = {}) {
    if (!container) return false;
    const targetTop = edge === 'top' ? 0 : Math.max(0, (container.scrollHeight ?? 0) - (container.clientHeight ?? 0));

    if (typeof container.scrollTo === 'function') {
        container.scrollTo({
            top: targetTop,
            left: 0,
            behavior: smooth ? 'smooth' : 'auto',
        });
    } else if (typeof container.scrollTop === 'number') {
        container.scrollTop = targetTop;
    } else {
        return false;
    }
    return true;
}
