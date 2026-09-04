// ==UserScript==
// @name         YouTube - Disable Shorts
// @namespace    https://ualan.dev/tampermonkey
// @version      1.0.0
// @description  Hides YouTube Shorts shelves/nav and redirects /shorts/ URLs to the normal watch page
// @author       ualan
// @match        https://www.youtube.com/*
// @grant        none
// @run-at       document-start
// @downloadURL  https://raw.githubusercontent.com/suspect453/Tampermonkey/main/youtube-no-shorts.user.js
// @updateURL    https://raw.githubusercontent.com/suspect453/Tampermonkey/main/youtube-no-shorts.user.js
// ==/UserScript==

(function () {
  'use strict';

  // Redirect /shorts/<id> to /watch?v=<id> so it plays in the normal player
  function redirectShorts() {
    const m = location.pathname.match(/^\/shorts\/([^/?]+)/);
    if (m) {
      location.replace(`https://www.youtube.com/watch?v=${m[1]}`);
    }
  }
  redirectShorts();

  const SELECTORS = [
    'ytd-rich-shelf-renderer[is-shorts]',       // shorts shelf on home
    'ytd-reel-shelf-renderer',                  // shorts shelf variant
    'ytd-guide-entry-renderer:has(a[title="Shorts"])', // sidebar nav item
    'a[title="Shorts"]',
    'ytd-mini-guide-entry-renderer[aria-label="Shorts"]',
    'ytd-video-renderer:has(a[href^="/shorts/"])', // shorts in search results
    'ytd-rich-item-renderer:has(a[href^="/shorts/"])',
  ];

  function hideShorts() {
    for (const sel of SELECTORS) {
      document.querySelectorAll(sel).forEach((el) => {
        el.style.display = 'none';
      });
    }
  }

  // YouTube is a SPA - rerun on navigation and DOM mutations
  document.addEventListener('yt-navigate-finish', () => {
    redirectShorts();
    hideShorts();
  });

  const observer = new MutationObserver(() => hideShorts());
  observer.observe(document.documentElement, { childList: true, subtree: true });

  hideShorts();
})();
