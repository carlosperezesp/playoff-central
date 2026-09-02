// A short-lived cache in front of the stats API, shared by the four standalone
// boards. They ask for many of the same things — the season pitching line, the
// thirty 40-man rosters, the standings — so walking from Rotation to Bullpen to
// a Matchup used to refetch what the board before it had just read, and coming
// back to a board a minute later paid for the whole thing again.
//
// The Cache API rather than localStorage: it stores real responses, it is
// async so a megabyte of JSON never lands on the main thread, and it has room
// for payloads that would blow through localStorage's five-megabyte budget.
//
// Everything here degrades to a plain fetch. A browser without caches, a
// private window that refuses to open one, a full disk — the reader still gets
// his board, just without the head start.
(function () {
  const TTL_MS = 15 * 60 * 1000;   // these are season totals and 30-day windows
  const STORE = 'baseball-lens-api-v1';
  const STAMP = 'x-bl-cached-at';  // Cache API keeps no metadata of its own

  const plain = url => fetch(url).then(r => {
    if (!r.ok) throw new Error(r.status);
    return r.json();
  });

  const available = typeof caches !== 'undefined' && caches && typeof caches.open === 'function';
  let opening = null;
  const store = () => (opening = opening || caches.open(STORE));

  const freshness = res => Date.now() - (Number(res.headers.get(STAMP)) || 0);

  // Drop what has gone stale, once per page. Without this the store only ever
  // grows: yesterday's rosters are dead weight nobody will ask for again.
  async function sweep() {
    try {
      const c = await store();
      const keys = await c.keys();
      await Promise.all(keys.map(async req => {
        const hit = await c.match(req);
        if (!hit || freshness(hit) >= TTL_MS) await c.delete(req);
      }));
    } catch (e) { /* a cache we cannot tidy is still a cache we can read */ }
  }

  window.cachedJSON = async function (url) {
    if (!available) return plain(url);

    let c;
    try { c = await store(); } catch (e) { return plain(url); }

    try {
      const hit = await c.match(url);
      if (hit && freshness(hit) < TTL_MS) return hit.json();
    } catch (e) { /* fall through and ask the network */ }

    const res = await fetch(url);
    if (!res.ok) throw new Error(res.status);
    const body = await res.text();
    try {
      await c.put(url, new Response(body, {
        headers: { 'content-type': 'application/json', [STAMP]: String(Date.now()) },
      }));
    } catch (e) { /* out of quota — the answer is already in hand */ }
    return JSON.parse(body);
  };

  if (available) sweep();
})();
