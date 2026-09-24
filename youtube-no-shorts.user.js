// ==UserScript==
// @name         YouTube - Disable Shorts
// @namespace    https://github.com/suspect453/Tampermonkey
// @version      2.0.0
// @description  Hides YouTube Shorts on home + search; nav/subscriptions/watch/channel hiding and /shorts/ redirect are optional toggles
// @author       suspect453
// @match        https://www.youtube.com/*
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_registerMenuCommand
// @grant        GM_unregisterMenuCommand
// @run-at       document-start
// @downloadURL  https://raw.githubusercontent.com/suspect453/Tampermonkey/main/youtube-no-shorts.user.js
// @updateURL    https://raw.githubusercontent.com/suspect453/Tampermonkey/main/youtube-no-shorts.user.js
// ==/UserScript==

(function () {
  'use strict';

  // Toggles live in the Tampermonkey menu (extension icon → this script).
  // Only home + search are on by default; everything else is opt-in.
  const OPTIONS = [
    { key: 'home', label: 'Hide on home (recommendations)', def: true },
    { key: 'search', label: 'Hide in search results', def: true },
    { key: 'subs', label: 'Hide in subscriptions feed', def: false },
    { key: 'watch', label: 'Hide in watch-page sidebar', def: false },
    { key: 'channel', label: 'Hide Shorts tab on channels', def: false },
    { key: 'nav', label: 'Hide Shorts in left nav', def: false },
    { key: 'redirect', label: 'Redirect /shorts/ to normal player', def: false },
  ];

  const get = (o) => GM_getValue(o.key, o.def);

  // Shorts shelves + individual Shorts tiles, across old and new YouTube markup
  const SHORTS = [
    'ytd-rich-section-renderer:has(ytd-rich-shelf-renderer[is-shorts])',
    'ytd-rich-shelf-renderer[is-shorts]',
    'ytd-reel-shelf-renderer',
    'grid-shelf-view-model:has(ytm-shorts-lockup-view-model)',
    'ytd-rich-item-renderer:has(a[href^="/shorts/"])',
    'ytd-video-renderer:has(a[href^="/shorts/"])',
    'ytd-grid-video-renderer:has(a[href^="/shorts/"])',
    'ytd-compact-video-renderer:has(a[href^="/shorts/"])',
  ];

  // Scope each page's rules to its container so toggles stay independent
  const SCOPED = {
    home: 'ytd-browse[page-subtype="home"]',
    search: 'ytd-search',
    subs: 'ytd-browse[page-subtype="subscriptions"]',
    watch: 'ytd-watch-flexy #secondary',
  };

  function buildCss() {
    const sels = [];
    for (const [key, scope] of Object.entries(SCOPED)) {
      if (get(OPTIONS.find((o) => o.key === key))) {
        sels.push(...SHORTS.map((s) => `${scope} ${s}`));
      }
    }
    if (GM_getValue('channel', false)) {
      sels.push('ytd-browse[page-subtype="channels"] yt-tab-shape[tab-title="Shorts"]');
    }
    if (GM_getValue('nav', false)) {
      sels.push(
        'ytd-guide-entry-renderer:has(a[title="Shorts"])',
        'ytd-mini-guide-entry-renderer[aria-label="Shorts"]'
      );
    }
    return sels.length ? `${sels.join(',\n')} { display: none !important; }` : '';
  }

  const style = document.createElement('style');
  style.id = 'no-shorts-style';
  function applyCss() {
    style.textContent = buildCss();
    if (!style.isConnected) (document.head || document.documentElement).appendChild(style);
  }
  applyCss();

  function redirectShorts() {
    if (!GM_getValue('redirect', false)) return;
    const m = location.pathname.match(/^\/shorts\/([^/?]+)/);
    if (m) location.replace(`https://www.youtube.com/watch?v=${m[1]}`);
  }
  redirectShorts();
  // YouTube is a SPA - catch in-app navigation to /shorts/
  document.addEventListener('yt-navigate-finish', redirectShorts);

  let menuIds = [];
  function buildMenu() {
    menuIds.forEach((id) => GM_unregisterMenuCommand(id));
    menuIds = OPTIONS.map((o) =>
      GM_registerMenuCommand(`${get(o) ? '✅' : '⬜'} ${o.label}`, () => {
        GM_setValue(o.key, !get(o));
        applyCss();
        redirectShorts();
        buildMenu();
      })
    );
  }
  buildMenu();
})();
