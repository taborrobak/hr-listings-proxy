// OpenSea Listings Cache Proxy
// Fetches listings once per minute, serves cached data to all visitors.
// Deploy to Railway, Render, or Fly.io — visitors never hit OpenSea directly.

const http = require('http');
const https = require('https');

// --- Config ---
const PORT = process.env.PORT || 3001;
const OPENSEA_API_KEY = process.env.OPENSEA_API_KEY || '7a6658d641d24c2587dd5562afe2d193';
const COLLECTION_SLUG = process.env.COLLECTION_SLUG || 'humanresources';
const POLL_INTERVAL = parseInt(process.env.POLL_INTERVAL || '60000', 10); // 60s default
const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS || '*').split(',').map(s => s.trim());

// --- State ---
let cachedListings = [];
let lastFetch = null;
let lastError = null;
let fetchInProgress = false;

// --- OpenSea fetch with pagination ---
function httpsGet(url, headers) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { headers }, res => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => resolve({ status: res.statusCode, body: data }));
    });
    req.on('error', reject);
    req.setTimeout(30000, () => { req.destroy(); reject(new Error('Timeout')); });
  });
}

async function fetchAllListings() {
  if (fetchInProgress) return;
  fetchInProgress = true;
  const start = Date.now();
  try {
    const listings = [];
    let next = null;
    let pages = 0;
    do {
      const params = new URLSearchParams({ limit: '50' });
      // Small delay between pages to avoid rate limiting
      if (pages > 0) await new Promise(r => setTimeout(r, 2000));
      if (next) params.set('next', next);
      const url = `https://api.opensea.io/api/v2/listings/collection/${COLLECTION_SLUG}/all?${params}`;

      let res;
      // Retry on 429 with backoff
      for (let attempt = 0; attempt < 6; attempt++) {
        res = await httpsGet(url, {
          'x-api-key': OPENSEA_API_KEY,
          'Accept': 'application/json',
          'User-Agent': 'hr-listings-proxy/1.0',
        });
        if (res.status === 429) {
          const wait = (attempt + 1) * 10000;
          console.warn(`429 rate-limited, waiting ${wait}ms (attempt ${attempt + 1}/6)`);
          await new Promise(r => setTimeout(r, wait));
          continue;
        }
        break;
      }

      if (res.status !== 200) {
        throw new Error(`OpenSea returned ${res.status}: ${res.body.substring(0, 200)}`);
      }

      const data = JSON.parse(res.body);
      for (const listing of (data.listings || [])) {
        const protocol = listing.protocol_data;
        if (!protocol) continue;
        const offer = protocol.parameters?.offer?.[0];
        if (!offer) continue;
        const tokenId = parseInt(offer.identifierOrCriteria, 10);
        if (isNaN(tokenId)) continue;

        // Parse price from consideration
        const consideration = protocol.parameters?.consideration;
        let totalWei = BigInt(0);
        if (consideration) {
          for (const c of consideration) totalWei += BigInt(c.startAmount || '0');
        }
        const priceEth = Number(totalWei) / 1e18;

        listings.push({
          tokenId,
          price: priceEth,
          currency: 'ETH',
          orderHash: listing.order_hash || '',
          startTime: protocol.parameters?.startTime || null,
          endTime: protocol.parameters?.endTime || null,
        });
      }
      next = data.next || null;
      pages++;
    } while (next);

    // De-duplicate: keep cheapest per tokenId
    const best = new Map();
    for (const l of listings) {
      const existing = best.get(l.tokenId);
      if (!existing || l.price < existing.price) best.set(l.tokenId, l);
    }

    cachedListings = [...best.values()];
    lastFetch = new Date().toISOString();
    lastError = null;
    console.log(`Fetched ${cachedListings.length} listings (${pages} pages) in ${Date.now() - start}ms`);
  } catch (err) {
    lastError = err.message;
    console.error('Fetch failed:', err.message);
    // Keep stale data — better than nothing
  } finally {
    fetchInProgress = false;
  }
}

// --- HTTP Server ---
const server = http.createServer((req, res) => {
  // CORS
  const origin = req.headers.origin || '*';
  const allowOrigin = ALLOWED_ORIGINS.includes('*') ? '*' :
    ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0];
  res.setHeader('Access-Control-Allow-Origin', allowOrigin);
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  const url = new URL(req.url, `http://${req.headers.host}`);

  if (url.pathname === '/listings' && req.method === 'GET') {
    const payload = JSON.stringify({
      listings: cachedListings,
      count: cachedListings.length,
      lastFetch,
      lastError,
      stale: lastError ? true : false,
    });
    res.writeHead(200, {
      'Content-Type': 'application/json',
      'Cache-Control': 'public, max-age=30',
    });
    res.end(payload);
    return;
  }

  if (url.pathname === '/health' && req.method === 'GET') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      ok: true,
      listings: cachedListings.length,
      lastFetch,
      lastError,
      fetchInProgress,
      uptime: process.uptime(),
    }));
    return;
  }

  res.writeHead(404, { 'Content-Type': 'text/plain' });
  res.end('Not found');
});

server.listen(PORT, () => {
  console.log(`Listings proxy running on :${PORT}`);
  console.log(`Collection: ${COLLECTION_SLUG}`);
  console.log(`Poll interval: ${POLL_INTERVAL}ms`);
  // Delay first fetch slightly to let server stabilize
  setTimeout(() => {
    fetchAllListings();
    setInterval(fetchAllListings, POLL_INTERVAL);
  }, 5000);
});
