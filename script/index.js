/**
 * ST Vimium (Keyboard Hints & Vim Scrolling) for SillyTavern
 *
 * Inspired by philc/vimium:
 * - Press `f` (outside text inputs) or `Alt+f` (anywhere, even while typing in the chat box)
 *   to display short keystroke badges next to every visible button, chat row, persona, and control.
 * - Type the badge letters to click/focus that element without touching the mouse.
 * - Press `Shift+f` for continuous mode (keeps showing hints after each click until Escape).
 * - Press `j` / `k` (scroll down/up), `d` / `u` (half-page down/up), `gg` / `G` (top/bottom)
 *   to scroll the active SillyTavern panel (chat, drawer, or modal) smoothly.
 */

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
} from './hints.js';

import {
    collectClickableTargets,
    computeBadgePosition,
    activateTarget,
} from './scanner.js';

import {
    findScrollContainer,
    scrollContainerBy,
    scrollContainerToEdge,
} from './scroller.js';

const MODULE_NAME = 'st_vimium';
const OVERLAY_ID = 'st-vimium-overlay';
const GG_TIMEOUT_MS = 500;

const DEFAULT_SETTINGS = Object.freeze({
    enabled: true,
    triggerShortcut: 'f',
    globalShortcut: 'Alt+f',
    continuousShortcut: 'Shift+f',
    hintChars: DEFAULT_HINT_CHARS,
    theme: 'classic',
    badgeSize: 'md',
    includeInputs: true,
    escapeBlursInput: true,
    enableVimScroll: true,
    scrollStep: 120,
    showHud: true,
    customSelectors: '',
});

function getContextSafe() {
    return window.SillyTavern?.getContext?.() ?? {};
}

function getSettings() {
    const ctx = getContextSafe();
    if (!ctx.extensionSettings) {
        return { ...DEFAULT_SETTINGS };
    }
    if (!ctx.extensionSettings[MODULE_NAME]) {
        ctx.extensionSettings[MODULE_NAME] = { ...DEFAULT_SETTINGS };
    }
    const stored = ctx.extensionSettings[MODULE_NAME];
    for (const [key, value] of Object.entries(DEFAULT_SETTINGS)) {
        if (stored[key] === undefined) {
            stored[key] = value;
        }
    }
    return stored;
}

function saveSettings() {
    const ctx = getContextSafe();
    ctx.saveSettingsDebounced?.();
}

/**
 * Manages the active Hint Mode lifecycle, Vim scrolling, overlay rendering, and keyboard capture.
 */
class VimiumHintController {
    constructor() {
        this.active = false;
        this.continuous = false;
        this.typed = '';
        /** @type {Array<{ code: string, el: Element, rect: DOMRect, badgeEl: HTMLElement, matchedEl: HTMLElement, remainingEl: HTMLElement }>} */
        this.entries = [];
        /** @type {HTMLElement | null} */
        this.overlayEl = null;
        /** @type {HTMLElement | null} */
        this.hudEl = null;
        /** @type {number | null} */
        this.rehintTimer = null;
        this.isRecordingShortcut = false;
        this.suppressNextKeyUpCode = null;
        this.lastGPressTime = 0;
        /** @type {Element | null} */
        this.lastHoveredEl = null;

        this.onKeyDown = this.onKeyDown.bind(this);
        this.onKeyPressOrUp = this.onKeyPressOrUp.bind(this);
        this.onDismissInteraction = this.onDismissInteraction.bind(this);
        this.onPointerMove = this.onPointerMove.bind(this);
    }

    attach() {
        window.addEventListener('keydown', this.onKeyDown, true);
        window.addEventListener('keypress', this.onKeyPressOrUp, true);
        window.addEventListener('keyup', this.onKeyPressOrUp, true);
        window.addEventListener('mousedown', this.onDismissInteraction, true);
        window.addEventListener('wheel', this.onDismissInteraction, { capture: true, passive: true });
        window.addEventListener('resize', this.onDismissInteraction, true);
        window.addEventListener('pointermove', this.onPointerMove, { capture: true, passive: true });
    }

