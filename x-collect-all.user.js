// ==UserScript==
// @name         X - Collect Bookmarks, Likes, Following & Followers
// @namespace    https://ualan.dev/tampermonkey
// @version      1.6.1
// @description  Passively captures bookmarks, likes, following and followers (engagement stats, profile fields, and a raw GraphQL dump per item) as you scroll the matching X pages. One local store, one panel, export/import, manual sync to a cf-x-archive Worker, and an option to hide the sidebar "Subscribe to Premium" promo.
// @author       ualan
// @match        https://x.com/*
// @match        https://twitter.com/*
// @grant        unsafeWindow
// @grant        GM_setValue
// @grant        GM_getValue
// @grant        GM_addStyle
// @grant        GM_registerMenuCommand
// @grant        GM_xmlhttpRequest
// @connect      pixelbucket.org
// @connect      workers.dev
// @run-at       document-start
// @downloadURL  https://raw.githubusercontent.com/suspect453/Tampermonkey/main/x-collect-all.user.js
// @updateURL    https://raw.githubusercontent.com/suspect453/Tampermonkey/main/x-collect-all.user.js
// ==/UserScript==

// Reference: ~/dev/x-bookmarks-ext (capture/parse/store pattern) and this
// repo's earlier x-collect-bookmarks-likes.user.js / x-collect-following.user.js,
// merged into one script + one store + one panel to avoid two floating UIs
// overlapping when both were installed.

