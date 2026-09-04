// ==UserScript==
// @name         X - Collect Bookmarks & Likes
// @namespace    https://ualan.dev/tampermonkey
// @version      1.0.0
// @description  Passively captures X (Twitter) bookmarks/likes as you scroll x.com/i/bookmarks or your Likes tab. Stored locally via GM storage. Export/import JSON, export CSV.
// @author       ualan
// @match        https://x.com/*
// @match        https://twitter.com/*
// @grant        unsafeWindow
// @grant        GM_setValue
// @grant        GM_getValue
// @grant        GM_addStyle
// @grant        GM_registerMenuCommand
// @run-at       document-start
// ==/UserScript==

// Reference: ~/dev/x-bookmarks-ext (MV3 extension doing the same thing via a
// MAIN-world content script + isolated-world storage). Ported to a single
// userscript file: unsafeWindow stands in for the MAIN-world hook, GM_*
// storage stands in for chrome.storage.local.

(function () {
  'use strict';

  const STORE_KEY = 'xCollectorTweets';
  const CAPTURE_RE = /\/i\/api\/graphql\/[^/]+\/(Bookmarks|Likes)/;

  // ---- capture: hook the page's real fetch/XHR via unsafeWindow ----

  function hookNetwork(onBody) {
    const origFetch = unsafeWindow.fetch;
    unsafeWindow.fetch = async function (...args) {
      const resp = await origFetch.apply(this, args);
      try {
        const url = typeof args[0] === 'string' ? args[0] : (args[0] && args[0].url) || '';
        const m = CAPTURE_RE.exec(url);
        if (m) {
          resp.clone().text().then((body) => onBody(m[1], body)).catch(() => {});
        }
      } catch { /* never break the page's own request */ }
      return resp;
    };

    const origOpen = unsafeWindow.XMLHttpRequest.prototype.open;
    unsafeWindow.XMLHttpRequest.prototype.open = function (method, url, ...rest) {
      const m = typeof url === 'string' && CAPTURE_RE.exec(url);
      if (m) {
        this.addEventListener('load', () => {
          if (typeof this.responseText === 'string') onBody(m[1], this.responseText);
        });
      }
      return origOpen.call(this, method, url, ...rest);
    };
  }

  // ---- parse: same defensive traversal as the extension's content.js ----

  function unwrapTweet(result) {
    if (!result) return null;
    if (result.__typename === 'TweetWithVisibilityResults') return result.tweet;
    return result;
  }

  function extractUser(tweet) {
    const user = tweet?.core?.user_results?.result;
    const legacy = user?.legacy ?? {};
    const core = user?.core ?? {};
    return {
      screenName: legacy.screen_name ?? core.screen_name ?? null,
      name: legacy.name ?? core.name ?? null,
    };
  }

  function extractMedia(tweet) {
    const media = tweet?.legacy?.extended_entities?.media ?? tweet?.legacy?.entities?.media ?? [];
    return media
      .map((m) => {
        if (m.type === 'video' || m.type === 'animated_gif') {
          const variants = (m.video_info?.variants ?? [])
            .filter((v) => v.content_type === 'video/mp4')
            .sort((a, b) => (b.bitrate ?? 0) - (a.bitrate ?? 0));
          return variants[0]?.url ?? m.media_url_https ?? null;
        }
        return m.media_url_https ?? null;
      })
      .filter(Boolean);
  }

  function currentAccount() {
    const link = document.querySelector('a[data-testid="AppTabBar_Profile_Link"]');
    const href = link?.getAttribute('href') ?? '';
    const m = /^\/([A-Za-z0-9_]{1,20})$/.exec(href);
    return m ? m[1] : null;
  }

  function collectTimelineItems(node, out) {
    if (!node || typeof node !== 'object') return;
    if (Array.isArray(node)) {
      for (const child of node) collectTimelineItems(child, out);
      return;
    }
    if (node.itemType === 'TimelineTweet' && node.tweet_results) {
      out.push(node);
      return;
    }
    for (const child of Object.values(node)) collectTimelineItems(child, out);
  }

  function extractTweetsFromResponse(json, kind) {
    const items = [];
    collectTimelineItems(json?.data, items);
    const account = currentAccount();
    const tweets = [];
    for (const item of items) {
      const tweet = unwrapTweet(item.tweet_results?.result);
      const legacy = tweet?.legacy;
      const id = tweet?.rest_id ?? legacy?.id_str;
      if (!id) continue;
      const { screenName, name } = extractUser(tweet);
      tweets.push({
        id,
        kind,
        account,
        url: screenName ? `https://x.com/${screenName}/status/${id}` : null,
        screenName,
        name,
        createdAt: legacy?.created_at ?? null,
        text: tweet?.note_tweet?.note_tweet_results?.result?.text ?? legacy?.full_text ?? '',
        media: extractMedia(tweet),
        capturedAt: Date.now(),
      });
    }
    return tweets;
  }

  function recordKey(t) {
    return `${t.kind}:${t.id}`;
  }

  // ---- storage ----

  let storeChain = Promise.resolve();
  function storeTweets(tweets) {
    storeChain = storeChain.then(async () => {
      const store = (await GM_getValue(STORE_KEY, {})) || {};
      let added = 0;
      for (const t of tweets) {
        const key = recordKey(t);
        const prev = store[key];
        if (prev) {
          t.capturedAt = prev.capturedAt;
          t.account = t.account ?? prev.account;
        } else {
          added++;
        }
        store[key] = t;
      }
      await GM_setValue(STORE_KEY, store);
      if (added > 0) {
        console.info(`[x-collect] captured ${added} new item(s), ${Object.keys(store).length} total`);
        refreshPanel();
      }
    }).catch((e) => console.warn('[x-collect] store failed', e));
  }

  hookNetwork((op, body) => {
    let json;
    try { json = JSON.parse(body); } catch { return; }
    const kind = op === 'Likes' ? 'like' : 'bookmark';
    const tweets = extractTweetsFromResponse(json, kind);
    if (tweets.length > 0) storeTweets(tweets);
  });

  // ---- export / import ----

  function downloadBlob(filename, mime, text) {
    const blob = new Blob([text], { type: mime });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  }

  function csvEscape(v) {
    const s = String(v ?? '');
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  }

  async function exportJSON() {
    const store = (await GM_getValue(STORE_KEY, {})) || {};
    downloadBlob(`x-bookmarks-likes-${Date.now()}.json`, 'application/json', JSON.stringify(store, null, 2));
  }

  async function exportCSV() {
    const store = (await GM_getValue(STORE_KEY, {})) || {};
    const rows = Object.values(store);
    const cols = ['kind', 'account', 'screenName', 'name', 'text', 'url', 'createdAt', 'capturedAt'];
    const lines = [cols.join(',')];
    for (const r of rows) lines.push(cols.map((c) => csvEscape(r[c])).join(','));
    downloadBlob(`x-bookmarks-likes-${Date.now()}.csv`, 'text/csv', lines.join('\n'));
  }

  function importJSON() {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = 'application/json';
    input.addEventListener('change', async () => {
      const file = input.files?.[0];
      if (!file) return;
      try {
        const incoming = JSON.parse(await file.text());
        const store = (await GM_getValue(STORE_KEY, {})) || {};
        for (const [k, v] of Object.entries(incoming)) store[k] = store[k] ?? v;
        await GM_setValue(STORE_KEY, store);
        refreshPanel();
        alert(`Imported. Total items: ${Object.keys(store).length}`);
      } catch (e) {
        alert(`Import failed: ${e}`);
      }
    });
    input.click();
  }

  async function clearAll() {
    if (!confirm('Clear all captured bookmarks/likes?')) return;
    await GM_setValue(STORE_KEY, {});
    refreshPanel();
  }

  // ---- minimal floating panel ----

  GM_addStyle(`
    #xc-panel { position: fixed; bottom: 16px; right: 16px; z-index: 999999;
      font: 12px/1.4 -apple-system, sans-serif; background: #15202b; color: #fff;
      border: 1px solid #38444d; border-radius: 8px; padding: 8px 10px; box-shadow: 0 2px 8px rgba(0,0,0,.4); }
    #xc-panel button { margin: 2px; padding: 4px 8px; background: #1d9bf0; color: #fff;
      border: none; border-radius: 4px; cursor: pointer; font-size: 11px; }
    #xc-panel button:hover { background: #1a8cd8; }
    #xc-count { font-weight: 600; margin-bottom: 4px; }
  `);

  let panelEl = null;
  async function refreshPanel() {
    if (!panelEl) return;
    const store = (await GM_getValue(STORE_KEY, {})) || {};
    const vals = Object.values(store);
    const bm = vals.filter((v) => v.kind === 'bookmark').length;
    const lk = vals.filter((v) => v.kind === 'like').length;
    panelEl.querySelector('#xc-count').textContent = `Bookmarks: ${bm} · Likes: ${lk}`;
  }

  function buildPanel() {
    if (document.getElementById('xc-panel')) return;
    panelEl = document.createElement('div');
    panelEl.id = 'xc-panel';
    panelEl.innerHTML = `
      <div id="xc-count">Bookmarks: 0 · Likes: 0</div>
      <button id="xc-json">Export JSON</button>
      <button id="xc-csv">Export CSV</button>
      <button id="xc-import">Import</button>
      <button id="xc-clear">Clear</button>
    `;
    document.body.appendChild(panelEl);
    panelEl.querySelector('#xc-json').addEventListener('click', exportJSON);
    panelEl.querySelector('#xc-csv').addEventListener('click', exportCSV);
    panelEl.querySelector('#xc-import').addEventListener('click', importJSON);
    panelEl.querySelector('#xc-clear').addEventListener('click', clearAll);
    refreshPanel();
  }

  GM_registerMenuCommand('Export bookmarks/likes JSON', exportJSON);
  GM_registerMenuCommand('Export bookmarks/likes CSV', exportCSV);
  GM_registerMenuCommand('Import bookmarks/likes JSON', importJSON);
  GM_registerMenuCommand('Clear bookmarks/likes', clearAll);

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', buildPanel);
  } else {
    buildPanel();
  }
})();
