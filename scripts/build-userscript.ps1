# Builds dist/github-push-force-history.user.js from src/content.js + src/styles.css
$root = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
$css = Get-Content (Join-Path $root "src\styles.css") -Raw -Encoding UTF8
$js = Get-Content (Join-Path $root "src\content.js") -Raw -Encoding UTF8
$dist = Join-Path $root "dist"
New-Item -ItemType Directory -Force -Path $dist | Out-Null

$header = @"
// ==UserScript==
// @name         GitHub Push Force History
// @namespace    https://github.com/github-push-force-history
// @version      1.0.0
// @description  Force-push history for GitHub PRs - compare links from the timeline (no API).
// @author       Gabriel Viterbo
// @match        https://github.com/*/*/pull/*
// @run-at       document-idle
// @grant        none
// ==/UserScript==

"@

$cssJs = $css `
  -replace '\\', '\\\\' `
  -replace '"', '\"' `
  -replace "`r`n", '\n' `
  -replace "`n", '\n' `
  -replace "`r", '\n'

$injectCss = @"
(function injectGithubPushForceHistoryStyles() {
  if (document.getElementById("gh-fph-userscript-styles")) return;
  const el = document.createElement("style");
  el.id = "gh-fph-userscript-styles";
  el.textContent = "$cssJs";
  (document.head || document.documentElement).appendChild(el);
})();

"@

$out = Join-Path $dist "github-push-force-history.user.js"
[System.IO.File]::WriteAllText($out, $header + $injectCss + $js)
Write-Host "Wrote $out"
