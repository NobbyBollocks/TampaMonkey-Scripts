// ==UserScript==
// @name         Twitch ad blocker (playlist swap)
// @match        https://www.twitch.tv/*
// @run-at       document-start
// @grant        none
// ==/UserScript==

(function () {
  'use strict';

  // ---------- Runs inside the player's Web Worker (serialized with toString) ----------
  function workerMain() {
    const DEBUG = true;
    // true  = always play the ad-free backup stream (no switching, so no stall when ads start or end)
    // false = only switch to the backup while an ad is running
    const ALWAYS_ON = true;
    const CLIENT_ID = 'kimne78kx3ncx6brgo4mv6wki5h1ko'; // Twitch web player's public client id
    const PLAYER_TYPES = ['embed', 'popout', 'autoplay', 'picture-by-picture'];
    const GQL_QUERY = 'query PlaybackAccessToken_Template($login: String!, $isLive: Boolean!, $vodID: ID!, $isVod: Boolean!, $playerType: String!) { streamPlaybackAccessToken(channelName: $login, params: {platform: "web", playerBackend: "mediaplayer", playerType: $playerType}) @include(if: $isLive) { value signature __typename } videoPlaybackAccessToken(id: $vodID, params: {platform: "web", playerBackend: "mediaplayer", playerType: $playerType}) @include(if: $isVod) { value signature __typename } }';

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
    let lastGood = {};              // media URL -> last good backup playlist text
    const seq = t => (t.match(/#EXT-X-MEDIA-SEQUENCE:(\d+)/) || [])[1];
    const knownVariants = new Map(); // media playlist URL -> {group,res,bw}
    const backupCache = {};          // playerType -> {t, variants}

    function log() { if (DEBUG) console.log.apply(console, ['[adblock]'].concat([].slice.call(arguments))); }
    function setMode(m) { if (m !== lastMode) { lastMode = m; log(m); } }

    function hasAd(text) {
      return text.includes('twitch-stitched-ad') || text.includes('twitch-maf-ad') ||
             text.includes('stitched-ad-') || text.includes('X-TV-TWITCH-AD-URL');
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
      return pool.find(function (v) { return info.group && v.group === info.group; }) ||
             pool.find(function (v) { return info.res && v.res === info.res; }) ||
             pool.slice().sort(function (a, b) { return b.bw - a.bw; })[0];
    }

    function variantInfo(u) { return knownVariants.get(u.split('?')[0]) || null; }

    async function fetchBackupVariants(pt) {
      const r = await origFetch('https://gql.twitch.tv/gql', {
        method: 'POST',
        headers: { 'Client-ID': CLIENT_ID, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          operationName: 'PlaybackAccessToken_Template',
          query: GQL_QUERY,
          variables: { isLive: true, login: channel, isVod: false, vodID: '', playerType: pt }
        })
      });
      const j = await r.json();
      const tk = j && j.data && j.data.streamPlaybackAccessToken;
      if (!tk) throw new Error('no access token');
      const params = new URLSearchParams({
        allow_source: 'true', allow_audio_only: 'true', player_backend: 'mediaplayer',
        playlist_include_framerate: 'true', supported_codecs: 'avc1',
        p: String(Math.floor(Math.random() * 1e7)), sig: tk.signature, token: tk.value
      });
      const m = await origFetch('https://usher.ttvnw.net/api/channel/hls/' + channel + '.m3u8?' + params);
      if (!m.ok) throw new Error('usher ' + m.status);
      const variants = parseMaster(await m.text());
      backupCache[pt] = { t: Date.now(), variants: variants };
      return variants;
    }

    async function getBackupVariants(pt) {
      const c = backupCache[pt];
      const age = c ? Date.now() - c.t : Infinity;
      if (c && age < 60000) return c.variants;
      if (c && age < 600000) {            // stale: use it now, refresh in the background
        if (!c.refreshing) {
          c.refreshing = true;
          fetchBackupVariants(pt).catch(function () { setTimeout(function () { c.refreshing = false; }, 15000); });
        }
        return c.variants;
      }
      return fetchBackupVariants(pt);
    }

    async function getCleanPlaylist(mediaUrl) {
      const info = variantInfo(mediaUrl) || {};
      const order = preferred ? [preferred].concat(PLAYER_TYPES.filter(p => p !== preferred)) : PLAYER_TYPES;
      for (const pt of order) {
        try {
          const v = pickVariant(await getBackupVariants(pt), info);
          if (!v) continue;
          const r = await origFetch(v.url);
          if (!r.ok) { delete backupCache[pt]; continue; }
          const t = await r.text();
          if (!hasAd(t)) { preferred = pt; return { text: t, pt: pt }; }
        } catch (e) {
          delete backupCache[pt];
          log('backup failed:', pt, e && e.message ? e.message : e);
        }
      }
      return null;
    }

    // First swap of an ad: try every player type in parallel and use the freshest ad-free one
    async function pickBestBackup(mediaUrl) {
      const info = variantInfo(mediaUrl) || {};
      const results = await Promise.all(PLAYER_TYPES.map(async function (pt) {
        try {
          const v = pickVariant(await getBackupVariants(pt), info);
          if (!v) return { pt: pt, failed: true };
          const r = await origFetch(v.url);
          if (!r.ok) { delete backupCache[pt]; return { pt: pt, failed: true }; }
          const t = await r.text();
          if (hasAd(t)) return { pt: pt, ad: true };
          return { pt: pt, text: t, seq: +seq(t) || 0 };
        } catch (e) {
          delete backupCache[pt];
          return { pt: pt, failed: true };
        }
      }));
      log('backup candidates: ' + results.map(function (r) {
        return r.pt + (r.failed ? ' failed' : r.ad ? ' has ads' : ' seq ' + r.seq);
      }).join(', '));
      const ok = results.filter(function (r) { return r.text; }).sort(function (a, b) { return b.seq - a.seq; });
      if (ok[0]) preferred = ok[0].pt;
      return ok[0] || null;
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

    async function getBackupPlaylist(mediaUrl) {
      return preferred ? getCleanPlaylist(mediaUrl) : pickBestBackup(mediaUrl);
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

    self.fetch = async function (input) {
      const url = typeof input === 'string' ? input : ((input && input.url) || '');
      const isMedia = url.includes('.m3u8') && !url.includes('usher.ttvnw.net') && /\/v1\/playlist\//.test(url);

      if (isMedia && alwaysOn && channel && knownVariants.size && !variantInfo(url) && !warnedUnknown) {
        warnedUnknown = true;
        log('media playlist not found in master variants, always-on skipped for it');
      }
      // Always-on mode: start the backup request in parallel with the original one
      const always = (alwaysOn && isMedia && channel && variantInfo(url))
        ? getBackupPlaylist(url).catch(function () { return null; }) : null;
      // Ad-only mode: while an ad is running, start the backup request in parallel with the original one
      const speculative = (!alwaysOn && isMedia && adActive && channel) ? getCleanPlaylist(url) : null;

      const tStart = Date.now();
      const res = await origFetch.apply(this, arguments);
      const origMs = Date.now() - tStart;
      try {
        if (!url.includes('.m3u8')) return res;

        if (url.includes('usher.ttvnw.net')) {          // master playlist
          const m = url.match(/\/hls\/([^\/?.]+)\.m3u8/i);
          if (m && m[1].toLowerCase() !== channel) {     // new channel: reset per-channel state
            channel = m[1].toLowerCase();
            alwaysOn = ALWAYS_ON; failCount = 0; warnedUnknown = false;
            lastGood = {}; adActive = false; adSwaps = 0; seqOffset = null; preferred = null;
            knownVariants.clear();
            Object.keys(backupCache).forEach(function (k) { delete backupCache[k]; });
          }
          parseMaster(await res.clone().text()).forEach(v => knownVariants.set(v.url.split('?')[0], v));
          if (channel) PLAYER_TYPES.forEach(function (pt) { getBackupVariants(pt).catch(function () {}); }); // pre-warm
          return res;
        }
        if (!isMedia) return res;

        const text = await res.clone().text();
        const adNow = hasAd(text);

        if (always) {
          const b = await always;
          if (adNow && !adActive) { adActive = true; log('ad in original stream, hidden (backup stream is playing)'); }
          if (!adNow && adActive) { adActive = false; log('ad ended in original stream'); }
          if (b) {
            lastGood[url] = b.text;
            failCount = 0;
            setMode('always-on: playing the "' + b.pt + '" stream');
            return new Response(b.text, { status: 200, statusText: 'OK', headers: res.headers });
          }
          failCount++;
          if (lastGood[url] && failCount <= 5) {        // brief outage: keep the player on the backup timeline
            setMode('backup stream unavailable, reusing last playlist');
            return new Response(lastGood[url], { status: 200, statusText: 'OK', headers: res.headers });
          }
          alwaysOn = false;
          setMode('always-on disabled for this channel (backup unavailable), using ad-only mode');
          // fall through to ad-only handling
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

        const clean = !channel ? null : (adSwaps === 0 ? await pickBestBackup(url) : await (speculative || getCleanPlaylist(url)));
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
        }
        else       { body = stripAds(text); setMode('ad detected, no clean playlist, stripped ad segments'); }

        return new Response(body, { status: 200, statusText: 'OK', headers: res.headers });
      } catch (e) { log('error', e && e.message ? e.message : e); }
      return res;
    };
  }

  // ---------- Main thread: hook the worker + recover the video after an ad ----------
  const OrigWorker = window.Worker;
  window.Worker = class extends OrigWorker {
    constructor(url, opts) {
      const code = '(' + workerMain.toString() + ')();importScripts(' + JSON.stringify(String(url)) + ');';
      super(URL.createObjectURL(new Blob([code], { type: 'application/javascript' })), opts);
    }
  };

  function recoverVideo() {
    const v = document.querySelector('video');
    if (!v) return;
    let tries = 0;
    const timer = setInterval(function () {
      tries++;
      const b = v.buffered;
      if (b.length) {
        const end = b.end(b.length - 1);
        const lagging = end - v.currentTime > 3;
        const stalled = v.readyState < 3 && !v.paused;
        if (lagging || stalled) {
          v.currentTime = Math.max(0, end - 1.5);
          console.log('[adblock] jumped to live edge');
        }
      }
      if (tries >= 8) clearInterval(timer);
    }, 1000);
  }

  let inAd = false;
  let adEndedAt = 0;
  let lastWait = 0;
  let waitStart = 0;
  function relevant() { return true; }
  document.addEventListener('waiting', function (e) {
    if (!relevant()) return;
    if (!waitStart) waitStart = Date.now();
    if (Date.now() - lastWait < 3000) return;
    lastWait = Date.now();
    const v = e.target, b = v.buffered;
    const ahead = b.length ? (b.end(b.length - 1) - v.currentTime).toFixed(1) : '0';
    console.log('[adblock] video waiting' + (inAd ? ' during ad' : '') + ', buffer ahead: ' + ahead + 's');
  }, true);
  document.addEventListener('playing', function () {
    if (waitStart) {
      console.log('[adblock] stall lasted ' + (Date.now() - waitStart) + 'ms');
      waitStart = 0;
    }
  }, true);

  if (typeof BroadcastChannel !== 'undefined') {
    new BroadcastChannel('twitch-adblock-ctl').onmessage = function (e) {
      if (e.data === 'ad-started') inAd = true;
      if (e.data === 'ad-ended') { inAd = false; adEndedAt = Date.now(); recoverVideo(); }
    };
  }

  console.log('[adblock] worker hook installed');
})();