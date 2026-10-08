# gsearch-renderer

Headless Chromium SERP renderer for [gsearch-api](https://github.com/prateeknishad305/gsearch-api).

Host this anywhere: **Vercel, Railway, Render, Docker, a VPS (tmux or systemd), a Windows RDP server (24/7), or your laptop**. Same HTTP API on every platform (`GET /api/search`, `POST /api/batch`, `GET /api/crawl`, `GET|POST|DELETE /api/proxies`, `GET /api/engines`, `GET /api/stats`, `GET /api/health`).

Chromium is auto-detected: `@sparticuz/chromium` on Vercel serverless, system Chrome/Chromium on Railway / Render / Docker / local.

## Why

gsearch-api scrapes search engines with plain HTTP. Some engines (Google, DuckDuckGo, Brave, Startpage, Qwant) return a JS-required gate, consent page, or challenge to datacenter/cloud IPs like Vercel's. This service renders those pages in a real headless Chromium, executes the JavaScript, and returns parsed results in the same shape gsearch-api expects.

## Endpoints

### `GET /api/search`

| Param     | Default  | Description |
|-----------|----------|-------------|
| `q`       | required | Search query |
| `engine`  | `google` | Single engine (back-compat) |
| `engines` | *(none)* | Comma list tried in order; first engine that returns results wins (e.g. `google,bing`). Takes precedence over `engine`. |
| `num`     | `10`     | Target unique results (max `100`). Google and Yahoo cap desktop SERPs at **~10 results per page** (`&num=100` is gone / ignored), so extra pages (`start=0,10,20,...`) are fetched until `num` unique URLs. Bing and others still take a higher per-page count. |
| `pages`   | auto     | SERP pages to merge (max `10`). Omit to fetch `ceil(num/10)` pages for Google/Yahoo (stops early once `num` unique URLs). Other engines: 1 page. |
| `start`   | `0`      | Pagination offset |
| `hl`      | `en`     | Interface language |
| `gl`      | `us`     | Country |
| `proxy`   | `""`     | Optional browser proxy (e.g. `http://user:pass@host:port`) |
| `nocache` | `0`      | Set to `1` to bypass the results cache |
| `debug`   | `0`      | Set to `1` to skip the lite path/cache and include `debug_html` |
| `token`   | *(none)* | API token when `API_TOKEN` is set on the deployment |

Engines: `google`, `bing`, `brave`, `mojeek`, `startpage`, `yahoo`, `duckduckgo`, `duckduckgo_lite`, `qwant`, `ecosia`, `swisscows`, `seznam`.

`engines=google,bing` tries in order (fallback). `mode=merge` runs them in parallel and unions unique URLs. `engines=*` / `engines=all` tries every engine. Lite HTTP is used first for engines that serve static SERP HTML (Google `gbv=2`, DDG, Bing, Brave, Yahoo, Mojeek, Ecosia, Startpage); Chromium is the fallback.

### `POST /search` (also `POST /api/serper`)

serper.dev drop-in. JSON `{ "q", "gl", "hl", "num", "page" }` returns `{ searchParameters, organic[{title,link,snippet,position}], credits }`. Google-only. Lite HTTP first; Chromium only when `SERPER_RENDER=1`. Auth: `X-API-KEY`, `Authorization: Bearer`, or `?token=` when `API_TOKEN` is set. Duplicate queries hit the in-memory TTL cache (`cached: true`). No Redis.

### `POST /api/batch`

Run several dorks in **one** HTTP call on the shared pooled browser. This amortises
container warm-up and avoids the per-request concurrency limits of serverless.

```json
{ "queries": ["inurl:index.php?id=", "inurl:product.php?cat="], "engines": "google,bing", "num": 20 }
```

Response: `{ success, batch_size, completed, duration_ms, pool, results: [{ query, success, engine, count, results }] }`.
`BATCH_MAX` (default `6`) caps queries per call; `BATCH_BUDGET_MS` (default `50000`)
stops early so the function returns before the timeout (remaining queries get
`code: "TIME_BUDGET"`).

### `GET /api/crawl` (also `POST`)

Bounded same-origin BFS crawler. Renders pages in Chromium, extracts title /
description / text / links. Private and local hosts are blocked. Caps: 20 pages,
depth 3, wall-clock `CRAWL_BUDGET_MS` (default `50000`).

| Param         | Default | Description |
|---------------|---------|-------------|
| `url`         | required | Start URL (`http`/`https` only) |
| `max_pages`   | `8`     | Pages to visit (max `20`) |
| `max_depth`   | `1`     | Link follow depth (max `3`) |
| `same_origin` | `1`     | Stay on the start hostname |
| `proxy`       | `""`    | Optional browser proxy |
| `token`       | *(none)*| API token when `API_TOKEN` is set |

```
curl "http://localhost:3000/api/crawl?url=https://example.com&max_pages=3&max_depth=1"
```

POST JSON is also accepted: `{ "url": "https://example.com", "max_pages": 3, "max_depth": 1 }`.

### `GET /api/health`

Cheap introspection for a load balancer / the operator: `pool` (`proxies_available`, shard config; fetcher URL is never returned),
`browser` (`browserConnected`, `freePages`, `busyPages`, reuse + active/queued contexts), `cache` stats, `engines`, `features`.

### `GET|POST|DELETE /api/proxies`

Use your own HTTP proxies instead of the live/env pool. Credentials in listed URLs are masked (`http://***@host:port`).

```
curl -X POST http://localhost:3000/api/proxies \
  -H 'Content-Type: application/json' \
  -d '{"proxies":["http://user:pass@host:port"]}'

curl http://localhost:3000/api/proxies
curl -X DELETE http://localhost:3000/api/proxies
```

`POST` replaces the personal list (max `USER_PROXY_MAX`, default `50`). `DELETE` clears it and falls back to `PROXY_POOL` / live checked proxies. Search, batch, and crawl pick from this pool.

### `GET /api/engines`

Lists engines, whether each has a lite HTTP path, and circuit-breaker state.

### `GET /api/stats`

Per-engine ok/fail counters, p50/p95 latency, circuit snapshot, pool, browser.

#### Rotation & scaling (env vars)

Instead of passing `proxy=` per request, set a pool on the deployment. Every request
picks a random member and, if that exit is blocked (e.g. a Google `/sorry`
interstitial), retries with another member before falling back to a direct request.

| Env var                  | Default | Description |
|--------------------------|---------|-------------|
| `PROXY_POOL`             | *(none)* | Newline **or** comma separated proxy URLs (`http://user:pass@host:port`). Lines starting with `#` are ignored. When unset, live proxies are fetched, checked, and used. |
| `PROXY_FETCH`            | `1`     | Fetch + check proxies from the hardcoded live list (`0` disables) |
| `PROXY_FETCH_URL`        | *(internal)* | Override live-list URL (never returned in API JSON) |
| `PROXY_LIVE_MIN`         | `8`     | Stop checking once this many proxies pass |
| `PROXY_CHECK_MAX`        | `30`    | Max candidates probed per refresh |
| `PROXY_ATTEMPTS`         | `2` (`1` with personal proxies) | Max pool members tried per page |
| `PROXY_FALLBACK_DIRECT`  | `1` (`0` with personal proxies) | Final direct (no proxy) attempt. Off when `/api/proxies` is set so a paid exit is not skipped. |
| `PROXY_WINDOW_MS`        | `28000` | Time budget per page (multiplied by `pages`) |
| `PROXY_SHARD_TOTAL`      | `1`     | Split the pool across N instances (host 10 APIs -> `10`) |
| `PROXY_SHARD_INDEX`      | `0`     | This instance's shard (`0..N-1`) — each gets a disjoint slice |

| Env var             | Default | Description |
|---------------------|---------|-------------|
| `BROWSER_REUSE`     | `1`     | Reuse a long-lived Chromium + page pool per process (big win on containers; a no-op on Vercel where browsers are reaped). `0` = one browser per request. |
| `BROWSER_IDLE_MS`   | `120000`| Close an idle pooled browser after this long |
| `MAX_CONTEXTS`      | `4`     | Max concurrent tabs per instance (bounds memory) |
| `BROWSER_WORKERS`   | `MAX_CONTEXTS` | Size of the reusable page pool |
| `MAX_RETRIES`       | *(unset)* | Extra proxy attempts after the first (`0` = one try) |
| `NAVIGATION_TIMEOUT`| *(unset)* | Alias for `GOOGLE_NAV_MS` (page.goto timeout) |
| `RESULT_TIMEOUT`    | *(unset)* | Alias for `GOOGLE_READY_MS` (wait-for-h3) |
| `REQUEST_TIMEOUT`   | *(unset)* | Alias for `PROXY_WINDOW_MS` (per-page budget) |
| `PROXY_SERVER`      | *(unset)* | Single proxy URL. Empty string disables the pool (direct). |
| `CACHE_TTL_MS`      | `300000`| In-memory results cache TTL (`0` disables). No Redis. |
| `CACHE_MAX`         | `500`   | Max cached queries |
| `SERPER_RENDER`     | `0`     | `POST /search` Chromium fallback. Default lite HTTP only. |
| `GOOGLE_JITTER_MS`  | `0`     | Random pre-nav delay for Google Chromium (0 = off) |
| `GOOGLE_NAV_MS`     | `12000` | Google Chromium navigation timeout |
| `GOOGLE_READY_MS`   | `8000`  | Google wait-for-h3 timeout |
| `LITE_FAST`         | `1`     | Plain-HTTP fast path (Google `gbv=2` plus DDG/Bing/etc). `0` disables |
| `BATCH_MAX`         | `6`     | Max queries per `POST /api/batch` |
| `BATCH_BUDGET_MS`   | `50000` | Batch wall-clock budget |
| `CRAWL_BUDGET_MS`   | `50000` | Crawl wall-clock budget |
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
  "duration_ms": 4210,
  "response_time_ms": 4580,
  "pages_fetched": 2,
  "pages_requested": 2
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
  "results": [],
  "duration_ms": 8120,
  "response_time_ms": 8340
}
```

## Deploy (any host)

This repo is not Vercel-only. Long-lived hosts run `node server.js` (`npm start`). Vercel keeps using `api/*.js` serverless functions.

| Host | How it starts | Config files |
|------|----------------|--------------|
| Local | `npm start` | `.env.example` |
| Linux VPS / SSH (tmux) | detached `tmux` session running `node server.js` | `scripts/tmux-host.sh` |
| Windows RDP (24/7) | Windows service (`nssm`) running `node server.js` | `.env`, NSSM / Task Scheduler |
| Docker / VPS | `docker compose up --build` | `Dockerfile`, `docker-compose.yml` |
| Railway | Docker build from `railway.toml` | `railway.toml`, `Dockerfile` |
| Render | Docker web service from `render.yaml` | `render.yaml`, `Dockerfile` |
| Vercel | serverless `api/*.js` | `vercel.json` |

Give containers at least **1 GB RAM**. Chromium will not stay healthy on tiny free plans. `GET /api/health` is public so platform probes work even when `API_TOKEN` is set. Railway and Render inject `PORT`; the process binds `HOST=0.0.0.0`.

Live proxies are fetched from `....`, checked, and used automatically. Set `API_TOKEN` on any public URL.

### 1. Local machine

Need Node 20+ and Chrome/Chromium.

```
# Install dependencies
npm install

# Optional env file
cp .env.example .env

# Start (listens on PORT, default 3000)
npm start
```

```
curl "http://localhost:3000/api/health"
curl "http://localhost:3000/api/search?q=hello+world&engine=google"
```

If Chrome/Chromium is installed it is used automatically. Otherwise the process falls back to `@sparticuz/chromium`. Force a path with `CHROMIUM_PATH=/usr/bin/chromium` and `CHROMIUM_SOURCE=system`.

Debian / Ubuntu:

```
sudo apt-get update
sudo apt-get install -y chromium
npm install
npm start
```

macOS / Windows: install Google Chrome, then `npm start`.

#### tmux (survives SSH logout)

On a Linux VPS or this box, keep the API alive after you disconnect:

```
# Debian / Ubuntu
sudo apt-get install -y tmux

# Detached session named gsearch (PORT 3000)
bash scripts/tmux-host.sh start

# Health / session
bash scripts/tmux-host.sh status

# Attach (Ctrl-b d to detach)
bash scripts/tmux-host.sh attach

# Stop
bash scripts/tmux-host.sh stop
```

`scripts/tmux-host.sh restart` reloads the process. Logs append to `logs/server.log`. Same HTTP API as `npm start`. For reboot-proof hosting use systemd or Docker instead of tmux.

Vercel CLI is optional (serverless emulator only):

```
npm run dev:vercel
```

### 2. Docker (local or any VPS)

```
docker build -t gsearch-renderer .
docker run --rm -p 3000:3000 gsearch-renderer
```

Or:

```
docker compose up --build
```

The image installs Chromium, runs as `node`, and health-checks `/api/health`. On a VPS, point a reverse proxy at port 3000 and set `API_TOKEN`.

### 3. Railway (`railway.toml`)

`railway.toml` is in the repo root. It tells Railway to build the **Dockerfile** (Chromium included), health-check `/api/health`, and restart on failure. Start command inside the image is `node server.js`. Railway sets `PORT` automatically.

Process:

1. Push this repo to GitHub.
2. [railway.app](https://railway.app) -> **New Project** -> **Deploy from GitHub repo** -> select this repo.
3. Railway reads `railway.toml`:
   - `builder = "DOCKERFILE"`
   - `dockerfilePath = "Dockerfile"`
   - `healthcheckPath = "/api/health"`
4. Variables (optional): `API_TOKEN`, `PROXY_POOL` (leave unset to use the live proxy fetcher).
5. Settings -> Networking -> **Generate domain**.
6. Confirm:

```
curl "https://<your-service>.up.railway.app/api/health"
```

Use that URL as `RENDERER_URL` in gsearch-api.

If you deploy **without** Docker (Nixpacks), `nixpacks.toml` installs Chromium via apt and still runs `node server.js`. Docker via `railway.toml` is the path that just works.

### 4. Render (`render.yaml`)

`render.yaml` defines a Docker web service named `gsearch-renderer` with health check `/api/health`.

Process:

1. Push this repo to GitHub.
2. [render.com](https://render.com) -> **New** -> **Web Service** -> this repo.
3. Runtime: **Docker** (uses `Dockerfile` / `render.yaml`).
4. Health check path: `/api/health`.
5. Environment: set `API_TOKEN`. Leave `PROXY_POOL` empty to use the live proxy fetcher.
6. Deploy, then:

```
curl "https://<your-service>.onrender.com/api/health"
```

Native Node on Render is possible (`npm install` + `node server.js`) but you must supply Chromium yourself. Docker is the reliable option.

### 5. Vercel (serverless)

1. Push this repo to GitHub.
2. Vercel dashboard -> **Add New Project** -> import this repo.
3. Settings -> Functions -> **Max Duration** `60` (or higher on a paid plan), **Memory** `1024`.
4. Deploy. That URL is your `RENDERER_URL`.

Vercel uses `api/*.js` + `@sparticuz/chromium`. `server.js` / `railway.toml` / Docker are not used there.

### 6. Windows RDP server (24/7)

Run this as a **Windows service**, not in an RDP desktop window. If you only start `npm start` in Command Prompt and then disconnect RDP, Windows can kill that session. A service keeps Node + Chromium alive after disconnect and after reboot.

Need: Windows Server 2016/2019/2022 or Windows 10/11, **2 GB RAM minimum** (4 GB better), public IP or LAN IP, Administrator access.

#### One command (PowerShell as Administrator)

This clones the repo, installs Node/Git/Chrome if missing, writes `.env`, opens firewall port 3000, and installs NSSM service `gsearch-renderer` (auto-start, restart on crash):

```
Set-ExecutionPolicy Bypass -Scope Process -Force
irm https://raw.githubusercontent.com/prateeknishad305/gsearch-renderer/main/scripts/windows-rdp-setup.ps1 | iex
```

Script prints `API_TOKEN=...` and `health ok=true`. Then RDP Sign out. Service keeps running. Steps below are the same process, manual.

#### Step 1. Connect over RDP

On your PC:

```
mstsc
```

Computer: `YOUR_SERVER_IP`. Log in as Administrator (or a user with admin rights).

#### Step 2. Stop sleep / hibernate (required for 24/7)

Open **Command Prompt as Administrator**:

```
powercfg /change standby-timeout-ac 0
powercfg /change standby-timeout-dc 0
powercfg /change hibernate-timeout-ac 0
powercfg /change hibernate-timeout-dc 0
powercfg /hibernate off
powercfg /SETACVALUEINDEX SCHEME_CURRENT SUB_SLEEP STANDBYIDLE 0
powercfg /SETACTIVE SCHEME_CURRENT
```

Settings -> System -> Power -> Screen and sleep -> **Sleep: Never** (plugged in).

#### Step 3. Install Node.js 22 LTS

1. Open https://nodejs.org/
2. Download **Windows Installer (.msi) 22 LTS x64**.
3. Run it. Keep **Add to PATH** checked.
4. Finish, then **close and reopen** Command Prompt.

```
node -v
npm -v
```

Both must print versions. If `node` is not recognized, reboot once and try again.

#### Step 4. Install Git

1. Open https://git-scm.com/download/win
2. Install with default options.
3. New Command Prompt:

```
git --version
```

#### Step 5. Install Google Chrome

1. Open https://www.google.com/chrome/
2. Install Chrome for all users (default path below).
3. Confirm the binary exists:

```
dir "C:\Program Files\Google\Chrome\Application\chrome.exe"
```

If Chrome is under `C:\Program Files (x86)\...`, use that path in `.env`.

#### Step 6. Clone the repo

```
cd C:\
mkdir apps
cd C:\apps
git clone https://github.com/prateeknishad305/gsearch-renderer.git
cd gsearch-renderer
```

#### Step 7. Install npm packages

```
npm install
```

#### Step 8. Create `.env`

```
copy .env.example .env
notepad .env
```

Set at least:

```
PORT=3000
HOST=0.0.0.0
NODE_ENV=production
CHROMIUM_SOURCE=system
CHROMIUM_PATH=C:\Program Files\Google\Chrome\Application\chrome.exe
BROWSER_REUSE=1
API_TOKEN=change-this-to-a-long-secret
PROXY_FETCH=1
```

Save and close. Pick a real `API_TOKEN`. Leave `PROXY_POOL` empty to use the live proxy fetcher.

#### Step 9. Test once in the foreground

```
npm start
```

You should see `listening on http://0.0.0.0:3000`. On the same machine:

```
curl "http://127.0.0.1:3000/api/health"
```

Or in a browser: `http://127.0.0.1:3000/api/health`. Stop the test with Ctrl+C before installing the service.

#### Step 10. Open Windows Firewall for port 3000

Command Prompt **as Administrator**:

```
netsh advfirewall firewall add rule name="gsearch-renderer" dir=in action=allow protocol=TCP localport=3000
```

If the hoster has a **cloud security group / panel firewall** (Contabo, Hetzner, AWS, Azure, Oracle, Hostinger, etc.), also allow inbound TCP **3000** there. Windows firewall alone is not enough on those boxes.

#### Step 11. Install NSSM (run 24/7 as a Windows service)

NSSM keeps `node server.js` running after RDP disconnect and after reboot.

1. Download NSSM: https://nssm.cc/download (win64 zip).
2. Extract, e.g. to `C:\apps\nssm`.
3. Command Prompt **as Administrator**:

```
cd C:\apps\nssm\win64
nssm install gsearch-renderer
```

In the NSSM window:

- **Application** tab:
  - Path: `C:\Program Files\nodejs\node.exe`
  - Startup directory: `C:\apps\gsearch-renderer`
  - Arguments: `server.js`
- **Details** tab:
  - Display name: `gsearch-renderer`
  - Startup type: **Automatic**
- **I/O** tab (optional logs):
  - Output: `C:\apps\gsearch-renderer\logs\stdout.log`
  - Error: `C:\apps\gsearch-renderer\logs\stderr.log`
- **Exit actions** tab:
  - Restart throttling: `5000` ms
- Click **Install service**.

Create the log folder first if you set I/O paths:

```
mkdir C:\apps\gsearch-renderer\logs
```

Headless (no GUI) install, same result:

```
nssm install gsearch-renderer "C:\Program Files\nodejs\node.exe" server.js
nssm set gsearch-renderer AppDirectory C:\apps\gsearch-renderer
nssm set gsearch-renderer AppStdout C:\apps\gsearch-renderer\logs\stdout.log
nssm set gsearch-renderer AppStderr C:\apps\gsearch-renderer\logs\stderr.log
nssm set gsearch-renderer AppRotateFiles 1
nssm set gsearch-renderer AppRotateBytes 10485760
nssm set gsearch-renderer Start SERVICE_AUTO_START
nssm set gsearch-renderer AppRestartDelay 5000
```

Start it:

```
nssm start gsearch-renderer
nssm status gsearch-renderer
```

Or:

```
sc start gsearch-renderer
sc query gsearch-renderer
```

`STATE` must be `RUNNING`.

#### Step 12. Confirm it survives RDP disconnect

```
curl "http://127.0.0.1:3000/api/health"
```

From your home PC (replace IP):

```
curl "http://YOUR_PUBLIC_IP:3000/api/health"
curl "http://YOUR_PUBLIC_IP:3000/api/search?q=hello+world&engine=google&token=change-this-to-a-long-secret"
```

Then **Sign out** of RDP (Start -> Sign out). Do not only click the window X if you still have a console `npm start` running. Wait one minute, curl again from home. Health must still return `ok: true`.

Reboot test:

```
shutdown /r /t 0
```

After the server is back, curl health again. The NSSM service is Automatic, so it must come back without login.

#### Step 13. Point gsearch-api at this box

```
RENDERER_URL=http://YOUR_PUBLIC_IP:3000
```

If you put HTTPS in front (IIS / Caddy / nginx on Windows), use that `https://` URL instead.

#### Alternative A: Task Scheduler (no NSSM)

1. `Win + R` -> `taskschd.msc`
2. Create Task (not Create Basic Task).
3. General:
   - Name: `gsearch-renderer`
   - Run whether user is logged on or not
   - Run with highest privileges
   - Hidden: checked
4. Triggers: **At startup**, delay 30 seconds.
5. Actions: Start a program
   - Program: `C:\Program Files\nodejs\node.exe`
   - Arguments: `server.js`
   - Start in: `C:\apps\gsearch-renderer`
6. Conditions: uncheck "Start only if on AC power", uncheck "Stop if computer switches to battery".
7. Settings: check "If the task fails, restart every 1 minute", max 99999 times. Uncheck "Stop the task if it runs longer than".
8. OK, enter the Windows password.
9. Right-click the task -> Run.

This also survives RDP disconnect if "Run whether user is logged on or not" is set.

#### Alternative B: PM2

```
npm install -g pm2
npm install -g pm2-windows-startup
cd C:\apps\gsearch-renderer
pm2 start server.js --name gsearch-renderer
pm2 save
pm2-startup install
```

`pm2-windows-startup` registers a logon/startup task. NSSM is still the more reliable 24/7 option on Windows Server.

#### Update the running service after git pull

```
cd C:\apps\gsearch-renderer
git pull
npm install
nssm restart gsearch-renderer
```

#### Useful NSSM commands

```
nssm status gsearch-renderer
nssm restart gsearch-renderer
nssm stop gsearch-renderer
nssm remove gsearch-renderer confirm
```

Logs: `C:\apps\gsearch-renderer\logs\stdout.log` and `stderr.log`.

### Horizontal scale (Railway / Render / VPS / Windows RDP)

For 10k+ dorks per run, prefer a long-lived container (`BROWSER_REUSE=1`, default) over serverless.

Host N instances with the same `PROXY_POOL` (or the live fetcher) but a distinct `PROXY_SHARD_INDEX` and shared `PROXY_SHARD_TOTAL=N`. Each instance gets a disjoint slice of exits. Put any HTTP load balancer in front and set `API_TOKEN` if the URLs are public.

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

Examples: `https://<service>.up.railway.app`, `https://<service>.onrender.com`, `http://YOUR_PUBLIC_IP:3000` (Windows RDP), `http://localhost:3000`.

When set, gsearch-api automatically retries any engine that fails its native
scrape (blocked / rate-limited / empty) through this renderer service.
