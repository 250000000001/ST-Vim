import test from 'node:test';
import assert from 'node:assert/strict';

import {
    DEFAULT_HINT_CHARS,
    sanitizeHintChars,
    generateHintStrings,
    filterHints,
    parseShortcut,
    formatShortcutFromEvent,
    matchesShortcut,
    isModifierKey,
    isTextEditable,
} from '../hints.js';

import {
    INTERACTIVE_SELECTOR,
    intersectRects,
    isOccludedByRects,
    findVisibleMessagesInRange,
    deduplicateTargets,
    computeBadgePosition,
    getTargetPriority,
    activateTarget,
    collectClickableTargets,
} from '../scanner.js';

import {
    isVerticallyScrollable,
    findScrollContainer,
    scrollContainerBy,
    scrollContainerToEdge,
} from '../scroller.js';

// ---------------------------------------------------------------------------
// Hint pool & prefix-free generation (Vimium AlphabetHints)
// ---------------------------------------------------------------------------

test('sanitizeHintChars deduplicates, lowercases, strips whitespace, and falls back', () => {
    assert.equal(sanitizeHintChars('  AaSs Dd  '), 'asd');
    assert.equal(sanitizeHintChars('a'), DEFAULT_HINT_CHARS);
    assert.equal(sanitizeHintChars('   '), DEFAULT_HINT_CHARS);
    assert.equal(sanitizeHintChars(null), DEFAULT_HINT_CHARS);
    assert.equal(sanitizeHintChars('FJKL'), 'fjkl');
});

test('generateHintStrings handles 0, 1, exact pool size, and large counts', () => {
    assert.deepEqual(generateHintStrings(0), []);
    assert.deepEqual(generateHintStrings(-5), []);
    assert.deepEqual(generateHintStrings(1, 'asdf'), ['a']);
    assert.deepEqual(generateHintStrings(4, 'asdf'), ['a', 's', 'd', 'f']);

    for (const count of [2, 5, 14, 15, 28, 60, 196, 250, 500]) {
        const hints = generateHintStrings(count, DEFAULT_HINT_CHARS);
        assert.equal(hints.length, count, `expected ${count} hints`);
        assert.equal(new Set(hints).size, count, `expected unique hints for count=${count}`);

        const sorted = [...hints].sort();
        for (let i = 0; i < sorted.length - 1; i++) {
            assert.equal(
                sorted[i + 1].startsWith(sorted[i]),
                false,
                `prefix collision: "${sorted[i]}" is a prefix of "${sorted[i + 1]}" (count=${count})`,
            );
        }

        for (let i = 0; i < hints.length - 1; i++) {
            assert.ok(hints[i].length <= hints[i + 1].length);
        }

        for (const h of hints) {
            for (const ch of h) {
                assert.ok(DEFAULT_HINT_CHARS.includes(ch));
            }
        }
    }
});

test('filterHints narrows matches and identifies exact prefix-free match', () => {
    const entries = ['a', 'd', 'ss', 'sa', 'sd'].map((code) => ({ code }));

    const r0 = filterHints(entries, '');
    assert.equal(r0.matches.length, 5);
    assert.equal(r0.exactMatch, null);

    const r1 = filterHints(entries, 's');
    assert.deepEqual(
        r1.matches.map((e) => e.code),
        ['ss', 'sa', 'sd'],
    );
    assert.equal(r1.exactMatch, null);

    const r2 = filterHints(entries, 'SA');
    assert.deepEqual(
        r2.matches.map((e) => e.code),
        ['sa'],
    );
    assert.equal(r2.exactMatch?.code, 'sa');

    const r3 = filterHints(entries, 'z');
    assert.equal(r3.matches.length, 0);
    assert.equal(r3.exactMatch, null);
});

// ---------------------------------------------------------------------------
// Shortcut parsing & matching
// ---------------------------------------------------------------------------

test('parseShortcut handles single keys, modifiers, Space, and invalid strings', () => {
    assert.deepEqual(parseShortcut('f'), {
        valid: true,
        key: 'f',
        ctrl: false,
        alt: false,
        shift: false,
        meta: false,
    });
    assert.deepEqual(parseShortcut('Alt+f'), {
        valid: true,
        key: 'f',
        ctrl: false,
        alt: true,
        shift: false,
        meta: false,
    });
    assert.deepEqual(parseShortcut('Ctrl+Shift+Space'), {
        valid: true,
        key: ' ',
        ctrl: true,
        alt: false,
        shift: true,
        meta: false,
    });
    assert.deepEqual(parseShortcut('Alt++'), {
        valid: true,
        key: '+',
        ctrl: false,
        alt: true,
        shift: false,
        meta: false,
    });
    assert.equal(parseShortcut('').valid, false);
    assert.equal(parseShortcut('Ctrl').valid, false);
    assert.equal(parseShortcut('Bogus+f').valid, false);
});

