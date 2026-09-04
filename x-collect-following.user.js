// ==UserScript==
// @name         X - Collect Following & Followers
// @namespace    https://ualan.dev/tampermonkey
// @version      1.0.0
// @description  Passively captures accounts you follow / who follow you as you scroll x.com/<handle>/following or /followers. Stored locally via GM storage. Export/import JSON, export CSV.
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

// Reference: ~/dev/x-bookmarks-ext (same capture/store/export pattern as its
// Bookmarks/Likes handling, adapted for the Following/Followers GraphQL
// endpoints, which return TimelineUser items instead of TimelineTweet).

(function () {
  'use strict';

  const STORE_KEY = 'xCollectorFollows';
  const CAPTURE_RE = /\/i\/api\/graphql\/[^/]+\/(Following|Followers)/;

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

  // ---- parse: defensive traversal for TimelineUser items ----

  function currentAccount() {
    const link = document.querySelector('a[data-testid="AppTabBar_Profile_Link"]');
    const href = link?.getAttribute('href') ?? '';
    const m = /^\/([A-Za-z0-9_]{1,20})$/.exec(href);
    return m ? m[1] : null;
  }

  // Who's list is being viewed: /<handle>/following or /<handle>/followers
  function viewedHandle() {
    const m = /^\/([A-Za-z0-9_]{1,20})\/(following|followers|verified_followers)/.exec(location.pathname);
    return m ? m[1] : null;
  }

  function collectUserItems(node, out) {
    if (!node || typeof node !== 'object') return;
    if (Array.isArray(node)) {
      for (const child of node) collectUserItems(child, out);
      return;
    }
    if (node.itemType === 'TimelineUser' && node.user_results) {
      out.push(node);
      return;
    }
    for (const child of Object.values(node)) collectUserItems(child, out);
  }

  function extractUsersFromResponse(json, kind) {
    const items = [];
    collectUserItems(json?.data, items);
    const account = currentAccount();
    const viewed = viewedHandle();
    const users = [];
    for (const item of items) {
      const result = item.user_results?.result;
      const legacy = result?.legacy ?? {};
      const core = result?.core ?? {};
      const id = result?.rest_id;
      if (!id) continue;
      const screenName = legacy.screen_name ?? core.screen_name ?? null;
      users.push({
        id,
        kind, // 'following' | 'follower'
        account,        // logged-in account browsing
        listOwner: viewed, // whose following/followers list this came from
        screenName,
        name: legacy.name ?? core.name ?? null,
        description: legacy.description ?? '',
        url: screenName ? `https://x.com/${screenName}` : null,
        followersCount: legacy.followers_count ?? null,
        followingCount: legacy.friends_count ?? null,
        verified: !!(result?.is_blue_verified || legacy.verified),
        capturedAt: Date.now(),
      });
    }
    return users;
  }

  function recordKey(u) {
    return `${u.kind}:${u.listOwner ?? 'unknown'}:${u.id}`;
  }

  // ---- storage ----

  let storeChain = Promise.resolve();
  function storeUsers(users) {
    storeChain = storeChain.then(async () => {
      const store = (await GM_getValue(STORE_KEY, {})) || {};
      let added = 0;
      for (const u of users) {
        const key = recordKey(u);
        const prev = store[key];
        if (prev) {
          u.capturedAt = prev.capturedAt;
        } else {
          added++;
        }
        store[key] = u;
      }
      await GM_setValue(STORE_KEY, store);
      if (added > 0) {
        console.info(`[x-collect-follow] captured ${added} new item(s), ${Object.keys(store).length} total`);
        refreshPanel();
      }
    }).catch((e) => console.warn('[x-collect-follow] store failed', e));
  }

  hookNetwork((op, body) => {
    let json;
    try { json = JSON.parse(body); } catch { return; }
    const kind = op === 'Followers' ? 'follower' : 'following';
    const users = extractUsersFromResponse(json, kind);
    if (users.length > 0) storeUsers(users);
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
    downloadBlob(`x-following-followers-${Date.now()}.json`, 'application/json', JSON.stringify(store, null, 2));
  }

  async function exportCSV() {
    const store = (await GM_getValue(STORE_KEY, {})) || {};
    const rows = Object.values(store);
    const cols = ['kind', 'listOwner', 'account', 'screenName', 'name', 'description', 'url', 'followersCount', 'followingCount', 'verified', 'capturedAt'];
    const lines = [cols.join(',')];
    for (const r of rows) lines.push(cols.map((c) => csvEscape(r[c])).join(','));
    downloadBlob(`x-following-followers-${Date.now()}.csv`, 'text/csv', lines.join('\n'));
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
    if (!confirm('Clear all captured following/followers?')) return;
    await GM_setValue(STORE_KEY, {});
    refreshPanel();
  }

  // ---- minimal floating panel ----

  GM_addStyle(`
    #xcf-panel { position: fixed; bottom: 16px; right: 200px; z-index: 999999;
      font: 12px/1.4 -apple-system, sans-serif; background: #15202b; color: #fff;
      border: 1px solid #38444d; border-radius: 8px; padding: 8px 10px; box-shadow: 0 2px 8px rgba(0,0,0,.4); }
    #xcf-panel button { margin: 2px; padding: 4px 8px; background: #1d9bf0; color: #fff;
      border: none; border-radius: 4px; cursor: pointer; font-size: 11px; }
    #xcf-panel button:hover { background: #1a8cd8; }
    #xcf-count { font-weight: 600; margin-bottom: 4px; }
  `);

  let panelEl = null;
  async function refreshPanel() {
    if (!panelEl) return;
    const store = (await GM_getValue(STORE_KEY, {})) || {};
    const vals = Object.values(store);
    const fg = vals.filter((v) => v.kind === 'following').length;
    const fr = vals.filter((v) => v.kind === 'follower').length;
    panelEl.querySelector('#xcf-count').textContent = `Following: ${fg} · Followers: ${fr}`;
  }

  function buildPanel() {
    if (document.getElementById('xcf-panel')) return;
    panelEl = document.createElement('div');
    panelEl.id = 'xcf-panel';
    panelEl.innerHTML = `
      <div id="xcf-count">Following: 0 · Followers: 0</div>
      <button id="xcf-json">Export JSON</button>
      <button id="xcf-csv">Export CSV</button>
      <button id="xcf-import">Import</button>
      <button id="xcf-clear">Clear</button>
    `;
    document.body.appendChild(panelEl);
    panelEl.querySelector('#xcf-json').addEventListener('click', exportJSON);
    panelEl.querySelector('#xcf-csv').addEventListener('click', exportCSV);
    panelEl.querySelector('#xcf-import').addEventListener('click', importJSON);
    panelEl.querySelector('#xcf-clear').addEventListener('click', clearAll);
    refreshPanel();
  }

  GM_registerMenuCommand('Export following/followers JSON', exportJSON);
  GM_registerMenuCommand('Export following/followers CSV', exportCSV);
  GM_registerMenuCommand('Import following/followers JSON', importJSON);
  GM_registerMenuCommand('Clear following/followers', clearAll);

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', buildPanel);
  } else {
    buildPanel();
  }
})();
