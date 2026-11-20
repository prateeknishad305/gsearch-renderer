# Progress

## 2026-11-20 - Google dorks return real results

- `site:` and `filetype:` are now sent as Google advanced parameters
  (`as_sitesearch` / `as_filetype`) and stripped from `q`, so Google no longer
  ignores the operator on automated traffic.
- `google_lite` runs under a deadline (9s for dork queries, engine deadline
  otherwise) so a soft-blocked Google attempt cannot starve DDG/Bing.
- Dropped the redundant `chrome` fallback: `google_lite` already renders with
  Chromium internally.
- Fallback budget reserve lowered from 8s to 4s per remaining engine.
- Dork failure messages now name the operators actually used.

Verified locally:

- `site:openai.com` 2.1s / 5 results
- `site:github.com rust` 1.8s / 5 results
- `filetype:pdf rust language` 2.2s / 1 PDF
- `intitle:"rust book" site:doc.rust-lang.org` 1.7s (warm) / 5 results
- plain `openai` 5.0s / 3 results
- `npm test` 192/192 pass

Touched endpoints: `GET /api/search` (`engine=google_lite`, `engine=google`).

Touched modules: `api/lib/dork.js`, `api/lib/googleLite.js`, `api/lib/google.js`,
`api/search.js`.
