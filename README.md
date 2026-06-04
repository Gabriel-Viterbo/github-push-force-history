# GitHub Push Force History

**Author:** Gabriel Viterbo · **Version:** 1.0.0

Browser extension (Manifest V3 / WebExtensions) for GitHub pull requests: reads force-push events from the **visible** PR timeline and shows a side panel with compare links (`old..new` with full SHAs).

Works in **Chrome**, **Firefox**, and **Edge** (same folder). Optional **userscript** for Tampermonkey / Violentmonkey / Greasemonkey.

No GitHub API, no token, no background network calls.

## Install — Chrome or Edge

1. Clone or download this folder.
2. Open `chrome://extensions` (Edge: `edge://extensions`).
3. Enable **Developer mode**.
4. **Load unpacked** / **Carregar sem compactação** → select the project root (`manifest.json` here).
5. Open a PR: `https://github.com/<org>/<repo>/pull/<number>`.
6. The **GitHub Push Force History** panel appears on the right. Use **Refresh** if the timeline loads later.

## Install — Firefox

1. Open `about:debugging#/runtime/this-firefox`.
2. Click **Load Temporary Add-on…** / **Carregar extensão temporária…**.
3. Pick `manifest.json` from this project folder.
4. Open a GitHub PR page (same as above).

> Temporary add-ons are removed when Firefox restarts.

Requires **Firefox 109+** (Manifest V3).

## Install — userscript (any supported browser)

1. Install [Tampermonkey](https://www.tampermonkey.net/), Violentmonkey, or Greasemonkey.
2. Build the script (from repo root):

   ```powershell
   .\scripts\build-userscript.ps1
   ```

3. Open `dist/github-push-force-history.user.js` and copy into a new userscript, or import the file in Tampermonkey.

After changing `src/content.js` or `src/styles.css`, run the build script again.

## Icon

1. Folder `icons/` next to `manifest.json`.
2. Three PNGs: `icon16.png` (16×16), `icon48.png` (48×48), `icon128.png` (128×128).
3. Reload the extension in the browser.

## How to use

- Each line is one force-push: `oldSha → newSha`.
- **Open diff** opens GitHub’s compare URL (`/compare/<full-old>..<full-new>`, two dots).
- **Open previous** / **Open next** navigate and open compares in a new tab.
- **Refresh** re-scans the DOM.

## Project layout

| Path                                     | Role                                                                           |
| ---------------------------------------- | ------------------------------------------------------------------------------ |
| `manifest.json`                          | MV3 manifest (Chrome, Firefox, Edge)                                           |
| `src/content.js`                         | DOM logic + panel                                                              |
| `src/styles.css`                         | Panel styles                                                                   |
| `scripts/build-userscript.ps1`           | Builds `dist/github-push-force-history.user.js`                                |
| `dist/github-push-force-history.user.js` | Generated userscript (`dist/` is gitignored; run the build script after clone) |

## Browser compatibility

| Platform          | How                                                                      |
| ----------------- | ------------------------------------------------------------------------ |
| Chrome / Chromium | Load unpacked MV3                                                        |
| Microsoft Edge    | Same as Chrome                                                           |
| Firefox 109+      | Temporary load, or permanent via AMO after publish                       |
| Safari            | Not supported by this repo (needs separate Safari Web Extension wrapper) |
| Userscript hosts  | `dist/github-push-force-history.user.js` after build                     |

Core code uses only standard DOM APIs (`document`, `MutationObserver`, `window.open`) — no `chrome.*` calls.

## Known limitations

- Only timeline events **currently in the DOM** are detected.
- Lazy-loaded timeline: scroll, then **Refresh**.
- GitHub DOM changes may break selectors until updated.
- Full 40-char SHAs and `..` compare range required for accurate diffs.
- Panel is fixed on the right; may overlap narrow layouts.

## License

MIT — see [LICENSE](LICENSE).
