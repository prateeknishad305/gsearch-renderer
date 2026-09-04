# gsearch-renderer

Headless Chromium SERP renderer for [gsearch-api](https://github.com/prateeknishad305/gsearch-api). Runs on Vercel serverless functions using `playwright-core` + `@sparticuz/chromium`.

## Why

gsearch-api scrapes search engines with plain HTTP. Some engines (Google, DuckDuckGo, Brave, Startpage, Qwant) return a JS-required gate, consent page, or challenge to datacenter/cloud IPs like Vercel's. This service renders those pages in a real headless Chromium, executes the JavaScript, and returns parsed results in the same shape gsearch-api expects.

## Endpoint

### `GET /api/search`

| Param    | Default  | Description |
|----------|----------|-------------|
| `q`      | required | Search query |
| `engine` | `google` | One of: `google`, `bing`, `brave`, `mojeek`, `startpage`, `yahoo`, `duckduckgo`, `duckduckgo_lite`, `qwant` |
| `num`    | `20`     | Target results (max `100`) |
| `start`  | `0`      | Pagination offset |
| `hl`     | `en`     | Interface language |
| `gl`     | `us`     | Country |
| `proxy`  | `""`     | Optional browser proxy (e.g. `http://user:pass@host:port`) |

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

1. Push this repo to GitHub.
2. In the Vercel dashboard: **Add New Project** -> import this repo.
3. Settings -> Functions -> set **Max Duration** to `60` (or higher if you have a paid plan) and **Memory** to `1024`.
4. Deploy. The URL becomes your `RENDERER_URL`.

## Use from gsearch-api

Set the env var on the gsearch-api Vercel project:

```
RENDERER_URL=https://gsearch-renderer.vercel.app
```

When set, gsearch-api automatically retries any engine that fails its native
scrape (blocked / rate-limited / empty) through this renderer service.

## Local dev

```
npm install
vercel dev
curl "http://localhost:3000/api/search?q=hello+world&engine=google"
```

Note: `@sparticuz/chromium` downloads its binary on first run; ensure your
local system has the Chromium shared libraries (`libnss3`, etc.).