    onPointerMove(event) {
        if (event.target instanceof Element) {
            this.lastHoveredEl = event.target;
        }
    }

    ensureOverlay(settings) {
        if (!this.overlayEl || !this.overlayEl.isConnected) {
            const existing = document.getElementById(OVERLAY_ID);
            if (existing) {
                this.overlayEl = existing;
            } else {
                this.overlayEl = document.createElement('div');
                this.overlayEl.id = OVERLAY_ID;
                document.body.appendChild(this.overlayEl);
            }
        }
        const theme = ['classic', 'dark', 'st-theme'].includes(settings.theme) ? settings.theme : 'classic';
        const size = ['sm', 'md', 'lg'].includes(settings.badgeSize) ? settings.badgeSize : 'md';
        this.overlayEl.className = `st-vimium-theme-${theme} st-vimium-size-${size}`;
        return this.overlayEl;
    }

    /**
     * Activate Hint Mode, scan SillyTavern's visible on-screen buttons, and render badges.
     *
     * @param {{ continuous?: boolean }} [opts]
     */
    activate({ continuous = false } = {}) {
        const settings = getSettings();
        if (!settings.enabled) return;

        this.clearRehintTimer();
        this.clearOverlay();
        this.lastGPressTime = 0;

        const targets = collectClickableTargets({
            doc: document,
            win: window,
            includeInputs: settings.includeInputs,
            customSelectors: settings.customSelectors,
        });

        if (targets.length === 0) {
            this.active = false;
            this.continuous = false;
            return;
        }

        const hintChars = sanitizeHintChars(settings.hintChars);
        const codes = generateHintStrings(targets.length, hintChars);

        const overlay = this.ensureOverlay(settings);
        const fragment = document.createDocumentFragment();
        const viewport = { width: window.innerWidth || 1280, height: window.innerHeight || 720 };
        const placed = [];

        this.entries = [];
        this.typed = '';
        this.active = true;
        this.continuous = continuous;

        for (let i = 0; i < targets.length; i++) {
            const target = targets[i];
            const code = codes[i];
            if (!code) continue;

            const pos = computeBadgePosition(target.rect, viewport, placed);
            placed.push(pos);

            const badgeEl = document.createElement('div');
            badgeEl.className = 'st-vimium-hint';
            badgeEl.style.left = `${pos.x}px`;
            badgeEl.style.top = `${pos.y}px`;

            const matchedEl = document.createElement('span');
            matchedEl.className = 'st-vimium-matched';

            const remainingEl = document.createElement('span');
            remainingEl.className = 'st-vimium-remaining';
            remainingEl.textContent = code;

            badgeEl.appendChild(matchedEl);
            badgeEl.appendChild(remainingEl);
            fragment.appendChild(badgeEl);

            this.entries.push({
                code,
                el: target.el,
                rect: target.rect,
                badgeEl,
                matchedEl,
                remainingEl,
            });
        }

        if (settings.showHud) {
            this.hudEl = document.createElement('div');
            this.hudEl.className = 'st-vimium-hud';
            fragment.appendChild(this.hudEl);
            this.updateHud(this.entries.length);
        }

        overlay.appendChild(fragment);
    }

    deactivate() {
        this.clearRehintTimer();
        this.active = false;
        this.continuous = false;
        this.typed = '';
        this.entries = [];
        this.hudEl = null;
        this.clearOverlay();
    }

    clearRehintTimer() {
        if (this.rehintTimer !== null) {
            clearTimeout(this.rehintTimer);
            this.rehintTimer = null;
        }
    }

    clearOverlay() {
        if (this.overlayEl) {
            this.overlayEl.textContent = '';
        }
    }

