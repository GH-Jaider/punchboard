# Punchboard

Punchboard is a local Control Center for the computer you stream from. It keeps your decks on that machine and lets any tablet or phone on the same wifi trigger actions through a browser — no account, no cloud relay, nothing to install on the tablet.

## Start

**macOS**: double-click `start.command`. The first time, macOS may ask you to right-click it and choose **Open**.
**Windows**: double-click `start.bat`.

Nothing needs installing first. The first run downloads its own copy of Node.js into `runtime/`, checks it against the official checksums, installs Punchboard's parts, and starts. That takes a minute and needs internet once; later runs start straight away and work offline. Nothing is installed system-wide and no administrator password is needed.

When it is running, the Control Center opens in your browser by itself (`http://localhost:8787/designer`); choose **Pair a tablet** there. Double-clicking the starter again while Punchboard is running just opens it again.

If another program already uses port 8787, Punchboard takes the next free port and remembers it in `config.json`, so the address stays the same from then on. Tablets paired before the move need to pair once more, because a browser keeps each address's data separately.

## Pairing and security

A tablet or phone has to be paired before it can do anything. Scan the QR code on **Pair a tablet** with its camera (or open the address shown and type the 6-digit code). Codes change every 10 minutes, and repeated wrong guesses lock pairing for a minute.

Each paired device gets its own secret, sent once at pairing. After that every request it makes is signed with HMAC-SHA256 over the method, path, time, a one-off nonce and the body, so a request captured on the wifi can be neither altered nor replayed. Remove a device on the pairing page and it is cut off at once.

Only this computer, reaching the companion as `localhost`, can edit decks, settings, sounds or pairing. A button press sends only the button's id; the companion runs the button as saved here. Requests must name this server in their Host header and come from its own origin, which stops other web pages from driving the companion through your browser.

Signing protects against someone listening on the network. It cannot protect against someone who can rewrite traffic on your network, because the deck page itself is served over plain HTTP; use a network you trust.

## Your data is safe

Decks, settings and sound choices are saved atomically: written to a temporary file, flushed, then swapped in, so a crash or power cut mid-save cannot leave a half-written file. The previous save is kept as `.bak`, and a daily copy of your decks goes to `profiles/backups` (the last 14 days). If a deck file is ever damaged, the companion restores the last good save and keeps the damaged copy beside it. Two Control Center windows cannot overwrite each other: the second one reloads the latest version instead.

## Building a deck

Click a dashed slot to add a button, then give it a label, a colour and an icon. Changes save automatically a moment after you stop typing — the save indicator in the top bar tells you where things stand.

**Moving buttons.** Drag a button onto any other slot. Dropping it on an occupied slot swaps the two, so nothing is ever overwritten. With a button selected you can also move it with **Alt + arrow keys**.

**Grid size.** Columns and rows live in the canvas header. Shrinking the grid never deletes anything: buttons that fall outside it are *parked*, and a notice offers to grow the grid back or move them into free slots.

**Macros.** A button holds a list of steps that run in order, each with its own delay in milliseconds. Use **Add another step** to chain them — switch a scene, wait 400 ms, then unmute a mic.

**Icons.** 48 built-in icons, grouped and searchable, plus every Google icon (Material Symbols) under **Google icons** in the picker, in outlined, rounded or sharp and filled or not. A Google icon is saved into the deck as its vector path, so tablets never need the internet to show it; the Control Center needs it only while browsing. You can also upload a PNG, JPG, WebP or SVG as a custom icon, up to 750 KB. SVGs containing scripts or external references are refused. Custom icons live inside the deck backup, so they travel with that file.

**Themes.** Three looks under **Appearance**, applied to the Control Center and every paired deck at once: *Studio* (dark and soft), *Hardware* (a light chassis with physical keys and LED state) and *Broadcast* (a switcher console with hard edges). Fonts ship in `public/fonts`, so decks look right without internet.