test('matchesShortcut matches normal, Shift, Alt+macOS dead char, and non-Latin layouts', () => {
    const plainF = parseShortcut('f');
    const shiftF = parseShortcut('Shift+f');
    const altF = parseShortcut('Alt+f');

    assert.equal(matchesShortcut({ key: 'f', code: 'KeyF', ctrlKey: false, altKey: false, shiftKey: false, metaKey: false }, plainF), true);
    assert.equal(matchesShortcut({ key: 'F', code: 'KeyF', ctrlKey: false, altKey: false, shiftKey: true, metaKey: false }, plainF), false);
    assert.equal(matchesShortcut({ key: 'F', code: 'KeyF', ctrlKey: false, altKey: false, shiftKey: true, metaKey: false }, shiftF), true);
    assert.equal(matchesShortcut({ key: 'ƒ', code: 'KeyF', ctrlKey: false, altKey: true, shiftKey: false, metaKey: false }, altF), true);
    assert.equal(matchesShortcut({ key: 'а', code: 'KeyF', ctrlKey: false, altKey: false, shiftKey: false, metaKey: false }, plainF), true);
    assert.equal(matchesShortcut({ key: 'f', code: 'KeyF', isComposing: true }, plainF), false);
});

test('formatShortcutFromEvent builds canonical shortcut strings', () => {
    assert.equal(formatShortcutFromEvent({ key: 'Shift', shiftKey: true }), null);
    assert.equal(formatShortcutFromEvent({ key: 'f', code: 'KeyF' }), 'f');
    assert.equal(formatShortcutFromEvent({ key: 'ƒ', code: 'KeyF', altKey: true }), 'Alt+f');
    assert.equal(formatShortcutFromEvent({ key: 'F', code: 'KeyF', shiftKey: true }), 'Shift+f');
    assert.equal(formatShortcutFromEvent({ key: ' ', ctrlKey: true }), 'Ctrl+Space');
});

test('isModifierKey and isTextEditable behave accurately', () => {
    assert.equal(isModifierKey('Shift'), true);
    assert.equal(isModifierKey('Control'), true);
    assert.equal(isModifierKey('f'), false);

    assert.equal(isTextEditable({ tagName: 'TEXTAREA' }), true);
    assert.equal(isTextEditable({ tagName: 'SELECT' }), true);
    assert.equal(isTextEditable({ tagName: 'INPUT', type: 'text' }), true);
    assert.equal(isTextEditable({ tagName: 'INPUT', type: 'search' }), true);
    assert.equal(isTextEditable({ tagName: 'INPUT', type: 'checkbox' }), false);
    assert.equal(isTextEditable({ tagName: 'INPUT', type: 'range' }), false);
    assert.equal(isTextEditable({ tagName: 'BUTTON' }), false);
    assert.equal(isTextEditable({ tagName: 'DIV', isContentEditable: true }), true);
    assert.equal(isTextEditable(null), false);
});

// ---------------------------------------------------------------------------
// Scanner: Recent Chats, Personas, Deduplication, Binary Search, Activation
// ---------------------------------------------------------------------------

test('INTERACTIVE_SELECTOR includes Welcome Screen recent chats, saved chat blocks, personas, Author Note controls, and menu items', () => {
    assert.ok(INTERACTIVE_SELECTOR.includes('.recentChat'));
    assert.ok(INTERACTIVE_SELECTOR.includes('.select_chat_block'));
    assert.ok(INTERACTIVE_SELECTOR.includes('.avatar-container'));
    assert.ok(INTERACTIVE_SELECTOR.includes('.bg_example'));
    assert.ok(INTERACTIVE_SELECTOR.includes('.floating_panel_close'));
    assert.ok(INTERACTIVE_SELECTOR.includes('.inline-drawer-maximize'));
    assert.ok(INTERACTIVE_SELECTOR.includes('.options-content a'));
    assert.ok(INTERACTIVE_SELECTOR.includes('#extensionsMenu > .extension_container > div'));
});

