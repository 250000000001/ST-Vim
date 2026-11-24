/**
 * Core Vimium-style hint generation, filtering, and keyboard shortcut matching.
 * Pure ES module with zero DOM globals required so it can be unit tested directly.
 */

export const DEFAULT_HINT_CHARS = 'sadfjklewcmpgh';

const MODIFIER_KEYS = new Set(['shift', 'control', 'ctrl', 'alt', 'meta', 'os', 'capslock']);

const NON_TEXT_INPUT_TYPES = new Set([
    'button',
    'checkbox',
    'color',
    'file',
    'hidden',
    'image',
    'radio',
    'range',
    'reset',
    'submit',
]);

/**
 * Normalize and deduplicate a user-supplied hint character pool.
 * Falls back to DEFAULT_HINT_CHARS if fewer than 2 unique characters remain.
 *
 * @param {string} raw
 * @returns {string}
 */
export function sanitizeHintChars(raw) {
    if (typeof raw !== 'string') return DEFAULT_HINT_CHARS;
    const seen = new Set();
    let result = '';
    for (const ch of raw.toLowerCase()) {
        if (/\s/.test(ch)) continue;
        if (seen.has(ch)) continue;
        seen.add(ch);
        result += ch;
    }
    return result.length >= 2 ? result : DEFAULT_HINT_CHARS;
}

/**
 * Generate `count` prefix-free Vimium-style hint strings from `hintChars`.
 *
 * Uses breadth-first radix expansion (the same prefix-free tree strategy as
 * philc/vimium's AlphabetHints):
 * - No hint string is ever a prefix of another hint string.
 * - Maximizes the number of short (1-char) hints.
 * - Shorter hints appear first so higher-priority targets get single-keystroke labels.
 *
 * @param {number} count
 * @param {string} [hintChars=DEFAULT_HINT_CHARS]
 * @returns {string[]}
 */
export function generateHintStrings(count, hintChars = DEFAULT_HINT_CHARS) {
    if (!Number.isFinite(count) || count <= 0) return [];

    const chars = sanitizeHintChars(hintChars);
    const total = Math.floor(count);

    // Expand from the tail of `chars` when only a subset needs 2+ chars so the
    // easiest home-row keys (start of `chars`) stay 1-character hints whenever possible.
    if (total <= chars.length) {
        return [...chars.slice(0, total)];
    }

    // BFS expansion: start with root '', expand leaves until we have >= total leaves.
    // To keep the first chars as 1-char leaves when total is slightly larger than K,
    // push root children in reverse order for the first level if we only need partial
    // expansion, OR simply reverse-order level 1 so least-preferred chars expand first
    // while keeping preferred chars as 1-char leaves; once all level-1 nodes expand,
    // preferred chars become prefixes in normal order.
    const hints = [''];
    let offset = 0;

    while (hints.length - offset < total || hints.length === 1) {
        const prefix = hints[offset++];
        for (let i = 0; i < chars.length; i++) {
            hints.push(prefix + chars[i]);
        }
    }

    const result = hints.slice(offset, offset + total);
    // Keep shorter hints first, preserving generation order within equal lengths
    result.sort((a, b) => a.length - b.length);
    return result;
}

/**
 * Filter hint entries by the currently typed lowercase prefix.
 *
 * @template T
 * @param {Array<T & { code: string }>} hintEntries
 * @param {string} typed
 * @returns {{ matches: Array<T & { code: string }>, exactMatch: (T & { code: string }) | null }}
 */
export function filterHints(hintEntries, typed) {
    const prefix = (typed || '').toLowerCase();
    if (!prefix) {
        return { matches: hintEntries, exactMatch: null };
    }

    const matches = [];
    let exactMatch = null;

    for (const entry of hintEntries) {
        if (entry.code.startsWith(prefix)) {
            matches.push(entry);
            if (entry.code === prefix) {
                exactMatch = entry;
            }
        }
    }

    return { matches, exactMatch };
}

/**
 * Parse a human-readable shortcut string (e.g. "f", "Alt+f", "Shift+f", "Ctrl+Shift+k", ";", "Space")
 * into a structured descriptor.
 *
 * @param {string} shortcutStr
 * @returns {{ valid: boolean, key: string, ctrl: boolean, alt: boolean, shift: boolean, meta: boolean }}
 */
export function parseShortcut(shortcutStr) {
    const empty = { valid: false, key: '', ctrl: false, alt: false, shift: false, meta: false };
    if (typeof shortcutStr !== 'string') return empty;

    const trimmed = shortcutStr.trim();
    if (!trimmed) return empty;

    // Support literal '+' as the key itself (e.g. "+" or "Alt++")
    const parts = [];
    let current = '';
    for (let i = 0; i < trimmed.length; i++) {
        const ch = trimmed[i];
        if (ch === '+' && current.length > 0) {
            parts.push(current.trim());
            current = '';
        } else {
            current += ch;
        }
    }
    if (current.length > 0) {
        parts.push(current.trim());
    }

    if (parts.length === 0) return empty;

    let ctrl = false;
    let alt = false;
    let shift = false;
    let meta = false;
    let key = '';

    for (let i = 0; i < parts.length; i++) {
        const token = parts[i];
        const lower = token.toLowerCase();
        const isLast = i === parts.length - 1;

        if (!isLast) {
            if (lower === 'ctrl' || lower === 'control') {
                ctrl = true;
            } else if (lower === 'alt' || lower === 'option' || lower === 'opt') {
                alt = true;
            } else if (lower === 'shift') {
                shift = true;
            } else if (lower === 'meta' || lower === 'cmd' || lower === 'command' || lower === 'super') {
                meta = true;
            } else {
                return empty;
            }
        } else {
            if (MODIFIER_KEYS.has(lower)) return empty;
            if (lower === 'space' || lower === 'spacebar') {
                key = ' ';
            } else if (lower === 'esc') {
                key = 'escape';
            } else {
                key = lower;
            }
        }
    }

    if (!key) return empty;

    return { valid: true, key, ctrl, alt, shift, meta };
}