    updateHud(matchCount) {
        if (!this.hudEl) return;
        const modeLabel = this.continuous ? 'MULTI' : 'HINTS';
        const typedDisplay = this.typed ? this.typed.toUpperCase() : '…';
        this.hudEl.innerHTML = '';

        const prefixSpan = document.createElement('span');
        prefixSpan.textContent = `VIMIUM ${modeLabel} [`;

        const keySpan = document.createElement('span');
        keySpan.className = 'st-vimium-hud-key';
        keySpan.textContent = typedDisplay;

        const suffixSpan = document.createElement('span');
        suffixSpan.textContent = `] · ${matchCount} · Esc to cancel`;

        this.hudEl.append(prefixSpan, keySpan, suffixSpan);
    }

    renderFilterState() {
        const { matches, exactMatch } = filterHints(this.entries, this.typed);

        if (exactMatch) {
            const targetEl = exactMatch.el;
            const targetRect = exactMatch.rect;
            const stayContinuous = this.continuous;

            this.deactivate();
            this.flashRect(targetRect);
            const action = activateTarget(targetEl);

            // In continuous mode, re-scan after a brief settle tick so newly opened
            // menus/drawers get hints immediately — unless we just focused a text input.
            if (stayContinuous && action !== 'focus') {
                this.rehintTimer = window.setTimeout(() => {
                    this.rehintTimer = null;
                    this.activate({ continuous: true });
                }, 180);
            }
            return;
        }

        if (matches.length === 0) {
            this.deactivate();
            return;
        }

        const matchedSet = new Set(matches);
        const prefixLen = this.typed.length;

        for (const entry of this.entries) {
            if (matchedSet.has(entry)) {
                entry.badgeEl.classList.remove('st-vimium-hidden');
                entry.matchedEl.textContent = entry.code.slice(0, prefixLen);
                entry.remainingEl.textContent = entry.code.slice(prefixLen);
            } else {
                entry.badgeEl.classList.add('st-vimium-hidden');
            }
        }

        this.updateHud(matches.length);
    }

    flashRect(rect) {
        if (!rect) return;
        const settings = getSettings();
        const overlay = this.ensureOverlay(settings);
        const flash = document.createElement('div');
        flash.className = 'st-vimium-flash';
        flash.style.left = `${rect.left}px`;
        flash.style.top = `${rect.top}px`;
        flash.style.width = `${rect.width}px`;
        flash.style.height = `${rect.height}px`;
        overlay.appendChild(flash);
        window.setTimeout(() => flash.remove(), 260);
    }

    handleVimScroll(event, settings) {
        if (!settings.enableVimScroll) return false;
        if (event.ctrlKey || event.altKey || event.metaKey) return false;

        const key = event.key;
        const step = Math.max(20, Math.min(800, Number(settings.scrollStep) || 120));
        const smooth = !event.repeat;

        // `j` -> scroll down, `k` -> scroll up
        if (!event.shiftKey && (key === 'j' || key === 'J')) {
            this.lastGPressTime = 0;
            const container = findScrollContainer({ doc: document, win: window, hoveredEl: this.lastHoveredEl });
            this.consume(event);
            scrollContainerBy(container, step, { smooth });
            return true;
        }
        if (!event.shiftKey && (key === 'k' || key === 'K')) {
            this.lastGPressTime = 0;
            const container = findScrollContainer({ doc: document, win: window, hoveredEl: this.lastHoveredEl });
            this.consume(event);
            scrollContainerBy(container, -step, { smooth });
            return true;
        }

        // `d` -> half-page down, `u` -> half-page up
        if (!event.shiftKey && (key === 'd' || key === 'D')) {
            this.lastGPressTime = 0;
            const container = findScrollContainer({ doc: document, win: window, hoveredEl: this.lastHoveredEl });
            const halfPage = Math.max(step, Math.round((container?.clientHeight || window.innerHeight || 720) * 0.5));
            this.consume(event);
            scrollContainerBy(container, halfPage, { smooth });
            return true;
        }
        if (!event.shiftKey && (key === 'u' || key === 'U')) {
            this.lastGPressTime = 0;
            const container = findScrollContainer({ doc: document, win: window, hoveredEl: this.lastHoveredEl });
            const halfPage = Math.max(step, Math.round((container?.clientHeight || window.innerHeight || 720) * 0.5));
            this.consume(event);
            scrollContainerBy(container, -halfPage, { smooth });
            return true;
        }

        // `G` (Shift+g) -> scroll to bottom
        if (event.shiftKey && (key === 'G' || key === 'g')) {
            this.lastGPressTime = 0;
            const container = findScrollContainer({ doc: document, win: window, hoveredEl: this.lastHoveredEl });
            this.consume(event);
            scrollContainerToEdge(container, 'bottom', { smooth: true });
            return true;
        }

        // `gg` -> scroll to top
        if (!event.shiftKey && (key === 'g' || key === 'G') && !event.repeat) {
            const now = Date.now();
            if (now - this.lastGPressTime <= GG_TIMEOUT_MS) {
                this.lastGPressTime = 0;
                const container = findScrollContainer({ doc: document, win: window, hoveredEl: this.lastHoveredEl });
                this.consume(event);
                scrollContainerToEdge(container, 'top', { smooth: true });
                return true;
            }
            this.lastGPressTime = now;
            return false;
        }

        this.lastGPressTime = 0;
        return false;
    }