test('isOccludedByRects detects covered centers in O(1) without elementFromPoint', () => {
    const panelRect = { left: 100, top: 100, right: 500, bottom: 500 };
    assert.equal(isOccludedByRects({ left: 150, top: 150, right: 200, bottom: 180, width: 50, height: 30 }, [panelRect]), true);
    assert.equal(isOccludedByRects({ left: 10, top: 10, right: 50, bottom: 40, width: 40, height: 30 }, [panelRect]), false);
    assert.equal(isOccludedByRects({ left: 150, top: 150, right: 200, bottom: 180, width: 50, height: 30 }, []), false);
});

test('collectClickableTargets detects open Author Note (#floatingPrompt) without .openDrawer and skips occluded #chat buttons', () => {
    const anTextarea = {
        nodeType: 1,
        tagName: 'TEXTAREA',
        id: 'extension_floating_prompt',
        style: {},
        classList: { contains: () => false },
        hasAttribute: () => false,
        getAttribute: () => null,
        getBoundingClientRect: () => ({ left: 120, top: 150, right: 420, bottom: 300, width: 300, height: 150 }),
        matches: (sel) => sel.includes('textarea'),
        contains: (other) => other === anTextarea,
        closest: (sel) => (sel.includes('#movingDivs') ? {} : null),
    };
    const anClose = {
        nodeType: 1,
        tagName: 'DIV',
        id: 'ANClose',
        style: {},
        classList: { contains: (c) => c === 'floating_panel_close' },
        hasAttribute: () => false,
        getAttribute: () => null,
        getBoundingClientRect: () => ({ left: 430, top: 110, right: 454, bottom: 134, width: 24, height: 24 }),
        matches: (sel) => sel.includes('.floating_panel_close'),
        contains: (other) => other === anClose,
        closest: (sel) => (sel.includes('#movingDivs') ? {} : null),
    };
    const floatingPrompt = {
        nodeType: 1,
        tagName: 'DIV',
        id: 'floatingPrompt',
        style: { display: 'flex' },
        classList: { contains: (c) => c === 'drawer-content' }, // NOTE: NO .openDrawer class!
        getBoundingClientRect: () => ({ left: 100, top: 100, right: 470, bottom: 500, width: 370, height: 400 }),
        matches: (sel) => sel.includes('.drawer-content'),
        querySelectorAll: () => [anClose, anTextarea],
        parentElement: null,
    };
    anTextarea.parentElement = floatingPrompt;
    anClose.parentElement = floatingPrompt;

    const coveredChatBtn = {
        nodeType: 1,
        tagName: 'DIV',
        id: 'covered_btn',
        style: {},
        classList: { contains: (c) => c === 'mes_button' },
        hasAttribute: () => false,
        getAttribute: () => null,
        getBoundingClientRect: () => ({ left: 200, top: 200, right: 230, bottom: 230, width: 30, height: 30 }),
        matches: (sel) => sel.includes('.mes_button'),
        contains: (other) => other === coveredChatBtn,
        closest: () => null,
    };
    const visibleChatBtn = {
        nodeType: 1,
        tagName: 'DIV',
        id: 'visible_btn',
        style: {},
        classList: { contains: (c) => c === 'mes_button' },
        hasAttribute: () => false,
        getAttribute: () => null,
        getBoundingClientRect: () => ({ left: 600, top: 200, right: 630, bottom: 230, width: 30, height: 30 }),
        matches: (sel) => sel.includes('.mes_button'),
        contains: (other) => other === visibleChatBtn,
        closest: () => null,
    };
    const mes = {
        nodeType: 1,
        tagName: 'DIV',
        classList: { contains: (c) => c === 'mes' },
        getBoundingClientRect: () => ({ left: 0, top: 50, right: 800, bottom: 600, width: 800, height: 550 }),
        querySelectorAll: () => [coveredChatBtn, visibleChatBtn],
        contains: (other) => other === mes || other === coveredChatBtn || other === visibleChatBtn,
    };
    const chatEl = {
        nodeType: 1,
        tagName: 'DIV',
        id: 'chat',
        style: {},
        classList: { contains: () => false },
        children: [mes],
        getBoundingClientRect: () => ({ left: 0, top: 40, right: 900, bottom: 700, width: 900, height: 660 }),
    };
    coveredChatBtn.parentElement = mes;
    visibleChatBtn.parentElement = mes;
    mes.parentElement = chatEl;

    const movingDivs = {
        nodeType: 1,
        tagName: 'DIV',
        id: 'movingDivs',
        children: [floatingPrompt],
    };

    const mockDoc = {
        body: { children: [movingDivs, chatEl] },
        querySelector: () => null,
        querySelectorAll: () => [],
        getElementById: (id) => (id === 'movingDivs' ? movingDivs : id === 'chat' ? chatEl : null),
    };
    const mockWin = {
        innerWidth: 1280,
        innerHeight: 720,
        getComputedStyle: () => ({ display: 'flex', visibility: 'visible', opacity: '1', pointerEvents: 'auto', overflow: 'visible', overflowX: 'visible', overflowY: 'visible' }),
    };

    const targets = collectClickableTargets({ doc: mockDoc, win: mockWin });
    const ids = targets.map((t) => t.el.id);

    assert.ok(ids.includes('ANClose'), 'Author Note close button must be detected');
    assert.ok(ids.includes('extension_floating_prompt'), 'Author Note textarea must be detected');
    assert.ok(ids.includes('visible_btn'), 'Uncovered chat button must still be detected');
    assert.ok(!ids.includes('covered_btn'), 'Chat button covered by Author Note must be occluded');
    // Author Note controls must have higher priority (0) than chat button (1)
    assert.equal(targets.find((t) => t.el.id === 'ANClose').priority, 0);
});

