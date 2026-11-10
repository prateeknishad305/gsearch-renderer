'use strict';

function list() {
  return {
    captcha_block: true,
    captcha_solver: false,
    captcha_surface: false,
    captcha_rotate: true,
    ua_page_mask: true,
    turnstile_block: true,
    turnstile_solver: false,
    proxy_chain: true,
    intent_route: String(process.env.INTENT_ROUTING || '0') === '1',
    llm_parse: String(process.env.LLM_PARSE || '0') === '1',
    cluster_sync: true,
    canvas_mutate: false,
    selector_heal: true,
    media_block: true,
    geo_inject: true,
    work_queue: true,
    maps_shopping: true,
    sandbox: true,
    dashboard: true,
    tenant_keys: !!(process.env.API_KEYS || process.env.API_TOKEN),
    ndjson_stream: true,
    redis_cache: !!process.env.REDIS_URL,
    fd_tune: true,
    regression: true,
    mouse_bezier: false,
  };
}

module.exports = { list };
