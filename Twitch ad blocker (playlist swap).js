// ==UserScript==
// @name         Twitch ad blocker (playlist swap)
// @match        https://www.twitch.tv/*
// @run-at       document-start
// @grant        none
// @noframes
// ==/UserScript==

(function () {
  'use strict';
  if (window.__twAdblockInstalled) return;          // never install twice
  window.__twAdblockInstalled = true;

  // ---------- Runs inside the player's Web Worker (serialized with toString) ----------
  function workerMain() {
    // ===== Settings =====
    const DEBUG = true;               // false = quiet console
    // true  = always play the ad-free backup stream (no switching, so no stall when ads start or end)
    // false = only switch to the backup while an ad is running
    const ALWAYS_ON = true;
    // true  = ask Twitch for H.264 only, so the player always stays on a codec the backup stream also has.
    //         (Twitch's backup streams are H.264 only: if the player moves to a HEVC/AV1 rendition, ads can't be swapped out.)
    // false = let the player use HEVC/AV1 when offered; ads can then show while such a rendition plays.
    const FORCE_H264 = true;
    const CLIENT_ID = 'kimne78kx3ncx6brgo4mv6wki5h1ko'; // Twitch web player's public client id
    const PLAYER_TYPES = ['embed', 'popout', 'autoplay', 'picture-by-picture'];
    const GQL_QUERY = 'query PlaybackAccessToken_Template($login: String!, $isLive: Boolean!, $vodID: ID!, $isVod: Boolean!, $playerType: String!) { streamPlaybackAccessToken(channelName: $login, params: {platform: "web", playerBackend: "mediaplayer", playerType: $playerType}) @include(if: $isLive) { value signature __typename } videoPlaybackAccessToken(id: $vodID, params: {platform: "web", playerBackend: "mediaplayer", playerType: $playerType}) @include(if: $isVod) { value signature __typename } }';

    // ===== Limits (ms) =====
    const TOKEN_TIMEOUT = 4000;       // access token + stream list requests
    const PLAYLIST_TIMEOUT = 3000;    // one backup media playlist
    const MAX_WAIT = 5000;            // never hold the player's playlist request longer than this waiting for the backup
    const CACHE_FRESH = 60000;        // backup stream list is reused this long...
    const CACHE_MAX = 600000;         // ...and used (while refreshing in the background) up to this long

    const origFetch = self.fetch;
    const bc = (typeof BroadcastChannel !== 'undefined') ? new BroadcastChannel('twitch-adblock-ctl') : null;
    let channel = null;
    let adActive = false;
    let lastMode = '';
    let preferred = null;
    let adSwaps = 0;
    let seqOffset = null;
    let alwaysOn = ALWAYS_ON;
    let failCount = 0;
    let warnedUnknown = false;
    let cleanStreak = 0;
    let backoffUntil = 0, backoffStep = 0, lastCandLog = '', masterCodecs = '';
    let forceOff = false, lastMismatchLog = '', lastMasterLog = '', lastMediaStatus = 0;
    const inflight = {};             // playerType -> pending variants request (dedupes identical requests)
    let lastGood = {};               // media URL -> last good backup playlist text
    const seq = t => (t.match(/#EXT-X-MEDIA-SEQUENCE:(\d+)/) || [])[1];
    const knownVariants = new Map(); // media playlist URL -> {group,res,bw,codecs}
    const backupCache = {};          // playerType -> {t, variants}

    function log() { if (DEBUG) console.log.apply(console, ['[adblock]'].concat([].slice.call(arguments))); }
    function setMode(m) { if (m !== lastMode) { lastMode = m; log(m); } }
    function errMsg(e) { return (e && e.name === 'AbortError') ? 'timeout' : (e && e.message) ? e.message : String(e); }

    function hasAd(text) {
      return text.includes('twitch-stitched-ad') || text.includes('twitch-maf-ad') ||
             text.includes('stitched-ad-') || text.includes('X-TV-TWITCH-AD-URL');
    }

    // A playlist we are willing to hand to the player: real HLS with at least one segment
    function validPlaylist(t) {
      return typeof t === 'string' && t.indexOf('#EXTM3U') !== -1 && t.indexOf('#EXTINF') !== -1;
    }

    // fetch + read the whole body under ONE timeout, so a stalled request can never hang the player
    async function getText(url, init, ms) {
      const ac = typeof AbortController !== 'undefined' ? new AbortController() : null;
      const timer = setTimeout(function () { if (ac) ac.abort(); }, ms);
      try {
        const o = Object.assign({}, init || {});
        if (ac) o.signal = ac.signal;
        const r = await origFetch(url, o);
        const text = await r.text();
        return { ok: r.ok, status: r.status, text: text };
      } finally { clearTimeout(timer); }
    }

    function raceTimeout(p, ms) {
      let timer;
      return Promise.race([
        p,
        new Promise(function (resolve) { timer = setTimeout(function () { resolve(null); }, ms); })
      ]).finally(function () { clearTimeout(timer); });
    }

    // Build a response for the player. Drop headers that described the ORIGINAL body (length / compression).
    function synth(text, res) {
      let h;
      try { h = new Headers(res.headers); } catch (e) { h = new Headers(); }
      h.delete('content-length');
      h.delete('content-encoding');
      if (!h.has('content-type')) h.set('content-type', 'application/vnd.apple.mpegurl');
      return new Response(text, { status: 200, statusText: 'OK', headers: h });
    }

    function parseMaster(text) {
      const lines = text.split(/\r?\n/);
      const out = [];
      for (let i = 0; i < lines.length; i++) {
        if (!lines[i].startsWith('#EXT-X-STREAM-INF:')) continue;
        const url = lines[i + 1];
        if (!url || !url.startsWith('http')) continue;
        out.push({
          codecs: (lines[i].match(/CODECS="([^"]+)"/) || [])[1] || '',
          group: (lines[i].match(/VIDEO="([^"]+)"/) || [])[1] || '',
          res: (lines[i].match(/RESOLUTION=([0-9x]+)/) || [])[1] || '',
          bw: +((lines[i].match(/BANDWIDTH=(\d+)/) || [])[1] || 0),
          url: url
        });
      }
      return out;
    }

    function codecOf(v) { return (v.codecs || '').split(',')[0].split('.')[0]; }

    // Never swap to a stream with a different video codec than the one the player was set up for
    function pickVariant(variants, info) {
      const pool = info.codecs ? variants.filter(function (v) { return codecOf(v) === codecOf(info); }) : variants;
      if (!pool.length) return undefined;
      const byGroup = info.group && pool.find(function (v) { return v.group === info.group; });
      if (byGroup) return byGroup;
      const byRes = info.res && pool.find(function (v) { return v.res === info.res; });
      if (byRes) return byRes;
      const sorted = pool.slice().sort(function (a, b) { return b.bw - a.bw; });   // highest first
      if (info.bw) {   // closest rendition that does not exceed the player's choice: no surprise upswitch / buffering
        return sorted.find(function (v) { return v.bw <= info.bw; }) || sorted[sorted.length - 1];
      }
      return sorted[0];
    }

    function noVariantWhy(variants, info) {
      const have = Array.from(new Set(variants.map(codecOf))).join('/') || 'nothing';
      return 'no matching variant (player codec ' + (codecOf(info) || '?') + ', backup offers ' + have + ')';
    }

    function variantInfo(u) { return knownVariants.get(u.split('?')[0]) || null; }

    // When the backup requests fail, stop hammering Twitch: pause 3s, 6s, 12s ... up to 60s, then retry
    function inBackoff() { return Date.now() < backoffUntil; }
    function noteFail(why) {
      backoffStep = Math.min(backoffStep + 1, 6);
      if (/HTTP 429/.test(why)) backoffStep = Math.max(backoffStep, 4);   // rate limited: back off harder
      const ms = Math.min(60000, 3000 * Math.pow(2, backoffStep - 1));
      backoffUntil = Date.now() + ms;
      log('backup failed (' + why + '), pausing backup requests for ' + Math.round(ms / 1000) + 's');
    }
    function noteOk() { backoffStep = 0; backoffUntil = 0; }
    // A codec mismatch is not a network problem: no backoff (the player may switch to a matching rendition any moment)
    function noteMismatch(why) {
      if (why === lastMismatchLog) return;
      lastMismatchLog = why;
      log('backup stream cannot be used for this rendition: ' + why +
          (FORCE_H264 && !forceOff ? ' - Twitch still sent the player a non-H.264 stream' : ' (set FORCE_H264 = true to avoid this)'));
    }

    async function fetchBackupVariants(pt) {
      const g = await getText('https://gql.twitch.tv/gql', {
        method: 'POST',
        headers: { 'Client-ID': CLIENT_ID, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          operationName: 'PlaybackAccessToken_Template',
          query: GQL_QUERY,
          variables: { isLive: true, login: channel, isVod: false, vodID: '', playerType: pt }
        })
      }, TOKEN_TIMEOUT);
      if (!g.ok) throw new Error('gql HTTP ' + g.status);
      let j;
      try { j = JSON.parse(g.text); } catch (e) { throw new Error('gql returned invalid JSON'); }
      const tk = j && j.data && j.data.streamPlaybackAccessToken;
      if (!tk) throw new Error('no access token' + (j && j.errors ? ': ' + JSON.stringify(j.errors).slice(0, 120) : ''));
      const params = new URLSearchParams({
        allow_source: 'true', allow_audio_only: 'true', player_backend: 'mediaplayer',
        playlist_include_framerate: 'true', supported_codecs: masterCodecs || 'avc1',
        p: String(Math.floor(Math.random() * 1e7)), sig: tk.signature, token: tk.value
      });
      const m = await getText('https://usher.ttvnw.net/api/channel/hls/' + channel + '.m3u8?' + params, null, TOKEN_TIMEOUT);
      if (!m.ok) throw new Error('usher HTTP ' + m.status);
      const variants = parseMaster(m.text);
      if (!variants.length) throw new Error('usher returned no variants');   // never cache an empty list
      backupCache[pt] = { t: Date.now(), variants: variants };
      return variants;
    }

    function fetchBackupVariantsOnce(pt) {
      return inflight[pt] || (inflight[pt] = fetchBackupVariants(pt).finally(function () { delete inflight[pt]; }));
    }

    async function getBackupVariants(pt) {
      const c = backupCache[pt];
      const age = c ? Date.now() - c.t : Infinity;
      if (c && age < CACHE_FRESH) return c.variants;
      if (c && age < CACHE_MAX) {         // stale: use it now, refresh in the background
        if (!c.refreshing) {
          c.refreshing = true;
          fetchBackupVariantsOnce(pt).catch(function () { setTimeout(function () { c.refreshing = false; }, 15000); });
        }
        return c.variants;
      }
      return fetchBackupVariantsOnce(pt);
    }

    // Try one player type: returns {text,pt,seq} when it gives a clean playlist, {ad:true} or {failed:reason} otherwise
    async function tryType(pt, info) {
      try {
        const variants = await getBackupVariants(pt);
        const v = pickVariant(variants, info);
        if (!v) return { pt: pt, failed: noVariantWhy(variants, info), mismatch: variants.length > 0 };
        const r = await getText(v.url, null, PLAYLIST_TIMEOUT);
        if (!r.ok) {
          if (r.status >= 400 && r.status < 500) delete backupCache[pt];   // token expired: fetch a fresh one next time
          return { pt: pt, failed: 'HTTP ' + r.status };
        }
        if (hasAd(r.text)) return { pt: pt, ad: true };
        if (!validPlaylist(r.text)) return { pt: pt, failed: 'invalid playlist' };
        return { pt: pt, text: r.text, seq: +seq(r.text) || 0 };
      } catch (e) {
        return { pt: pt, failed: errMsg(e) };
      }
    }

    async function getCleanPlaylist(mediaUrl) {
      if (inBackoff()) return null;
      const info = variantInfo(mediaUrl) || {};
      const order = preferred ? [preferred].concat(PLAYER_TYPES.filter(function (p) { return p !== preferred; })) : PLAYER_TYPES;
      let failures = 0, why = '';
      for (const pt of order) {
        const r = await tryType(pt, info);
        if (r.text) { preferred = pt; noteOk(); return r; }
        if (r.mismatch) { noteMismatch(r.failed); return null; }   // codec issue, not network: no backoff, other types will not differ
        if (r.failed) { failures++; why = why || r.failed; }
        if (r.failed === 'timeout') { failures = order.length; break; }   // network trouble hits every type: do not wait 4x
      }
      if (failures === order.length) noteFail(why);
      return null;
    }

    // First swap of an ad: try every player type in parallel and use the freshest ad-free one
    async function pickBestBackup(mediaUrl) {
      if (inBackoff()) return null;
      const info = variantInfo(mediaUrl) || {};
      const results = await Promise.all(PLAYER_TYPES.map(function (pt) { return tryType(pt, info); }));
      const line = 'backup candidates: ' + results.map(function (r) {
        return r.pt + (r.failed ? ' failed (' + r.failed + ')' : r.ad ? ' has ads' : ' seq ' + r.seq);
      }).join(', ');
      if (line !== lastCandLog) { lastCandLog = line; log(line); }
      const ok = results.filter(function (r) { return r.text; }).sort(function (a, b) { return b.seq - a.seq; });
      if (ok[0]) { preferred = ok[0].pt; noteOk(); return ok[0]; }
      if (results.every(function (r) { return r.failed; })) {
        const net = results.filter(function (r) { return !r.mismatch; });
        if (net.length) noteFail(net[0].failed); else noteMismatch(results[0].failed);
      }
      return null;
    }

    // The player tracks segments by media-sequence number. After an ad, the original playlist's numbering
    // runs ahead of the real stream's, so a backup playlist with lower numbers looks "already played" and the
    // player stalls. Shift the backup's numbering so it continues where the original left off.
    function parseSegs(text) {
      const segs = [];
      let pdt = null;
      text.split(/\r?\n/).forEach(function (l) {
        if (l.startsWith('#EXT-X-PROGRAM-DATE-TIME:')) pdt = Date.parse(l.slice(25).trim());
        else if (l.startsWith('#EXTINF')) { segs.push({ pdt: pdt, title: l.slice(l.indexOf(',') + 1).trim() }); pdt = null; }
      });
      return { mediaSeq: +seq(text) || 0, segs: segs };
    }

    function computeSeqOffset(origText, backupText) {
      const o = parseSegs(origText), b = parseSegs(backupText);
      if (!o.segs.length || !b.segs.length) return 0;
      const adIdx = o.segs.findIndex(function (x) { return x.title && x.title !== 'live'; });
      const idx = adIdx >= 0 ? adIdx : o.segs.length - 1;
      const t0 = o.segs[idx].pdt;
      const havePdt = t0 !== null && !isNaN(t0) && b.segs.every(function (x) { return x.pdt !== null && !isNaN(x.pdt); });
      if (!havePdt) return o.mediaSeq - b.mediaSeq;               // fallback: align window starts
      let bIdx;
      if (adIdx >= 0) {                                            // segment that should follow the last live one
        let lastBefore = -1;
        b.segs.forEach(function (x, i) { if (x.pdt < t0 - 100) lastBefore = i; });
        bIdx = lastBefore + 1;
      } else {                                                     // no ad segments (client-side marker): match by time
        bIdx = 0;
        b.segs.forEach(function (x, i) { if (Math.abs(x.pdt - t0) < Math.abs(b.segs[bIdx].pdt - t0)) bIdx = i; });
      }
      return (o.mediaSeq + idx) - (b.mediaSeq + bIdx);
    }

    function shiftSeq(text, off) {
      if (!off) return text;
      return text.replace(/#EXT-X-MEDIA-SEQUENCE:(\d+)/, function (m, n) {
        return '#EXT-X-MEDIA-SEQUENCE:' + Math.max(0, +n + off);
      });
    }

    // Fallback: remove ad segments and ad markers from the original playlist
    function stripAds(text) {
      const lines = text.split(/\r?\n/);
      const out = [];
      for (let i = 0; i < lines.length; i++) {
        const l = lines[i];
        if (l.startsWith('#EXT-X-DATERANGE') && /CLASS="twitch-(stitched-ad|ad-quartile|maf-ad)"/.test(l)) continue;
        if (l.startsWith('#EXT-X-TWITCH-PREFETCH')) continue;
        if (l.startsWith('#EXTINF')) {
          const title = l.slice(l.indexOf(',') + 1).trim();
          if (title && title !== 'live') {            // ad segment ("Amazon|...")
            if (out.length && out[out.length - 1].startsWith('#EXT-X-PROGRAM-DATE-TIME')) out.pop();
            i++;                                       // skip its URL line
            continue;
          }
        }
        out.push(l);
      }
      return out.join('\n');
    }

    function resetChannel(name) {
      channel = name;
      alwaysOn = ALWAYS_ON; failCount = 0; warnedUnknown = false; cleanStreak = 0;
      lastGood = {}; adActive = false; adSwaps = 0; seqOffset = null; preferred = null;
      backoffUntil = 0; backoffStep = 0; lastCandLog = ''; lastMismatchLog = ''; lastMasterLog = ''; lastMediaStatus = 0;
      knownVariants.clear();
      Object.keys(backupCache).forEach(function (k) { delete backupCache[k]; });
    }

    async function handlePlaylist(input, url, origArgs) {
      const isUsher = url.indexOf('usher.ttvnw.net') !== -1;
      const isMedia = !isUsher && /\/v1\/playlist\//.test(url);

      if (isMedia && alwaysOn && channel && knownVariants.size && !variantInfo(url) && !warnedUnknown) {
        warnedUnknown = true;
        log('media playlist not found in master variants (' + knownVariants.size + ' known, ...' + url.slice(-30) + '), always-on skipped for it');
      }
      // Always-on mode: start the backup request in parallel with the original one
      const always = (alwaysOn && isMedia && channel && variantInfo(url))
        ? getCleanPlaylist(url).catch(function () { return null; }) : null;
      // Ad-only mode: while an ad is running, start the backup request in parallel with the original one
      const speculative = (!alwaysOn && isMedia && adActive && channel)
        ? getCleanPlaylist(url).catch(function () { return null; }) : null;

      const tStart = Date.now();
      let args = origArgs, forced = false;
      if (FORCE_H264 && !forceOff && isUsher && /\/hls\//.test(url)) {
        const nu = /[?&]supported_codecs=/.test(url)
          ? url.replace(/([?&]supported_codecs=)[^&]*/, '$1avc1')
          : url + (url.indexOf('?') === -1 ? '?' : '&') + 'supported_codecs=avc1';
        if (nu !== url) {
          const first = (input && typeof input === 'object' && input.url !== undefined) ? new Request(nu, input) : nu;
          args = [first].concat([].slice.call(origArgs, 1));
          forced = true;
        }
      }
      let res = await origFetch.apply(self, args);
      if (forced && (res.status === 400 || res.status >= 500)) {   // Twitch did not like the change: undo it, for good
        forceOff = true;
        log('H.264-only request failed (HTTP ' + res.status + '), retrying unmodified and turning FORCE_H264 off');
        res = await origFetch.apply(self, origArgs);
      }
      const origMs = Date.now() - tStart;
      try {
        if (isUsher) {                                   // master playlist
          const m = url.match(/\/hls\/([^\/?.]+)\.m3u8/i);
          if (!m) return res;                            // VOD or anything that is not a live channel: leave alone
          const name = m[1].toLowerCase();
          if (name !== channel) resetChannel(name);      // new channel: reset per-channel state
          if (!res.ok) { log('master playlist for "' + name + '" returned HTTP ' + res.status); return res; }
          let sc = '';
          try { sc = new URL(url).searchParams.get('supported_codecs') || ''; } catch (e) {}
          if (FORCE_H264 && !forceOff) sc = 'avc1';
          if (sc !== masterCodecs) {
            masterCodecs = sc;
            Object.keys(backupCache).forEach(function (k) { delete backupCache[k]; });
          }
          if (knownVariants.size > 48) knownVariants.clear();
          const vs = parseMaster(await res.clone().text());
          vs.forEach(function (v) { knownVariants.set(v.url.split('?')[0], v); });
          const fam = {};
          vs.forEach(function (v) { const c = codecOf(v) || '?'; fam[c] = (fam[c] || 0) + 1; });
          const summary = Object.keys(fam).map(function (k) { return k + ' x' + fam[k]; }).join(', ');
          if (summary !== lastMasterLog) { lastMasterLog = summary; log('player master offers: ' + summary + ' (asked for codecs: ' + (masterCodecs || 'default') + ')'); }
          if (!inBackoff()) getBackupVariants(PLAYER_TYPES[0]).catch(function () {}); // pre-warm (one type only, keeps startup light)
          return res;
        }
        if (!isMedia) return res;

        if (res.ok) lastMediaStatus = 0;
        else if (res.status !== lastMediaStatus) { lastMediaStatus = res.status; log('original media playlist returned HTTP ' + res.status); }
        const text = await res.clone().text();
        const adNow = hasAd(text);

        let triedBackup = false;
        if (always) {
          const b = await raceTimeout(always, MAX_WAIT);
          if (adNow && !adActive) { adActive = true; log(b ? 'ad in original stream, hidden (backup stream is playing)' : 'ad in original stream, no backup available'); }
          if (!adNow && adActive) { adActive = false; log('ad ended in original stream'); }
          if (b) {
            if (Object.keys(lastGood).length > 16) lastGood = {};
            lastGood[url] = b.text;
            failCount = 0;
            setMode('always-on: playing the "' + b.pt + '" stream');
            return synth(b.text, res);
          }
          failCount++;
          triedBackup = true;
          if (lastGood[url] && failCount <= 2) {        // brief hiccup: keep the player on the backup timeline
            setMode('backup stream unavailable, reusing last playlist');
            return synth(lastGood[url], res);
          }
          if (!adNow) {                                  // no ad running: nothing to hide, never stall the player
            setMode('backup stream unavailable, no ad running, passing the original playlist through');
            return res;
          }
          // an ad is running and there is no backup: fall through to the ad-only handling below
          // (the backup is retried automatically after a pause)
        }

        // Debounce: an ad only counts as over after 3 clean playlists in a row (the markers can flicker)
        if (adNow) cleanStreak = 0;
        const adEff = adNow || (adActive && ++cleanStreak < 3);

        if (!adEff) {
          cleanStreak = 0;
          if (adActive) {
            adActive = false;
            adSwaps = 0;
            seqOffset = null;
            setMode('ad ended');
            if (bc) bc.postMessage('ad-ended');
          }
          return res;
        }
        if (!adActive && bc) bc.postMessage('ad-started');
        adActive = true;

        const clean = (!channel || triedBackup) ? null
          : (adSwaps === 0 ? await raceTimeout(pickBestBackup(url), MAX_WAIT)
                           : await raceTimeout(speculative || getCleanPlaylist(url), MAX_WAIT));
        let body;
        if (clean) {
          if (seqOffset === null) seqOffset = computeSeqOffset(text, clean.text);
          body = shiftSeq(clean.text, seqOffset);
          setMode('ad detected, swapped to "' + clean.pt + '" playlist');
          adSwaps++;
          const total = Date.now() - tStart;
          if (adSwaps === 1 || total > 1500) {
            log('swap #' + adSwaps + ': original ' + origMs + 'ms, total ' + total + 'ms, media-seq original ' + seq(text) + ' vs backup ' + seq(clean.text) + ', shifted by ' + seqOffset);
          }
        } else {
          body = stripAds(text);
          if (!/#EXTINF/.test(body)) {   // nothing left: an empty playlist makes Twitch think the stream is offline
            body = text;
            setMode('ad detected, nothing left after stripping, passing the original playlist through');
          } else setMode('ad detected, no clean playlist, stripped ad segments');
        }

        return synth(body, res);
      } catch (e) { log('error', errMsg(e)); }
      return res;
    }

    self.fetch = function (input) {
      let url = '';
      try { url = typeof input === 'string' ? input : ((input && input.url) || String(input || '')); } catch (e) {}
      // everything that is not a playlist goes straight to the real fetch, untouched
      if (url.indexOf('.m3u8') === -1) return origFetch.apply(self, arguments);
      return handlePlaylist(input, url, arguments);
    };
  }

  // ---------- Main thread: hook the worker + recover the video after an ad ----------
  const MAIN_DEBUG = true;
  function mlog() { if (MAIN_DEBUG) console.log.apply(console, ['[adblock]'].concat([].slice.call(arguments))); }

  try {
    const OrigWorker = window.Worker;
    const WORKER_PREFIX = '(' + workerMain.toString() + ')();importScripts(';
    // A Proxy keeps Worker's prototype, statics and instanceof exactly as they were
    window.Worker = new Proxy(OrigWorker, {
      construct: function (target, args, newTarget) {
        if (!args[1] || args[1].type !== 'module') {       // module workers cannot use importScripts: leave them alone
          try {
            const abs = new URL(String(args[0]), window.location.href).href;   // relative URLs break inside a blob worker
            const blobUrl = URL.createObjectURL(new Blob([WORKER_PREFIX + JSON.stringify(abs) + ');'], { type: 'application/javascript' }));
            setTimeout(function () { try { URL.revokeObjectURL(blobUrl); } catch (e) {} }, 30000);   // do not leak blob URLs
            return Reflect.construct(target, [blobUrl].concat(args.slice(1)), newTarget);
          } catch (e) {
            mlog('worker hook failed, using the normal worker:', e && e.message ? e.message : e);
          }
        }
        return Reflect.construct(target, args, newTarget);
      }
    });
  } catch (e) {
    console.log('[adblock] could not install the worker hook:', e);
  }

  function pickVideo() {
    return document.querySelector('.video-player video, [data-a-target="video-player"] video') || document.querySelector('video');
  }

  let recoverTimer = 0;
  function recoverVideo() {
    if (recoverTimer) clearInterval(recoverTimer);        // never run two recoveries at once
    let tries = 0, jumps = 0;
    recoverTimer = setInterval(function () {
      tries++;
      try {
        const v = pickVideo();
        if (v && !v.paused && v.buffered.length && jumps < 3) {   // never touch a video the viewer paused
          const end = v.buffered.end(v.buffered.length - 1);
          if (end - v.currentTime > 3 || v.readyState < 3) {
            v.currentTime = Math.max(0, end - 1.5);
            jumps++;
            mlog('jumped to live edge');
          }
        }
      } catch (e) {}
      if (tries >= 8) { clearInterval(recoverTimer); recoverTimer = 0; }
    }, 1000);
  }

  let inAd = false;
  let lastWait = 0;
  let waitStart = 0;
  document.addEventListener('waiting', function (e) {
    try {
      if (!waitStart) waitStart = Date.now();
      if (Date.now() - lastWait < 3000) return;
      lastWait = Date.now();
      const v = e.target, b = v.buffered;
      const ahead = b && b.length ? (b.end(b.length - 1) - v.currentTime).toFixed(1) : '0';
      mlog('video waiting' + (inAd ? ' during ad' : '') + ', buffer ahead: ' + ahead + 's');
    } catch (err) {}
  }, true);
  document.addEventListener('playing', function () {
    if (!waitStart) return;
    const d = Date.now() - waitStart;
    waitStart = 0;
    if (d >= 500) mlog('stall lasted ' + d + 'ms');         // ignore harmless sub-second blips
  }, true);
  ['pause', 'emptied', 'ended'].forEach(function (ev) {      // a stall that never "ends" must not be reported later
    document.addEventListener(ev, function () { waitStart = 0; }, true);
  });

  try {
    if (typeof BroadcastChannel !== 'undefined') {
      new BroadcastChannel('twitch-adblock-ctl').onmessage = function (e) {
        if (e.data === 'ad-started') inAd = true;
        if (e.data === 'ad-ended') { inAd = false; recoverVideo(); }
      };
    }
  } catch (e) {}

  mlog('worker hook installed');
})();