    onDismissInteraction(event) {
        if (!this.active) return;
        if (event && event.isTrusted === false) return;
        this.deactivate();
    }

    onKeyPressOrUp(event) {
        if (event.type === 'keyup' && this.suppressNextKeyUpCode && event.code === this.suppressNextKeyUpCode) {
            this.suppressNextKeyUpCode = null;
            event.preventDefault();
            event.stopPropagation();
            event.stopImmediatePropagation();
            return;
        }
        if (!this.active) return;
        if (isModifierKey(event.key)) return;
        event.preventDefault();
        event.stopPropagation();
        event.stopImmediatePropagation();
    }

    onKeyDown(event) {
        if (this.isRecordingShortcut) return;

        const settings = getSettings();
        if (!settings.enabled) {
            if (this.active) this.deactivate();
            return;
        }

        // 1. Handle keystrokes while Hint Mode is active
        if (this.active) {
            if (isModifierKey(event.key)) return;

            if (event.ctrlKey || event.metaKey) {
                this.deactivate();
                return;
            }

            const globalParsed = parseShortcut(settings.globalShortcut);
            if (event.altKey && matchesShortcut(event, globalParsed)) {
                this.consume(event);
                this.deactivate();
                return;
            }

            if (event.altKey) {
                this.deactivate();
                return;
            }

            this.consume(event);

            if (event.key === 'Escape') {
                this.deactivate();
                return;
            }

            if (event.key === 'Backspace' || event.key === 'Delete') {
                if (this.typed.length > 0) {
                    this.typed = this.typed.slice(0, -1);
                    this.renderFilterState();
                } else {
                    this.deactivate();
                }
                return;
            }

            const validPool = sanitizeHintChars(settings.hintChars);
            let ch = typeof event.key === 'string' && event.key.length === 1 ? event.key.toLowerCase() : '';

            if ((!ch || !validPool.includes(ch)) && typeof event.code === 'string' && /^Key([A-Z])$/.test(event.code)) {
                if (!ch || ch.charCodeAt(0) > 127) {
                    const fallback = event.code.slice(3).toLowerCase();
                    if (validPool.includes(fallback)) {
                        ch = fallback;
                    }
                }
            }

            if (!ch || !validPool.includes(ch)) {
                this.deactivate();
                return;
            }

            this.suppressNextKeyUpCode = event.code || null;
            this.typed += ch;
            this.renderFilterState();
            return;
        }

        // 2. Hint Mode is NOT active — check triggers & Vim scroll keys
        if (event.isComposing) return;

        const activeEl = document.activeElement;
        const inEditable = isTextEditable(activeEl);

        // Optional Vimium-like Escape to blur focused text input (e.g. #send_textarea)
        if (
            !event.repeat &&
            settings.escapeBlursInput &&
            inEditable &&
            event.key === 'Escape' &&
            !event.ctrlKey &&
            !event.altKey &&
            !event.metaKey &&
            !event.shiftKey
        ) {
            if (!activeEl?.closest?.('dialog[open], .popup, #dialogue_popup')) {
                activeEl?.blur?.();
            }
            return;
        }

        // Global shortcut works ANYWHERE, including inside #send_textarea
        if (!event.repeat) {
            const globalParsed = parseShortcut(settings.globalShortcut);
            if (globalParsed.valid && matchesShortcut(event, globalParsed)) {
                this.consume(event);
                this.activate({ continuous: false });
                return;
            }
        }

        // Non-global shortcuts & Vim scrolling require focus to be outside text inputs
        if (inEditable) return;

        if (!event.repeat) {
            const continuousParsed = parseShortcut(settings.continuousShortcut);
            if (continuousParsed.valid && matchesShortcut(event, continuousParsed)) {
                this.consume(event);
                this.activate({ continuous: true });
                return;
            }

            const triggerParsed = parseShortcut(settings.triggerShortcut);
            if (triggerParsed.valid && matchesShortcut(event, triggerParsed)) {
                this.consume(event);
                this.activate({ continuous: false });
                return;
            }
        }

        // Vimium scrolling (`j`, `k`, `d`, `u`, `gg`, `G`) — allows repeat when holding j/k
        this.handleVimScroll(event, settings);
    }