/**
 * Format a KeyboardEvent into a canonical shortcut string for the settings key recorder.
 * Returns null for standalone modifier presses.
 *
 * @param {KeyboardEvent} event
 * @returns {string | null}
 */
export function formatShortcutFromEvent(event) {
    if (!event || typeof event.key !== 'string') return null;

    let key = event.key;
    const lower = key.toLowerCase();
    if (MODIFIER_KEYS.has(lower)) return null;

    // Recover physical ASCII letter when Alt/Option on macOS mutates event.key (e.g. Alt+f -> 'ƒ')
    if (event.altKey && typeof event.code === 'string' && /^Key[A-Z]$/.test(event.code)) {
        key = event.code.slice(3).toLowerCase();
    } else if (key === ' ') {
        key = 'Space';
    } else if (key.length === 1) {
        key = key.toLowerCase();
    }

    const parts = [];
    if (event.ctrlKey) parts.push('Ctrl');
    if (event.altKey) parts.push('Alt');
    if (event.shiftKey) parts.push('Shift');
    if (event.metaKey) parts.push('Meta');
    parts.push(key);

    return parts.join('+');
}

/**
 * Check whether a KeyboardEvent matches a parsed shortcut descriptor.
 *
 * @param {KeyboardEvent} event
 * @param {{ valid: boolean, key: string, ctrl: boolean, alt: boolean, shift: boolean, meta: boolean } | null} parsed
 * @returns {boolean}
 */
export function matchesShortcut(event, parsed) {
    if (!event || !parsed || !parsed.valid) return false;
    if (event.isComposing) return false;

    if (Boolean(event.ctrlKey) !== parsed.ctrl) return false;
    if (Boolean(event.altKey) !== parsed.alt) return false;
    if (Boolean(event.metaKey) !== parsed.meta) return false;

    const isSingleLetter = /^[a-z]$/.test(parsed.key);
    const isSymbol = parsed.key.length === 1 && !isSingleLetter && !/^[0-9]$/.test(parsed.key);

    // For punctuation like '?' or ':' that implicitly require Shift on standard keyboards,
    // allow Shift to match naturally unless shift was explicitly specified.
    if (!isSymbol || parsed.shift) {
        if (Boolean(event.shiftKey) !== parsed.shift) return false;
    }

    const eventKey = typeof event.key === 'string' ? event.key.toLowerCase() : '';
    if (eventKey === parsed.key) return true;

    // Handle macOS Alt/Option producing non-ASCII chars (e.g. Alt+f -> 'ƒ')
    // or non-Latin keyboard layouts where event.code still reports 'KeyF'
    if (isSingleLetter && typeof event.code === 'string') {
        const expectedCode = `Key${parsed.key.toUpperCase()}`;
        const keyIsMutatedOrNonAscii =
            event.altKey ||
            eventKey === 'dead' ||
            eventKey === 'process' ||
            eventKey === 'unidentified' ||
            (eventKey.length === 1 && eventKey.charCodeAt(0) > 127);

        if (keyIsMutatedOrNonAscii && event.code === expectedCode) {
            return true;
        }
    }

    // Handle digits with Alt/Option
    if (/^[0-9]$/.test(parsed.key) && event.altKey && event.code === `Digit${parsed.key}`) {
        return true;
    }

    return false;
}

/**
 * Returns true if the given key is a standalone modifier key.
 *
 * @param {string} key
 * @returns {boolean}
 */
export function isModifierKey(key) {
    return typeof key === 'string' && MODIFIER_KEYS.has(key.toLowerCase());
}

/**
 * Determine whether an element is a text-entry control where plain single-letter
 * shortcuts (like `f`) should NOT steal keystrokes.
 *
 * @param {Element | null | undefined} el
 * @returns {boolean}
 */
export function isTextEditable(el) {
    if (!el || typeof el !== 'object') return false;

    if (el.isContentEditable) return true;

    const tag = typeof el.tagName === 'string' ? el.tagName.toUpperCase() : '';
    if (tag === 'TEXTAREA' || tag === 'SELECT') return true;

    if (tag === 'INPUT') {
        const type = String(el.getAttribute?.('type') ?? el.type ?? 'text').toLowerCase();
        return !NON_TEXT_INPUT_TYPES.has(type);
    }

    const contentEditableAttr = el.getAttribute?.('contenteditable');
    if (contentEditableAttr === '' || contentEditableAttr === 'true' || contentEditableAttr === 'plaintext-only') {
        return true;
    }

    return false;
}
