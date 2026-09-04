// ==UserScript==
// @name         YouTube - Disable Playables
// @namespace    https://ualan.dev/tampermonkey
// @version      1.0.0
// @description  Hides YouTube Playables (instant games) shelves/nav and blocks /playables/ pages
// @author       ualan
// @match        https://www.youtube.com/*
// @grant        none
// @run-at       document-start
// ==/UserScript==

(function () {
  'use strict';

  // Bounce away from /playables pages entirely
  function redirectPlayables() {
    if (location.pathname.startsWith('/playables')) {
      location.replace('https://www.youtube.com/');
    }
  }
  redirectPlayables();

  const SELECTORS = [
    'ytd-rich-shelf-renderer[is-playables]',           // playables shelf on home
    'ytd-guide-entry-renderer:has(a[title="Playables"])', // sidebar nav item
    'a[title="Playables"]',
    'ytd-mini-guide-entry-renderer[aria-label="Playables"]',
    'ytd-rich-item-renderer:has(a[href^="/playables/"])',
    'ytd-video-renderer:has(a[href^="/playables/"])',
  ];

  function hidePlayables() {
    for (const sel of SELECTORS) {
      document.querySelectorAll(sel).forEach((el) => {
        el.style.display = 'none';
      });
    }
  }

  // YouTube is a SPA - rerun on navigation and DOM mutations
  document.addEventListener('yt-navigate-finish', () => {
    redirectPlayables();
    hidePlayables();
  });

  const observer = new MutationObserver(() => hidePlayables());
  observer.observe(document.documentElement, { childList: true, subtree: true });

  hidePlayables();
})();