    consume(event) {
        event.preventDefault();
        event.stopPropagation();
        event.stopImmediatePropagation();
    }
}

/**
 * Wire a key-recorder button + text input pair in the settings drawer.
 *
 * @param {VimiumHintController} controller
 * @param {string} inputId
 * @param {string} recordBtnId
 * @param {string} settingKey
 */
function bindShortcutRecorder(controller, inputId, recordBtnId, settingKey) {
    const $input = $(`#${inputId}`);
    const $btn = $(`#${recordBtnId}`);

    $input.val(getSettings()[settingKey] || '');

    $input.on('change blur', function () {
        if ($input.hasClass('stv-recording')) return;
        const val = String($(this).val() ?? '').trim();
        getSettings()[settingKey] = val;
        saveSettings();
    });

    $btn.on('click', () => {
        if ($input.hasClass('stv-recording')) return;

        controller.deactivate();
        controller.isRecordingShortcut = true;
        $input.addClass('stv-recording').val('Press key…').trigger('focus');

        const stopRecording = (newVal) => {
            window.removeEventListener('keydown', onRecordKey, true);
            window.removeEventListener('mousedown', onCancelClick, true);
            controller.isRecordingShortcut = false;
            $input.removeClass('stv-recording');
            if (newVal !== null) {
                $input.val(newVal);
                getSettings()[settingKey] = newVal;
                saveSettings();
            } else {
                $input.val(getSettings()[settingKey] || '');
            }
        };

        const onRecordKey = (e) => {
            if (isModifierKey(e.key)) return;
            e.preventDefault();
            e.stopPropagation();
            e.stopImmediatePropagation();

            if (e.key === 'Escape') {
                stopRecording(null);
                return;
            }
            if (e.key === 'Backspace' || e.key === 'Delete') {
                stopRecording('');
                return;
            }
            const formatted = formatShortcutFromEvent(e);
            if (formatted) {
                stopRecording(formatted);
            }
        };

        const onCancelClick = (e) => {
            if (e.target === $input[0] || e.target === $btn[0] || $btn[0]?.contains(e.target)) return;
            stopRecording(null);
        };

        window.addEventListener('keydown', onRecordKey, true);
        window.addEventListener('mousedown', onCancelClick, true);
    });
}