test('intersectRects computes visible overlap or null', () => {
    assert.deepEqual(
        intersectRects({ left: 10, top: 10, right: 100, bottom: 50 }, { left: 0, top: 20, right: 80, bottom: 100 }),
        { left: 10, top: 20, right: 80, bottom: 50, width: 70, height: 30 },
    );
    assert.equal(
        intersectRects({ left: 0, top: 0, right: 20, bottom: 20 }, { left: 25, top: 0, right: 50, bottom: 20 }),
        null,
    );
});

test('findVisibleMessagesInRange finds only on-screen messages in O(log N) on a 2000-turn chat', () => {
    let rectCalls = 0;
    const total = 2000;
    const msgHeight = 100;
    // Simulate scrolled down to y = 150,000..150,600 (messages 1500..1505 visible in viewport 0..600)
    const scrollOffset = 150000;

    const messages = Array.from({ length: total }, (_, idx) => ({
        id: `mes_${idx}`,
        getBoundingClientRect() {
            rectCalls++;
            const top = idx * msgHeight - scrollOffset;
            return { left: 0, right: 800, top, bottom: top + msgHeight, width: 800, height: msgHeight };
        },
    }));

    const visible = findVisibleMessagesInRange(messages, 0, 600);
    assert.deepEqual(
        visible.map((m) => m.id),
        ['mes_1500', 'mes_1501', 'mes_1502', 'mes_1503', 'mes_1504', 'mes_1505'],
    );
    // Must use binary search: far fewer than linear 2000 rect lookups!
    assert.ok(rectCalls < 30, `expected < 30 rect calls via binary search, got ${rectCalls}`);
});

function makeMockEl({ tagName = 'DIV', classes = [], id = '', attrs = {}, children = [], closestMap = {} } = {}) {
    const classSet = new Set(classes);
    const el = {
        tagName,
        id,
        children,
        getAttribute(name) {
            return attrs[name] ?? null;
        },
        hasAttribute(name) {
            return Object.prototype.hasOwnProperty.call(attrs, name);
        },
        setAttribute(name, val) {
            attrs[name] = String(val);
        },
        matches(selector) {
            return selector.split(',').some((part) => {
                const s = part.trim();
                if (s.startsWith('.')) return classSet.has(s.slice(1));
                if (s.startsWith('#')) return id === s.slice(1);
                return s.toUpperCase() === tagName;
            });
        },
        contains(other) {
            if (other === el) return true;
            return el.children.some((c) => c === other || c.contains?.(other));
        },
        querySelector(sel) {
            return el.children.find((c) => c.matches?.(sel)) ?? null;
        },
        closest(selector) {
            for (const [key, val] of Object.entries(closestMap)) {
                if (selector.includes(key)) return val;
            }
            return null;
        },
    };
    return el;
}

