// A cache in front of the stats API, shared by the app and the four boards.
//
// Two kinds of thing go in it. Most answers are perishable — a season line, a
// standings table — and get fifteen minutes, enough that walking from Rotation
// to Bullpen to a Matchup does not refetch what the board before it just read.
// A few are not perishable at all: the boxscore of a game that has finished
// will never change again, and asking for it a second time is pure waste. Those
// go in with ttl: Infinity and stay until the browser reclaims the space.
//
// The Cache API rather than localStorage: it stores real responses, it is async
// so a megabyte of JSON never lands on the main thread, and it has room for
// payloads that would blow through localStorage's five-megabyte budget.
//
// Everything here degrades to a plain fetch. A browser without caches, a
// private window that refuses to open one, a full disk — the reader still gets
// his board, just without the head start.
(function () {
  const DEFAULT_TTL = 15 * 60 * 1000;
  const STORE = 'baseball-lens-api-v1';
  const STAMP = 'x-bl-cached-at';   // the Cache API keeps no metadata of its own
  const LIFE = 'x-bl-ttl';          // ...including how long this one should live

  const available = typeof caches !== 'undefined' && caches && typeof caches.open === 'function';
  let opening = null;
  const store = () => (opening = opening || caches.open(STORE));

  const age = res => Date.now() - (Number(res.headers.get(STAMP)) || 0);
  const life = res => {
    const raw = res.headers.get(LIFE);
    return raw === 'inf' ? Infinity : (Number(raw) || DEFAULT_TTL);
  };

  // A hung request must not strand the caller — the old fetchWithTimeout habit,
  // kept here so routing a call through the cache never costs it its escape.
  function fetchJSON(url, timeout) {
    if (!timeout) return fetch(url).then(readJSON);
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), timeout);
    return fetch(url, { signal: ctl.signal }).then(readJSON).finally(() => clearTimeout(timer));
  }
  function readJSON(r) {
    if (!r.ok) throw new Error(r.status);
    return r.text();
  }

  // Drop what has gone stale, once per page. Without this the store only ever
  // grows: yesterday's rosters are dead weight nobody will ask for again.
  // Boxscores are exempt by their own ttl — that is the point of them.
  async function sweep() {
    try {
      const c = await store();
      const keys = await c.keys();
      await Promise.all(keys.map(async req => {
        const hit = await c.match(req);
        if (!hit || age(hit) >= life(hit)) await c.delete(req);
      }));
    } catch (e) { /* a cache we cannot tidy is still a cache we can read */ }
  }

  window.cachedJSON = async function (url, opts) {
    const ttl = (opts && opts.ttl != null) ? opts.ttl : DEFAULT_TTL;
    const timeout = (opts && opts.timeout) || 0;

    if (!available) return fetchJSON(url, timeout).then(JSON.parse);

    let c;
    try { c = await store(); } catch (e) { return fetchJSON(url, timeout).then(JSON.parse); }

    try {
      const hit = await c.match(url);
      if (hit && age(hit) < life(hit)) return hit.json();
    } catch (e) { /* fall through and ask the network */ }

    const body = await fetchJSON(url, timeout);
    try {
      await c.put(url, new Response(body, {
        headers: {
          'content-type': 'application/json',
          [STAMP]: String(Date.now()),
          [LIFE]: ttl === Infinity ? 'inf' : String(ttl),
        },
      }));
    } catch (e) { /* out of quota — the answer is already in hand */ }
    return JSON.parse(body);
  };

  if (available) sweep();
})();
