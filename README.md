# gsearch-renderer

Headless Chromium SERP renderer for [gsearch-api](https://github.com/prateeknishad305/gsearch-api). Runs on Vercel serverless, Railway, Render, Docker, and local machines. Chromium is auto-detected: `@sparticuz/chromium` on Vercel, system Chrome/Chromium everywhere else.

## Why

gsearch-api scrapes search engines with plain HTTP. Some engines (Google, DuckDuckGo, Brave, Startpage, Qwant) return a JS-required gate, consent page, or challenge to datacenter/cloud IPs like Vercel's. This service renders those pages in a real headless Chromium, executes the JavaScript, and returns parsed results in the same shape gsearch-api expects.

## Endpoints

### `GET /api/search`

| Param     | Default  | Description |
|-----------|----------|-------------|
| `q`       | required | Search query |
| `engine`  | `google` | Single engine (back-compat) |
| `engines` | *(none)* | Comma list tried in order; first engine that returns results wins (e.g. `google,bing`). Takes precedence over `engine`. |
| `num`     | `20`     | Target results per page (max `100`) |
| `pages`   | `1`      | Fetch and merge up to `5` result pages per query (more URLs per dork) |
| `start`   | `0`      | Pagination offset |
| `hl`      | `en`     | Interface language |
| `gl`      | `us`     | Country |
| `proxy`   | `""`     | Optional browser proxy (e.g. `http://user:pass@host:port`) |
| `nocache` | `0`      | Set to `1` to bypass the results cache |
| `debug`   | `0`      | Set to `1` to skip the lite path/cache and include `debug_html` |
| `token`   | *(none)* | API token when `API_TOKEN` is set on the deployment |

Engines: `google`, `bing`, `brave`, `mojeek`, `startpage`, `yahoo`, `duckduckgo`, `duckduckgo_lite`, `qwant`.

### `POST /api/batch`

Run several dorks in **one** HTTP call on the shared pooled browser. This amortises
container warm-up and avoids the per-request concurrency limits of serverless.

```json
{ "queries": ["inurl:index.php?id=", "inurl:product.php?cat="], "engines": "google,bing", "num": 20, "pages": 1 }
```

Response: `{ success, batch_size, completed, duration_ms, pool, results: [{ query, success, engine, count, results }] }`.
`BATCH_MAX` (default `6`) caps queries per call; `BATCH_BUDGET_MS` (default `50000`)
stops early so the function returns before the timeout (remaining queries get
`code: "TIME_BUDGET"`).

### `GET /api/health`

Cheap introspection for a load balancer / the operator: `pool` (shard config),
`browser` (reuse + active/queued contexts), `cache` stats, `engines`, `features`.

#### Rotation & scaling (env vars)

Instead of passing `proxy=` per request, set a pool on the deployment. Every request
picks a random member and, if that exit is blocked (e.g. a Google `/sorry`
interstitial), retries with another member before falling back to a direct request.

| Env var                  | Default | Description |
|--------------------------|---------|-------------|
| `PROXY_POOL`             | *(none)* | Newline **or** comma separated proxy URLs (`http://user:pass@host:port`). Lines starting with `#` are ignored. |
| `PROXY_ATTEMPTS`         | `2`     | Max pool members tried per page |
| `PROXY_FALLBACK_DIRECT`  | `1`     | Set to `0` to disable the final direct (no proxy) attempt |
| `PROXY_WINDOW_MS`        | `28000` | Time budget per page (multiplied by `pages`) |
| `PROXY_SHARD_TOTAL`      | `1`     | Split the pool across N instances (host 10 APIs -> `10`) |
| `PROXY_SHARD_INDEX`      | `0`     | This instance's shard (`0..N-1`) — each gets a disjoint slice |

| Env var             | Default | Description |
|---------------------|---------|-------------|
| `BROWSER_REUSE`     | `1`     | Reuse a long-lived Chromium per process (big win on containers; a no-op on Vercel where browsers are reaped). `0` = one browser per request. |
| `BROWSER_IDLE_MS`   | `120000`| Close an idle pooled browser after this long |
| `MAX_CONTEXTS`      | `4`     | Max concurrent tabs per instance (bounds memory) |
| `CACHE_TTL_MS`      | `300000`| Results cache TTL (`0` disables) |
| `CACHE_MAX`         | `500`   | Max cached queries |
| `LITE_FAST`         | `1`     | Plain-HTTP fast path for DuckDuckGo engines (`0` disables) |
| `BATCH_MAX`         | `6`     | Max queries per `POST /api/batch` |
| `BATCH_BUDGET_MS`   | `50000` | Batch wall-clock budget |
| `API_TOKEN`         | *(none)*| When set, require `Authorization: Bearer <token>` or `?token=` |

Note: proxied requests force Chromium to HTTP/1.1 (`--disable-http2`). Several HTTP
proxy providers (PureVPN/pointtoserver, PVData, squid proxies, ...) silently stall
Chromium's HTTP/2 connections to Google while HTTP/1.1 works fine.

Success:

```json
{
  "engine": "google",
  "query": "hello world",
  "success": true,
  "count": 20,
  "results": [{ "url": "https://en.wikipedia.org/wiki/Hello,_world", "title": "Hello, world", "snippet": "..." }],
  "duration_ms": 4210
}
```

Failure (upstream block / no results — always HTTP 200, never a 502):

```json
{
  "engine": "google",
  "query": "hello world",
  "success": false,
  "code": "BLOCKED",
  "error": "Engine \"google\" blocked the browser render: Google is showing its \"unusual traffic\" interstitial for this IP.",
  "count": 0,
  "results": []
}
```

## Deploy

Same HTTP API on every host. Set `PORT` (Railway/Render inject this) and start with `node server.js`. `GET /api/health` is public so platform health checks work even when `API_TOKEN` is set. Give the container at least 1 GB RAM; Chromium will not stay healthy on tiny free plans.

### Local machine

Install Node 20+ and Chrome or Chromium, then:

```
# Install dependencies
npm install

# Start the long-lived HTTP server (default PORT=3000)
npm start

# Optional: copy env template
cp .env.example .env
```

```
curl "http://localhost:3000/api/health"
curl "http://localhost:3000/api/search?q=hello+world&engine=google"
```

If Chrome/Chromium is installed, it is used automatically. Otherwise the process falls back to `@sparticuz/chromium`. Force a path with `CHROMIUM_PATH=/usr/bin/chromium` and `CHROMIUM_SOURCE=system`.

Debian/Ubuntu:

```
# Install Chromium and Node
sudo apt-get update
sudo apt-get install -y chromium
npm install
npm start
```

macOS: install Google Chrome, then `npm start`.

Windows: install Google Chrome, then `npm start`.

Docker locally:

```
docker build -t gsearch-renderer .
docker run --rm -p 3000:3000 gsearch-renderer
```

Or `docker compose up --build`.

Vercel CLI is optional and only needed if you want the serverless emulator:

```
npm run dev:vercel
```

### Vercel (serverless)

1. Push this repo to GitHub.
2. In the Vercel dashboard: **Add New Project** -> import this repo.
3. Settings -> Functions -> set **Max Duration** to `60` (or higher if you have a paid plan) and **Memory** to `1024`.
4. Deploy. The URL becomes your `RENDERER_URL`.

Vercel keeps using `api/*.js` serverless functions and `@sparticuz/chromium`. `server.js` is not used there.

### Railway

1. New Project -> Deploy from GitHub repo.
2. Railway detects `Dockerfile` / `railway.toml` and builds the image (system Chromium included).
3. Set env vars in the service: `API_TOKEN`, optional `PROXY_POOL`.
4. Generate a public domain. Health check is `GET /api/health`.

Start command is `node server.js`. Railway sets `PORT` automatically.

If you deploy without Docker, `nixpacks.toml` installs Chromium via apt and still runs `node server.js`.

### Render

1. New -> Web Service -> this repo.
2. Runtime: **Docker** (uses `Dockerfile` / `render.yaml`).
3. Health check path: `/api/health`.
4. Set `API_TOKEN` (and optional `PROXY_POOL`) in Environment.

You can also use a native Node service: build `npm install`, start `node server.js`, and add a native Chromium buildpack or use the Docker path above. Docker is the reliable option because Chromium is baked into the image.

### Hosted containers (recommended for volume)

For 10k+ dorks per run, run the renderer as a long-lived container (Railway, Render, Fly.io, a VPS) instead of serverless: `BROWSER_REUSE=1` (default) reuses pooled Chromium across requests and removes the per-query launch cost.

Scaling horizontally: host N instances, give each the **same** `PROXY_POOL` but a
distinct `PROXY_SHARD_INDEX` and the shared `PROXY_SHARD_TOTAL=N`. Each instance
then uses a disjoint slice of the pool so two instances never hit Google from the
same exit IP, and a client round-robins across the instance URLs. Put any HTTP
load balancer (or the client itself) in front and set `API_TOKEN` if the instances
are reachable from the public internet.

## Chromium selection

| Env | Default | Description |
|-----|---------|-------------|
| `CHROMIUM_SOURCE` | `auto` | `auto` (Vercel -> sparticuz, else system if found), `system`, or `sparticuz` |
| `CHROMIUM_PATH` | *(detected)* | Explicit Chrome/Chromium binary path |
| `CHROMIUM_ARGS` | *(none)* | Extra Chromium flags, space-separated |
| `PORT` | `3000` | HTTP port (`HOST` default `0.0.0.0`) |
| `HOST` | `0.0.0.0` | Bind address for `server.js` |

`GET /api/health` includes `runtime.platform` and `runtime.chromium_source` so you can confirm which binary an instance is using.

## Use from gsearch-api

Set the env var on the gsearch-api project to whatever host you deployed:

```
RENDERER_URL=https://gsearch-renderer.vercel.app
```

Examples: `https://<service>.up.railway.app`, `https://<service>.onrender.com`, `http://localhost:3000`.

When set, gsearch-api automatically retries any engine that fails its native
scrape (blocked / rate-limited / empty) through this renderer service.