test('deduplicateTargets keeps .recentChat row AND its rename/delete action buttons', () => {
    const renameBtn = makeMockEl({ tagName: 'BUTTON', classes: ['menu_button', 'renameChat'] });
    const deleteBtn = makeMockEl({ tagName: 'BUTTON', classes: ['menu_button', 'deleteChat'] });
    const recentChat = makeMockEl({ tagName: 'DIV', classes: ['recentChat'], children: [renameBtn, deleteBtn] });

    const icon = makeMockEl({ tagName: 'DIV', classes: ['drawer-icon'] });
    const toggle = makeMockEl({ tagName: 'DIV', classes: ['drawer-toggle'], children: [icon] });

    const checkbox = makeMockEl({ tagName: 'INPUT', attrs: { type: 'checkbox' } });
    const label = makeMockEl({ tagName: 'LABEL', classes: ['checkbox_label'], children: [checkbox] });

    const result = deduplicateTargets([
        { el: recentChat, rect: { left: 10, top: 100, right: 710, bottom: 170, width: 700, height: 70 } },
        { el: renameBtn, rect: { left: 650, top: 105, right: 675, bottom: 130, width: 25, height: 25 } },
        { el: deleteBtn, rect: { left: 680, top: 105, right: 705, bottom: 130, width: 25, height: 25 } },
        { el: toggle, rect: { left: 10, top: 10, right: 40, bottom: 40, width: 30, height: 30 } },
        { el: icon, rect: { left: 10, top: 10, right: 40, bottom: 40, width: 30, height: 30 } },
        { el: label, rect: { left: 10, top: 60, right: 160, bottom: 80, width: 150, height: 20 } },
        { el: checkbox, rect: { left: 10, top: 60, right: 26, bottom: 76, width: 16, height: 16 } },
    ]);

    assert.deepEqual(
        result.map((r) => r.el),
        [recentChat, renameBtn, deleteBtn, toggle, checkbox],
    );
});

test('getTargetPriority ranks popups > send bar & latest message > top bar/welcome > older messages', () => {
    const popupBtn = makeMockEl({ closestMap: { '.popup': {} } });
    const sendBtn = makeMockEl({ closestMap: { '#send_form': {} } });
    const lastMesBtn = makeMockEl();
    const lastMes = makeMockEl({ children: [lastMesBtn] });
    const recentChatBtn = makeMockEl({ closestMap: { '.welcomePanel': {} } });
    const oldMesBtn = makeMockEl();

    assert.equal(getTargetPriority(popupBtn, lastMes), 0);
    assert.equal(getTargetPriority(sendBtn, lastMes), 1);
    assert.equal(getTargetPriority(lastMesBtn, lastMes), 1);
    assert.equal(getTargetPriority(recentChatBtn, lastMes), 2);
    assert.equal(getTargetPriority(oldMesBtn, lastMes), 3);
});

test('computeBadgePosition clamps inside viewport and nudges colliding badges', () => {
    const viewport = { width: 800, height: 600 };
    const p1 = computeBadgePosition({ left: 0, top: 0, right: 30, bottom: 20, width: 30, height: 20 }, viewport, []);
    assert.ok(p1.x >= 2 && p1.y >= 2);

    const p2 = computeBadgePosition({ left: 0, top: 0, right: 30, bottom: 20, width: 30, height: 20 }, viewport, [p1]);
    assert.ok(p2.x > p1.x);

    const pEdge = computeBadgePosition({ left: 795, top: 595, right: 820, bottom: 610, width: 25, height: 15 }, viewport, []);
    assert.ok(pEdge.x <= viewport.width - 30);
    assert.ok(pEdge.y <= viewport.height - 20);
});

test('activateTarget focuses #options_button before clicking so submenu stays open', () => {
    const order = [];
    const attrs = {};
    const optionsBtn = {
        tagName: 'DIV',
        id: 'options_button',
        tabIndex: -1,
        hasAttribute: (k) => Object.prototype.hasOwnProperty.call(attrs, k),
        setAttribute: (k, v) => {
            attrs[k] = v;
            order.push(`setAttribute:${k}=${v}`);
        },
        matches: (sel) => sel.includes('.interactable'),
        closest: () => null,
        focus(opts) {
            order.push(`focus:${opts?.preventScroll}`);
        },
        click() {
            order.push('click');
        },
    };

    assert.equal(activateTarget(optionsBtn), 'click');
    assert.deepEqual(order, ['setAttribute:tabindex=-1', 'focus:true', 'click']);
});

