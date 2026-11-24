# ST Vimium (Keyboard Hints & Vim Navigation)

A simplified, SillyTavern-tailored version of [Vimium](https://github.com/philc/vimium) that lets you click any button, recent chat, saved chat, persona, drawer tab, swipe arrow, menu item, or input—and scroll chats/drawers/modals—using only your keyboard.

## How It Works

1. **Activate Hint Mode**
   - Press **`f`** (when not typing in a text box) to display short keystroke badges next to every visible on-screen clickable control in SillyTavern.
   - Press **`Alt+f`** from **anywhere** — even while your cursor is inside the chat input box (`#send_textarea`) — without having to click out first.
   - Press **`Shift+f`** for **Continuous (Multi-Click) Mode**: after clicking a button (e.g. opening **Options**, **Extensions**, or a **Drawer**), hints automatically refresh on the newly revealed buttons until you press **`Esc`**.
2. **Vim Scrolling** (outside text boxes)
   - **`j`** / **`k`** — scroll down / up (hold to scroll smoothly)
   - **`d`** / **`u`** — scroll half-page down / up
   - **`gg`** / **`G`** — jump to top / bottom
   - Automatically targets the active SillyTavern scroll container (active modal popup, open drawer panel, hovered pane, or `#chat` / Welcome Screen).
3. **SillyTavern-Aware Smarts**
   - **Detects chats & cards**: Works on Welcome Screen **Recent Chats** (`.recentChat`), **Manage Chat Files** (`.select_chat_block`), **Personas** (`.avatar-container`), **Characters/Groups**, **Backgrounds**, and all message/drawer/menu buttons.
   - **Fast on long chats**: Uses viewport-pruned traversal and binary search on `#chat` messages so even chats with hundreds or thousands of turns stay instant with zero freeze.
   - **Keeps `#options` & `#extensionsMenu` open**: Focuses popup trigger buttons before clicking so SillyTavern's click-outside guard keeps submenus open cleanly.
   - **Priority short hints**: Active popups/menus, the send bar, Quick Replies, and the latest visible message get single-keystroke hints first.
   - **Escape blurs chat input**: Pressing **`Esc`** while focused in `#send_textarea` unfocuses it (Vimium-style) so you can immediately press **`f`**, **`j`**, or **`k`**.

## Install

Copy the script folder into your SillyTavern third-party extensions directory:

```bash
# Standard single-user install:
cp -r ST-Vimium <SillyTavern>/public/scripts/extensions/third-party/

# Or per-user (multi-user / Docker data volume):
cp -r ST-Vimium <SillyTavern>/data/default-user/extensions/
```

Then restart SillyTavern (or hard-refresh with `Ctrl+Shift+R`) and verify **ST Vimium (Keyboard Hints)** is enabled under **Extensions → Manage extensions**.

## Settings

Open **Extensions → ST Vimium (Keyboard Hints)** to customize:

- **Enable keyboard link hints & Vim navigation** (default: On)
- **Hint shortcut (outside text boxes)** (default: `f`, includes click-to-record button)
- **Global shortcut (works in text boxes)** (default: `Alt+f`, clear to disable)
- **Continuous mode (multi-click)** (default: `Shift+f`, clear to disable)
- **Badge style**: Classic Vimium (Yellow), High-Contrast Dark, or SillyTavern Theme
- **Badge size**: Small, Medium, or Large
- **Hint characters** (default: `sadfjklewcmpgh`)
- **Enable Vim scrolling** (`j`/`k`, `d`/`u`, `gg`/`G`, default: On) & **Scroll step (px)** (default: `120`)
- **Include text inputs & sliders** (default: On)
- **Pressing Escape in the chat box unfocuses it** (default: On)
- **Show status indicator while hints are active** (default: On)
- **Extra CSS selectors** — add custom selectors for any third-party extension controls

## Running Tests

```bash
node --test test/hints.test.mjs
```