(function () {
  'use strict';

  const STORE_KEY = 'xCollectorAll';
  const TWEET_RE = /\/i\/api\/graphql\/[^/]+\/(Bookmarks|Likes)/;
  const USER_RE = /\/i\/api\/graphql\/[^/]+\/(Following|Followers)/;

  // ---- capture: hook the page's real fetch/XHR via unsafeWindow ----

  function hookNetwork(onBody) {
    const matchOp = (url) => {
      const t = TWEET_RE.exec(url);
      if (t) return t[1];
      const u = USER_RE.exec(url);
      if (u) return u[1];
      return null;
    };

    const origFetch = unsafeWindow.fetch;
    unsafeWindow.fetch = async function (...args) {
      const resp = await origFetch.apply(this, args);
      try {
        const url = typeof args[0] === 'string' ? args[0] : (args[0] && args[0].url) || '';
        const op = matchOp(url);
        if (op) {
          resp.clone().text().then((body) => onBody(op, body)).catch(() => {});
        }
      } catch { /* never break the page's own request */ }
      return resp;
    };

    const origOpen = unsafeWindow.XMLHttpRequest.prototype.open;
    unsafeWindow.XMLHttpRequest.prototype.open = function (method, url, ...rest) {
      const op = typeof url === 'string' && matchOp(url);
      if (op) {
        this.addEventListener('load', () => {
          if (typeof this.responseText === 'string') onBody(op, this.responseText);
        });
      }
      return origOpen.call(this, method, url, ...rest);
    };
  }

  // ---- shared helpers ----

  function currentAccount() {
    const link = document.querySelector('a[data-testid="AppTabBar_Profile_Link"]');
    const href = link?.getAttribute('href') ?? '';
    const m = /^\/([A-Za-z0-9_]{1,20})$/.exec(href);
    return m ? m[1] : null;
  }

  function viewedHandle() {
    const m = /^\/([A-Za-z0-9_]{1,20})\/(following|followers|verified_followers)/.exec(location.pathname);
    return m ? m[1] : null;
  }

  // ---- tweet parsing (bookmarks / likes) ----

  function unwrapTweet(result) {
    if (!result) return null;
    if (result.__typename === 'TweetWithVisibilityResults') return result.tweet;
    return result;
  }

  function extractTweetUser(tweet) {
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

  function collectTimelineTweets(node, out) {
    if (!node || typeof node !== 'object') return;
    if (Array.isArray(node)) {
      for (const child of node) collectTimelineTweets(child, out);
      return;
    }
    if (node.itemType === 'TimelineTweet' && node.tweet_results) {
      out.push(node);
      return;
    }
    for (const child of Object.values(node)) collectTimelineTweets(child, out);
  }

  function extractTweets(json, kind) {
    const items = [];
    collectTimelineTweets(json?.data, items);
    const account = currentAccount();
    const out = [];
    for (const item of items) {
      const tweet = unwrapTweet(item.tweet_results?.result);
      const legacy = tweet?.legacy;
      const id = tweet?.rest_id ?? legacy?.id_str;
      if (!id) continue;
      const { screenName, name } = extractTweetUser(tweet);
      out.push({
        kind, // 'bookmark' | 'like'
        id,
        key: `${kind}:${id}`,
        account,
        url: screenName ? `https://x.com/${screenName}/status/${id}` : null,
        screenName,
        name,
        createdAt: legacy?.created_at ?? null,
        text: tweet?.note_tweet?.note_tweet_results?.result?.text ?? legacy?.full_text ?? '',
        media: extractMedia(tweet),
        likeCount: legacy?.favorite_count ?? null,
        retweetCount: legacy?.retweet_count ?? null,
        replyCount: legacy?.reply_count ?? null,
        bookmarkCount: legacy?.bookmark_count ?? null,
        viewsCount: tweet?.views?.count != null ? Number(tweet.views.count) : null,
        lang: legacy?.lang ?? null,
        source: (tweet?.source ?? '').replace(/<[^>]+>/g, '') || null,
        possiblySensitive: !!legacy?.possibly_sensitive,
        quotedStatusId: tweet?.quoted_status_result?.result ? unwrapTweet(tweet.quoted_status_result.result)?.rest_id ?? null : null,
        isRetweet: !!legacy?.retweeted_status_result,
        // Full raw tweet object (legacy/core/views/quoted etc.) — a safety
        // net for fields we don't parse into their own column.
        raw: JSON.stringify(tweet),
        capturedAt: Date.now(),
      });
    }
    return out;
  }

  // ---- user parsing (following / followers) ----

  function collectTimelineUsers(node, out) {
    if (!node || typeof node !== 'object') return;
    if (Array.isArray(node)) {
      for (const child of node) collectTimelineUsers(child, out);
      return;
    }
    if (node.itemType === 'TimelineUser' && node.user_results) {
      out.push(node);
      return;
    }
    for (const child of Object.values(node)) collectTimelineUsers(child, out);
  }

  function extractUsers(json, kind) {
    const items = [];
    collectTimelineUsers(json?.data, items);
    const account = currentAccount();
    const listOwner = viewedHandle();
    const out = [];
    for (const item of items) {
      const result = item.user_results?.result;
      const legacy = result?.legacy ?? {};
      const core = result?.core ?? {};
      const id = result?.rest_id;
      if (!id) continue;
      const screenName = legacy.screen_name ?? core.screen_name ?? null;
      out.push({
        kind, // 'following' | 'follower'
        id,
        key: `${kind}:${listOwner ?? 'unknown'}:${id}`,
        account,
        listOwner,
        screenName,
        name: legacy.name ?? core.name ?? null,
        description: legacy.description ?? '',
        url: screenName ? `https://x.com/${screenName}` : null,
        followersCount: legacy.followers_count ?? null,
        followingCount: legacy.friends_count ?? null,
        verified: !!(result?.is_blue_verified || legacy.verified),
        location: legacy.location ?? result?.location?.location ?? null,
        profileImageUrl: (legacy.profile_image_url_https ?? '').replace('_normal', '_400x400') || null,
        bannerImageUrl: legacy.profile_banner_url ?? null,
        tweetsCount: legacy.statuses_count ?? null,
        listedCount: legacy.listed_count ?? null,
        favouritesCount: legacy.favourites_count ?? null,
        joinedAt: core.created_at ?? legacy.created_at ?? null,
        verifiedType: result?.verified_type ?? null,
        professionalCategory: result?.professional?.category?.[0]?.name ?? null,
        protected: !!legacy.protected,
        pinnedTweetId: legacy.pinned_tweet_ids_str?.[0] ?? null,
        // Full raw user object, in case a future feature needs a field not
        // pulled out above — X's GraphQL response has far more than we parse.
        raw: JSON.stringify(result),
        capturedAt: Date.now(),
      });
    }
    return out;
  }

  // ---- storage (one merged store keyed by record.key) ----

  let storeChain = Promise.resolve();
  function storeRecords(records) {
    if (records.length === 0) return;
    storeChain = storeChain.then(async () => {
      const store = (await GM_getValue(STORE_KEY, {})) || {};
      let added = 0;
      for (const r of records) {
        const prev = store[r.key];
        if (prev) {
          r.capturedAt = prev.capturedAt;
          r.account = r.account ?? prev.account;
        } else {
          added++;
        }
        store[r.key] = r;
      }
      await GM_setValue(STORE_KEY, store);
      if (added > 0) {
        console.info(`[x-collect] +${added} ${records[0].kind}, ${Object.keys(store).length} total`);
        flashStatus(`Captured ${added} new ${records[0].kind}${added === 1 ? '' : 's'}`);
        refreshPanel();
      }
    }).catch((e) => console.warn('[x-collect] store failed', e));
  }

  hookNetwork((op, body) => {
    let json;
    try { json = JSON.parse(body); } catch { return; }
    if (op === 'Bookmarks') storeRecords(extractTweets(json, 'bookmark'));
    else if (op === 'Likes') storeRecords(extractTweets(json, 'like'));
    else if (op === 'Following') storeRecords(extractUsers(json, 'following'));
    else if (op === 'Followers') storeRecords(extractUsers(json, 'follower'));
  });

  // ---- export / import (all kinds together) ----

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
    downloadBlob(`x-data-${Date.now()}.json`, 'application/json', JSON.stringify(store, null, 2));
  }

  async function exportCSV() {
    const store = (await GM_getValue(STORE_KEY, {})) || {};
    const rows = Object.values(store);
    const cols = ['kind', 'account', 'listOwner', 'screenName', 'name', 'text', 'description', 'url',
      'createdAt', 'likeCount', 'retweetCount', 'replyCount', 'bookmarkCount', 'viewsCount', 'lang',
      'followersCount', 'followingCount', 'verified', 'verifiedType', 'location', 'tweetsCount',
      'listedCount', 'joinedAt', 'protected', 'capturedAt'];
    const lines = [cols.join(',')];
    for (const r of rows) lines.push(cols.map((c) => csvEscape(r[c])).join(','));
    downloadBlob(`x-data-${Date.now()}.csv`, 'text/csv', lines.join('\n'));
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
    if (!confirm('Clear ALL captured bookmarks/likes/following/followers?')) return;
    await GM_setValue(STORE_KEY, {});
    refreshPanel();
  }

  // ---- sync to cf-x-archive (manual, on demand) ----
  // cf-x-archive sits behind Cloudflare Access on the whole app (incl.
  // /api/*), so plain bearer auth no longer gets past the edge. Auth here is
  // a CF Access Service Token (Zero Trust > Access > Service Auth > Service
  // Tokens), sent as CF-Access-Client-Id / CF-Access-Client-Secret headers —
  // the Access policy must separately allow that service token in.

  // Fixed, not prompted — a mistyped/pasted-wrong endpoint was the recurring
  // cause of "sync fails" reports, so there's nothing left to get wrong here.
  const CLOUD_ENDPOINT = 'https://cf-x-archive.pixelbucket.org';
  const CLIENT_ID_KEY = 'xArchiveCfAccessId';
  const CLIENT_SECRET_KEY = 'xArchiveCfAccessSecret';

  async function getCloudSettings() {
    let clientId = await GM_getValue(CLIENT_ID_KEY, '');
    let clientSecret = await GM_getValue(CLIENT_SECRET_KEY, '');
    if (!clientId) {
      clientId = (prompt('CF Access Service Token — Client ID') || '').trim();
      if (clientId) await GM_setValue(CLIENT_ID_KEY, clientId);
    }
    if (!clientSecret) {
      clientSecret = (prompt('CF Access Service Token — Client Secret') || '').trim();
      if (clientSecret) await GM_setValue(CLIENT_SECRET_KEY, clientSecret);
    }
    return { endpoint: CLOUD_ENDPOINT, clientId, clientSecret };
  }

  function gmPost(url, clientId, clientSecret, body) {
    return new Promise((resolve, reject) => {
      GM_xmlhttpRequest({
        method: 'POST',
        url,
        headers: {
          'Content-Type': 'application/json',
          'CF-Access-Client-Id': clientId,
          'CF-Access-Client-Secret': clientSecret,
        },
        data: JSON.stringify(body),
        onload: (res) => (res.status >= 200 && res.status < 300 ? resolve(res) : reject(new Error(`HTTP ${res.status}: ${res.responseText}`))),
        onerror: () => reject(new Error('network error')),
      });
    });
  }

  async function syncToCloud() {
    const { endpoint, clientId, clientSecret } = await getCloudSettings();
    if (!endpoint || !clientId || !clientSecret) return;
    const store = (await GM_getValue(STORE_KEY, {})) || {};
    const items = Object.values(store);
    if (items.length === 0) {
      flashStatus('Nothing to sync');
      return;
    }
    const BATCH = 200;
    try {
      for (let i = 0; i < items.length; i += BATCH) {
        await gmPost(`${endpoint}/api/sync`, clientId, clientSecret, { items: items.slice(i, i + BATCH) });
        flashStatus(`Synced ${Math.min(i + BATCH, items.length)}/${items.length}`);
      }
      flashStatus(`Synced ${items.length} item(s) to cloud`);
    } catch (e) {
      flashStatus(`Sync failed: ${e.message}`);
      console.warn('[x-collect] sync failed', e);
    }
  }

  function resetCloudSettings() {
    GM_setValue('xArchiveEndpoint', ''); // stale key from before the endpoint was hardcoded
    GM_setValue(CLIENT_ID_KEY, '');
    GM_setValue(CLIENT_SECRET_KEY, '');
    alert('Service token cleared. Next sync will ask again.');
  }

  // ---- open current tweet/profile on a mirror ----

  function openOnMirror(host) {
    window.open(`https://${host}${location.pathname}`, '_blank', 'noopener');
  }

  // ---- hide the "Subscribe to Premium" upsell card (right sidebar) ----
  // X gives it no stable testid, so match it by its own text, then walk up
  // from the matching text node to the nearest ancestor that looks like the
  // card's outer wrapper (rounded corners, sidebar-column width).

  const HIDE_PREMIUM_KEY = 'xHidePremiumAd';
  const hiddenPremiumEls = new Set();
  let hidePremiumAd = true;

  function looksLikeCardRoot(el) {
    const style = getComputedStyle(el);
    return parseFloat(style.borderRadius) > 0 && el.getBoundingClientRect().width > 200;
  }

  function findPremiumAdCard(textEl) {
    let node = textEl;
    for (let i = 0; i < 8 && node && node !== document.body; i++) {
      if (looksLikeCardRoot(node)) return node;
      node = node.parentElement;
    }
    return textEl.closest('[data-testid="sidebarColumn"] > div > div > div') ?? null;
  }

  function applyPremiumAdVisibility() {
    hiddenPremiumEls.forEach((el) => { el.style.display = hidePremiumAd ? 'none' : ''; });
  }

  function scanForPremiumAd() {
    const sidebar = document.querySelector('[data-testid="sidebarColumn"]');
    if (!sidebar) return;
    const walker = document.createTreeWalker(sidebar, NodeFilter.SHOW_ELEMENT, {
      acceptNode: (el) => (/subscribe to premium/i.test(el.textContent || '') ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_SKIP),
    });
    let node;
    let found = false;
    while ((node = walker.nextNode())) {
      const card = findPremiumAdCard(node);
      if (card && !hiddenPremiumEls.has(card)) { hiddenPremiumEls.add(card); found = true; }
    }
    if (found) applyPremiumAdVisibility();
  }

  let premiumScanTimer = null;
  function startPremiumAdWatcher() {
    if (!document.body) { setTimeout(startPremiumAdWatcher, 100); return; }
    new MutationObserver(() => {
      clearTimeout(premiumScanTimer);
      premiumScanTimer = setTimeout(scanForPremiumAd, 300);
    }).observe(document.body, { childList: true, subtree: true });
    scanForPremiumAd();
  }

  (async () => {
    try {
      hidePremiumAd = await GM_getValue(HIDE_PREMIUM_KEY, true);
      if (panelEl) panelEl.querySelector('#xc-hide-premium-cb').checked = hidePremiumAd;
      applyPremiumAdVisibility();
    } catch (e) { console.warn('[x-collect] premium-ad setting load failed', e); }
  })();
  startPremiumAdWatcher();

  // ---- floating panel ----

  GM_addStyle(`
    #xc-panel { position: fixed; bottom: 16px; right: 16px; z-index: 999999;
      font: 12px/1.4 -apple-system, sans-serif; background: #15202b; color: #fff;
      border: 1px solid #38444d; border-radius: 8px; box-shadow: 0 2px 8px rgba(0,0,0,.4);
      width: 220px; overflow: hidden; }
    #xc-header { display: flex; justify-content: space-between; align-items: center;
      padding: 8px 10px; cursor: pointer; background: #1c2732; }
    #xc-header b { font-size: 12px; }
    #xc-toggle { color: #8899a6; font-size: 11px; }
    #xc-body { padding: 8px 10px; }
    #xc-counts { display: grid; grid-template-columns: 1fr 1fr; gap: 4px 8px; margin-bottom: 6px; }
    #xc-counts div { color: #8899a6; }
    #xc-counts b { color: #fff; }
    #xc-hint { font-size: 10.5px; color: #8899a6; margin-bottom: 8px; line-height: 1.5; }
    #xc-hint code { color: #1d9bf0; }
    #xc-status { font-size: 10.5px; color: #00ba7c; min-height: 14px; margin-bottom: 4px; }
    #xc-panel button { margin: 2px 2px 0 0; padding: 4px 8px; background: #1d9bf0; color: #fff;
      border: none; border-radius: 4px; cursor: pointer; font-size: 11px; }
    #xc-panel button:hover { background: #1a8cd8; }
    #xc-panel button.danger { background: #f4212e; }
    #xc-panel button.danger:hover { background: #d61b27; }
    #xc-panel.collapsed #xc-body { display: none; }
  `);

  let panelEl = null;
  let statusTimer = null;
  function flashStatus(msg) {
    if (!panelEl) return;
    const el = panelEl.querySelector('#xc-status');
    el.textContent = msg;
    clearTimeout(statusTimer);
    statusTimer = setTimeout(() => { el.textContent = ''; }, 4000);
  }

  async function refreshPanel() {
    if (!panelEl) return;
    const store = (await GM_getValue(STORE_KEY, {})) || {};
    const vals = Object.values(store);
    const count = (k) => vals.filter((v) => v.kind === k).length;
    panelEl.querySelector('#xc-bm').textContent = count('bookmark');
    panelEl.querySelector('#xc-lk').textContent = count('like');
    panelEl.querySelector('#xc-fg').textContent = count('following');
    panelEl.querySelector('#xc-fr').textContent = count('follower');
  }

  function buildPanel() {
    if (document.getElementById('xc-panel')) return;
    panelEl = document.createElement('div');
    panelEl.id = 'xc-panel';
    panelEl.innerHTML = `
      <div id="xc-header">
        <b>X Data Collector</b>
        <span id="xc-toggle">▾</span>
      </div>
      <div id="xc-body">
        <div id="xc-counts">
          <div>Bookmarks: <b id="xc-bm">0</b></div>
          <div>Likes: <b id="xc-lk">0</b></div>
          <div>Following: <b id="xc-fg">0</b></div>
          <div>Followers: <b id="xc-fr">0</b></div>
        </div>
        <div id="xc-hint">
          Scroll each page to capture it:<br>
          Bookmarks → <code>x.com/i/bookmarks</code><br>
          Likes → your profile's <code>Likes</code> tab<br>
          Following → <code>x.com/&lt;you&gt;/following</code><br>
          Followers → <code>x.com/&lt;you&gt;/followers</code>
        </div>
        <div id="xc-status"></div>
        <label id="xc-hide-premium" style="display:flex;align-items:center;gap:6px;margin-bottom:6px;cursor:pointer;">
          <input type="checkbox" id="xc-hide-premium-cb" checked>
          Hide "Subscribe to Premium" promo
        </label>
        <button id="xc-xcancel">Open on xcancel</button>
        <button id="xc-nitter">Open on nitter</button>
        <button id="xc-sync">Sync to cloud</button>
        <button id="xc-json">Export JSON</button>
        <button id="xc-csv">Export CSV</button>
        <button id="xc-import">Import</button>
        <button id="xc-clear" class="danger">Clear all</button>
      </div>
    `;
    document.body.appendChild(panelEl);
    panelEl.querySelector('#xc-header').addEventListener('click', () => {
      panelEl.classList.toggle('collapsed');
      panelEl.querySelector('#xc-toggle').textContent = panelEl.classList.contains('collapsed') ? '▸' : '▾';
    });
    panelEl.querySelector('#xc-xcancel').addEventListener('click', (e) => { e.stopPropagation(); openOnMirror('xcancel.com'); });
    panelEl.querySelector('#xc-nitter').addEventListener('click', (e) => { e.stopPropagation(); openOnMirror('nitter.net'); });
    panelEl.querySelector('#xc-sync').addEventListener('click', (e) => { e.stopPropagation(); syncToCloud(); });
    panelEl.querySelector('#xc-json').addEventListener('click', (e) => { e.stopPropagation(); exportJSON(); });
    panelEl.querySelector('#xc-csv').addEventListener('click', (e) => { e.stopPropagation(); exportCSV(); });
    panelEl.querySelector('#xc-import').addEventListener('click', (e) => { e.stopPropagation(); importJSON(); });
    panelEl.querySelector('#xc-clear').addEventListener('click', (e) => { e.stopPropagation(); clearAll(); });
    panelEl.querySelector('#xc-hide-premium').addEventListener('click', (e) => e.stopPropagation());
    panelEl.querySelector('#xc-hide-premium-cb').checked = hidePremiumAd;
    panelEl.querySelector('#xc-hide-premium-cb').addEventListener('change', async (e) => {
      hidePremiumAd = e.target.checked;
      await GM_setValue(HIDE_PREMIUM_KEY, hidePremiumAd);
      applyPremiumAdVisibility();
    });
    refreshPanel();
  }

  GM_registerMenuCommand('Open current page on xcancel', () => openOnMirror('xcancel.com'));
  GM_registerMenuCommand('Open current page on nitter', () => openOnMirror('nitter.net'));
  GM_registerMenuCommand('Sync X data to cloud', syncToCloud);
  GM_registerMenuCommand('Export X data (JSON)', exportJSON);
  GM_registerMenuCommand('Export X data (CSV)', exportCSV);
  GM_registerMenuCommand('Import X data (JSON)', importJSON);
  GM_registerMenuCommand('Reset cloud endpoint/token', resetCloudSettings);
  GM_registerMenuCommand('Clear all X data', clearAll);

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', buildPanel);
  } else {
    buildPanel();
  }
})();