test('activateTarget focuses textareas at end and clicks buttons', () => {
    let focused = false;
    let selRange = null;
    const textarea = {
        tagName: 'TEXTAREA',
        value: 'hello',
        focus() {
            focused = true;
        },
        setSelectionRange(a, b) {
            selRange = [a, b];
        },
    };
    assert.equal(activateTarget(textarea), 'focus');
    assert.equal(focused, true);
    assert.deepEqual(selRange, [5, 5]);

    let clicked = false;
    const button = {
        tagName: 'DIV',
        closest: () => null,
        click() {
            clicked = true;
        },
    };
    assert.equal(activateTarget(button), 'click');
    assert.equal(clicked, true);
});

// ---------------------------------------------------------------------------
// Scroller: SillyTavern container detection & Vim scrolling (j / k / d / u / gg / G)
// ---------------------------------------------------------------------------

test('isVerticallyScrollable checks scrollHeight and overflowY', () => {
    const mockWin = {
        getComputedStyle: (el) => el._style,
    };
    const scrollable = { scrollHeight: 1200, clientHeight: 400, _style: { display: 'block', visibility: 'visible', overflowY: 'auto' } };
    const notTallEnough = { scrollHeight: 400, clientHeight: 400, _style: { display: 'block', visibility: 'visible', overflowY: 'auto' } };
    const hiddenOverflow = { scrollHeight: 1200, clientHeight: 400, _style: { display: 'block', visibility: 'visible', overflowY: 'hidden' } };

    assert.equal(isVerticallyScrollable(scrollable, mockWin), true);
    assert.equal(isVerticallyScrollable(notTallEnough, mockWin), false);
    assert.equal(isVerticallyScrollable(hiddenOverflow, mockWin), false);
});

test('findScrollContainer prefers open modal > open drawer > #chat', () => {
    const makePane = (id, scrollHeight, clientHeight) => ({
        id,
        nodeType: 1,
        scrollHeight,
        clientHeight,
        _style: { display: 'block', visibility: 'visible', overflowY: 'auto' },
        getBoundingClientRect: () => ({ width: 500, height: clientHeight }),
        contains: () => false,
        querySelectorAll: () => [],
    });

    const chat = makePane('chat', 3000, 600);
    const drawer = makePane('drawer', 2000, 500);
    const modal = makePane('modal', 1500, 400);

    const mockWin = { getComputedStyle: (el) => el._style };

    // Only #chat open
    const docChatOnly = {
        querySelectorAll: () => [],
        querySelector: () => null,
        getElementById: (id) => (id === 'chat' ? chat : null),
        scrollingElement: null,
    };
    assert.equal(findScrollContainer({ doc: docChatOnly, win: mockWin }), chat);

    // Open drawer takes precedence over #chat when not hovering #chat
    const docWithDrawer = {
        querySelectorAll: (sel) => (sel.includes('openDrawer') ? [drawer] : []),
        querySelector: () => null,
        getElementById: (id) => (id === 'chat' ? chat : null),
        scrollingElement: null,
    };
    assert.equal(findScrollContainer({ doc: docWithDrawer, win: mockWin }), drawer);

    // Open modal takes precedence over everything
    const docWithModal = {
        querySelectorAll: (sel) => (sel === 'dialog[open]' ? [modal] : sel.includes('openDrawer') ? [drawer] : []),
        querySelector: () => null,
        getElementById: (id) => (id === 'chat' ? chat : null),
        scrollingElement: null,
    };
    assert.equal(findScrollContainer({ doc: docWithModal, win: mockWin }), modal);
});

test('scrollContainerBy and scrollContainerToEdge invoke scrollBy / scrollTo cleanly', () => {
    const calls = [];
    const el = {
        scrollHeight: 2000,
        clientHeight: 500,
        scrollBy(opts) {
            calls.push({ fn: 'scrollBy', ...opts });
        },
        scrollTo(opts) {
            calls.push({ fn: 'scrollTo', ...opts });
        },
    };

    assert.equal(scrollContainerBy(el, 120, { smooth: true }), true);
    assert.equal(scrollContainerBy(el, -120, { smooth: false }), true);
    assert.equal(scrollContainerToEdge(el, 'top', { smooth: true }), true);
    assert.equal(scrollContainerToEdge(el, 'bottom', { smooth: true }), true);

    assert.deepEqual(calls, [
        { fn: 'scrollBy', top: 120, left: 0, behavior: 'smooth' },
        { fn: 'scrollBy', top: -120, left: 0, behavior: 'auto' },
        { fn: 'scrollTo', top: 0, left: 0, behavior: 'smooth' },
        { fn: 'scrollTo', top: 1500, left: 0, behavior: 'smooth' },
    ]);
});