**Faders.** Set a button's **Type** to **Volume fader** and it becomes a slider on the deck: drag up or down anywhere on the tile. A fader controls an OBS input's volume (on OBS's own fader curve), the volume of Punchboard's sounds, or this computer's output volume (macOS only for now). Every deck shows the same level, read from the source when the deck opens.

**Interface colour.** One accent colour for the Control Center and every paired deck. Button colours stay independent — aqua, blue, indigo, violet, pink, rose, red, orange, amber, yellow, lime, green, mint, cyan, slate and white.

**Sounds.** The **Sounds** panel in the left rail manages all eight slots. Each row previews the slot, replaces it with your own WAV or MP3 (up to 8 MB), and — once replaced — offers to restore the tone it shipped with. You can also upload straight from a *Play a sound* step, into whichever slot that step uses. Uploads are accepted only from the computer running the companion, and files are checked for a real WAV or MP3 header rather than trusting the extension. The eight built-in tones are generated on first run, so sound buttons work before you add anything of your own.

## Actions

| Action | Runs on |
| --- | --- |
| Switch scene | OBS |
| Show / hide source | OBS |
| Mute / unmute input | OBS |
| Start / stop stream | OBS |
| Start / stop recording | OBS |
| Open link on computer | this computer's default browser |
| Launch an app | this computer (needs the full path, e.g. `/Applications/OBS.app`) |
| Play a sound | this computer's speakers |
| Open link on the tablet | the tablet's own browser |

Buttons whose action has an on/off state — mute, stream, recording, source visibility — light up fully while that state is active, reported back from OBS rather than guessed. Sound slots accept WAV and MP3 up to 8 MB. Sounds play through the Control Center tab on this computer, so keep one open; click anywhere on it once so the browser allows audio. Pressing a sound button again stops it, the button stays lit while its sound plays, and **Stop sound** appears in the Control Center's top bar. With several Control Center tabs open, only the newest one plays. The tablet never downloads the audio.

## On the tablet

The deck fills the whole screen and keeps the exact grid you designed, so a button is always in the same place on every device. Tap **Full screen** to hide the browser chrome; a **Show controls** grip at the top brings the bar back, and Escape works too.

If the companion stops responding, the deck says so in a banner and refuses presses rather than silently doing nothing.

The runtime deliberately sticks to widely supported CSS and JavaScript so genuinely old tablets still work. If you are adding to it, keep `deck.html`, `src/client/deck` and the `.deck-page` half of `style.css` free of `oklch()`, `color-mix()`, container queries and `<dialog>`; derive colours in code instead (see `applyAccent` and `applyTileColor` in `src/client/common/dom.ts`).

## OBS setup

Open the **OBS Studio** panel in the left rail only when you actually use OBS buttons. In OBS, open **Tools → WebSocket Server Settings**, enable the server, set a password, then enter the matching address and password here. OBS normally listens at `ws://127.0.0.1:4455`.

## Key combinations

The **Key combination** action presses keys on the streaming computer, as if typed, which is how you fire an OBS hotkey or any app's shortcut from the deck. In the step editor, click the field and press the keys you want; the combination is recorded from the physical keys, so it fires the same key on any keyboard layout.

The keys go to whatever is in front on that computer at the time, so global hotkeys (OBS registers its own that way) are the reliable use.

- **macOS**: the first press makes macOS ask whether the app running Punchboard (Terminal) may control the computer. Allow it once under **System Settings › Privacy & Security › Accessibility**, then press again.
- **Windows**: nothing to set up. The Windows key cannot be part of a combination, and keys do not reach apps running as administrator.

## Backing up

**Back up to a file** downloads the whole library as JSON. **Restore from a file** replaces everything on this computer and asks for confirmation first. Older backups that stored a single action per button are migrated to the step format automatically on load.

## Stop safely

**Stop companion** sits in the footer, asks for confirmation, and shuts down the local process. Paired tablets show as offline until you start it again.

## Working on Punchboard

Punchboard is written in strict TypeScript.

| Folder | What | How it runs |
| --- | --- | --- |
| `src/shared` | The deck model, every API request and response type, themes, icons, request signing | Imported by both sides |
| `src/server` | The companion | Node 22.18+ runs the `.ts` files directly; no build step |
| `src/client` | Control Center, deck and pairing page | Bundled by esbuild into `public/js` |

- `npm install`: install tools.
- `npm run check`: type-check everything and build the pages.
- `npm run watch`: rebuild the pages on every change.
- `npm start`: run the companion. `PUNCHBOARD_PORT=8799 npm start` runs it on another port.

The deck targets Safari 11 (iOS 11) and ES2015, because it is meant for whatever tablet is lying around. Keep newer APIs that esbuild cannot lower (`structuredClone`, `Array.prototype.at`, `Object.fromEntries`…) out of `src/client/deck` and the shared code, and keep newer CSS (`oklch()`, `color-mix()`, container queries) out of the deck half of `style.css`.