function injectSettingsUI(controller) {
    if ($('#stv_settings_container').length) return;

    const $container = $('#extensions_settings2').length
        ? $('#extensions_settings2')
        : $('#extensions_settings');

    if (!$container.length) return;

    const settings = getSettings();

    const html = `
        <div id="stv_settings_container" class="stv-settings">
            <div class="inline-drawer">
                <div class="inline-drawer-toggle inline-drawer-header">
                    <b>ST Vimium (Keyboard Hints)</b>
                    <div class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div>
                </div>
                <div class="inline-drawer-content">
                    <label class="checkbox_label" for="stv_enabled">
                        <input id="stv_enabled" type="checkbox" />
                        <span>Enable keyboard link hints &amp; Vim navigation</span>
                    </label>

                    <div class="stv-row">
                        <label for="stv_trigger_shortcut" title="Active when not typing in a text field">
                            Hint shortcut <small>(outside text boxes)</small>
                        </label>
                        <div class="stv-shortcut-group">
                            <input id="stv_trigger_shortcut" type="text" class="text_pole stv-shortcut-input" placeholder="f" />
                            <button id="stv_trigger_record" type="button" class="menu_button stv-icon-btn" title="Click and press a shortcut (Backspace to clear)">
                                <i class="fa-solid fa-keyboard"></i>
                            </button>
                        </div>
                    </div>

                    <div class="stv-row">
                        <label for="stv_global_shortcut" title="Works even while your cursor is inside the chat input box">
                            Global shortcut <small>(works in text boxes)</small>
                        </label>
                        <div class="stv-shortcut-group">
                            <input id="stv_global_shortcut" type="text" class="text_pole stv-shortcut-input" placeholder="Alt+f" />
                            <button id="stv_global_record" type="button" class="menu_button stv-icon-btn" title="Click and press a shortcut (Backspace to clear)">
                                <i class="fa-solid fa-keyboard"></i>
                            </button>
                        </div>
                    </div>

                    <div class="stv-row">
                        <label for="stv_continuous_shortcut" title="Keeps showing hints after each click until you press Escape">
                            Continuous mode <small>(multi-click)</small>
                        </label>
                        <div class="stv-shortcut-group">
                            <input id="stv_continuous_shortcut" type="text" class="text_pole stv-shortcut-input" placeholder="Shift+f" />
                            <button id="stv_continuous_record" type="button" class="menu_button stv-icon-btn" title="Click and press a shortcut (Backspace to clear)">
                                <i class="fa-solid fa-keyboard"></i>
                            </button>
                        </div>
                    </div>

                    <div class="stv-row">
                        <label for="stv_theme">Badge style</label>
                        <select id="stv_theme" class="text_pole stv-select">
                            <option value="classic">Classic Vimium (Yellow)</option>
                            <option value="dark">High-Contrast Dark</option>
                            <option value="st-theme">SillyTavern Theme</option>
                        </select>
                    </div>

                    <div class="stv-row">
                        <label for="stv_badge_size">Badge size</label>
                        <select id="stv_badge_size" class="text_pole stv-select">
                            <option value="sm">Small</option>
                            <option value="md">Medium</option>
                            <option value="lg">Large</option>
                        </select>
                    </div>

                    <div class="stv-field">
                        <label for="stv_hint_chars">Hint characters <small>(home-row default: <code>${DEFAULT_HINT_CHARS}</code>)</small></label>
                        <input id="stv_hint_chars" type="text" class="text_pole stv-hint-chars" placeholder="${DEFAULT_HINT_CHARS}" />
                    </div>

                    <label class="checkbox_label" for="stv_vim_scroll">
                        <input id="stv_vim_scroll" type="checkbox" />
                        <span>Enable Vim scrolling (<code>j</code>/<code>k</code>, <code>d</code>/<code>u</code>, <code>gg</code>/<code>G</code>)</span>
                    </label>

                    <div class="stv-row">
                        <label for="stv_scroll_step">Scroll step (px for <code>j</code>/<code>k</code>)</label>
                        <input id="stv_scroll_step" type="number" min="20" max="800" step="20" class="text_pole stv-shortcut-input" />
                    </div>

                    <label class="checkbox_label" for="stv_include_inputs">
                        <input id="stv_include_inputs" type="checkbox" />
                        <span>Include text inputs &amp; sliders (focuses them when selected)</span>
                    </label>

                    <label class="checkbox_label" for="stv_escape_blurs">
                        <input id="stv_escape_blurs" type="checkbox" />
                        <span>Pressing Escape in the chat box unfocuses it (Vimium-style)</span>
                    </label>

                    <label class="checkbox_label" for="stv_show_hud">
                        <input id="stv_show_hud" type="checkbox" />
                        <span>Show status indicator while hints are active</span>
                    </label>

                    <div class="stv-field">
                        <label for="stv_custom_selectors">Extra CSS selectors <small>(optional, comma or newline separated)</small></label>
                        <textarea id="stv_custom_selectors" class="text_pole textarea_compact" rows="2" placeholder=".my-extension-btn, #custom_control"></textarea>
                    </div>

                    <small class="stv-help">
                        Press <b>f</b> (or <b>Alt+f</b> inside the chat box) to overlay keystroke badges on every visible button. Scroll with <b>j</b>/<b>k</b> (line), <b>d</b>/<b>u</b> (half-page), <b>gg</b>/<b>G</b> (top/bottom).
                    </small>
                </div>
            </div>
        </div>
    `;

    $container.append(html);

    $('#stv_enabled').prop('checked', Boolean(settings.enabled));
    $('#stv_theme').val(settings.theme || 'classic');
    $('#stv_badge_size').val(settings.badgeSize || 'md');
    $('#stv_hint_chars').val(settings.hintChars || DEFAULT_HINT_CHARS);
    $('#stv_vim_scroll').prop('checked', Boolean(settings.enableVimScroll));
    $('#stv_scroll_step').val(settings.scrollStep || 120);
    $('#stv_include_inputs').prop('checked', Boolean(settings.includeInputs));
    $('#stv_escape_blurs').prop('checked', Boolean(settings.escapeBlursInput));
    $('#stv_show_hud').prop('checked', Boolean(settings.showHud));
    $('#stv_custom_selectors').val(settings.customSelectors || '');

    bindShortcutRecorder(controller, 'stv_trigger_shortcut', 'stv_trigger_record', 'triggerShortcut');
    bindShortcutRecorder(controller, 'stv_global_shortcut', 'stv_global_record', 'globalShortcut');
    bindShortcutRecorder(controller, 'stv_continuous_shortcut', 'stv_continuous_record', 'continuousShortcut');

    $('#stv_enabled').on('change', function () {
        getSettings().enabled = Boolean($(this).prop('checked'));
        if (!getSettings().enabled) controller.deactivate();
        saveSettings();
    });

    $('#stv_theme').on('change', function () {
        getSettings().theme = String($(this).val());
        saveSettings();
    });

    $('#stv_badge_size').on('change', function () {
        getSettings().badgeSize = String($(this).val());
        saveSettings();
    });

    $('#stv_hint_chars').on('change blur', function () {
        const cleaned = sanitizeHintChars(String($(this).val() ?? ''));
        $(this).val(cleaned);
        getSettings().hintChars = cleaned;
        saveSettings();
    });

    $('#stv_vim_scroll').on('change', function () {
        getSettings().enableVimScroll = Boolean($(this).prop('checked'));
        saveSettings();
    });

    $('#stv_scroll_step').on('input change', function () {
        const parsed = parseInt(String($(this).val()), 10);
        if (!Number.isNaN(parsed) && parsed >= 20 && parsed <= 800) {
            getSettings().scrollStep = parsed;
            saveSettings();
        }
    });

    $('#stv_include_inputs').on('change', function () {
        getSettings().includeInputs = Boolean($(this).prop('checked'));
        saveSettings();
    });

    $('#stv_escape_blurs').on('change', function () {
        getSettings().escapeBlursInput = Boolean($(this).prop('checked'));
        saveSettings();
    });

    $('#stv_show_hud').on('change', function () {
        getSettings().showHud = Boolean($(this).prop('checked'));
        saveSettings();
    });

    $('#stv_custom_selectors').on('input change', function () {
        getSettings().customSelectors = String($(this).val() ?? '');
        saveSettings();
    });
}

jQuery(() => {
    const controller = new VimiumHintController();
    controller.attach();

    injectSettingsUI(controller);

    const { eventSource, event_types } = getContextSafe();
    if (eventSource && event_types?.APP_READY) {
        eventSource.on(event_types.APP_READY, () => {
            injectSettingsUI(controller);
        });
    }
});
