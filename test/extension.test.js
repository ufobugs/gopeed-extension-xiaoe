import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import * as core from '../src/core.js';

const entry = readFileSync(new URL('../src/index.js', import.meta.url), 'utf8').replace(/^import .*;\r?\n/, '');
const url = 'https://appdemo.pc.xiaoe-tech.com/p/t_pc/course_pc_detail/column/p_demo';

function setup({
  fail = false,
  failAll = false,
  parts = 2,
  delayed = false,
  hls = false,
  version = '2.0.0-beta.4',
  script = entry,
} = {}) {
  const metrics = { active: 0, peak: 0 };
  const handlers = {},
    calls = [],
    warnings = [];
  const gopeed = {
    info: { identity: 'ufobugs@xiaoe' },
    host: { env: { version } },
    settings: {
      apiHost: 'appdemo.pc.xiaoe-tech.com',
      cookie: 'ko_token=fixture-only',
    },
    logger: { warn: (value) => warnings.push(value), debug() {} },
    events: {
      onResolve: (fn) => (handlers.resolve = fn),
      onStart: (fn) => (handlers.start = fn),
      onError: (fn) => (handlers.error = fn),
    },
  };
  const fetcher = async (address, options) => {
    calls.push({ address, options });
    if (address.endsWith('.m3u8'))
      return {
        ok: true,
        text: async () => '#EXTM3U\n#EXTINF:4,\nsegment.ts\n#EXT-X-ENDLIST',
      };
    const body = new URLSearchParams(options.body);
    let data;
    if (address.includes('core.info')) data = { resource_id: 'p_demo', resource_name: '测试课程' };
    else if (address.includes('column.items'))
      data = {
        list: Array.from({ length: parts }, (_, i) => i + 1).map((n) => ({
          resource_type: 3,
          resource_id: 'v_' + n,
          resource_name: '视频' + n,
        })),
        total: parts,
      };
    else {
      const id = body.get('bizData[resource_id]');
      if (delayed) {
        metrics.active++;
        metrics.peak = Math.max(metrics.peak, metrics.active);
        await new Promise((resolve) => setTimeout(resolve, id === 'v_1' ? 20 : 1));
        metrics.active--;
      }
      if (failAll || (fail && id === 'v_1')) return { ok: true, json: async () => ({ code: 8 }) };
      data = {
        video_urls: 'https://cdn.example/' + id + (hls ? '.m3u8' : '.mp4') + (hls ? '' : '?refresh=' + calls.length),
      };
    }
    return { ok: true, json: async () => ({ code: 0, data }) };
  };
  class MessageError extends Error {}
  vm.runInNewContext(script, {
    core,
    gopeed,
    fetch: fetcher,
    MessageError,
    URL,
    URLSearchParams,
    AbortController,
    setTimeout,
    clearTimeout,
  });
  const task = (file) => ({
    meta: {
      req: {
        ...file.req,
        async setUrl(value) {
          this.url = value;
        },
        async putLabel(key, value) {
          this.labels[key] = value;
        },
      },
    },
    continued: 0,
    async continue() {
      this.continued++;
    },
  });
  return { handlers, calls, warnings, task, gopeed, metrics };
}

test('bounded parallel resolution preserves catalog order despite out-of-order completion', async () => {
  const h = setup({ parts: 7, delayed: true });
  const ctx = { req: { url } };
  await h.handlers.resolve(ctx);
  assert.equal(h.metrics.peak, 3);
  assert.deepEqual(
    Array.from(ctx.res.files, (file) => file.req.labels.resource),
    ['v_1', 'v_2', 'v_3', 'v_4', 'v_5', 'v_6', 'v_7']
  );
  h.gopeed.settings.resolveWorkers = 1;
  h.metrics.peak = 0;
  await h.handlers.resolve({ req: { url } });
  assert.equal(h.metrics.peak, 1);
});

test('extension lists lesson files and refreshes only the selected task on start', async () => {
  const h = setup(),
    ctx = { req: { url: url + '?p=2' } };
  await h.handlers.resolve(ctx);
  assert.equal(ctx.res.name, '测试课程');
  assert.equal(ctx.res.files.length, 1);
  const file = ctx.res.files[0];
  assert.equal(file.req.labels.resource, 'v_2');
  assert.equal(file.req.extra.header.Cookie, undefined);
  assert.equal(JSON.stringify(file.req.labels).includes('fixture-only'), false);
  assert.equal(file.name, '002 视频2.mp4');
  const task = h.task(file),
    original = task.meta.req.url;
  await h.handlers.start({ task });
  assert.notEqual(task.meta.req.url, original);
  assert.ok(h.calls.at(-1).options.body.includes('v_2'));
});

test('one failed lesson does not hide remaining valid videos', async () => {
  const h = setup({ fail: true }),
    ctx = { req: { url } };
  await h.handlers.resolve(ctx);
  assert.equal(ctx.res.files.length, 1);
  assert.equal(ctx.res.files[0].req.labels.resource, 'v_2');
  assert.equal(h.warnings.length, 1);
  assert.equal(h.warnings[0].includes('fixture-only'), false);
});

test('three initial failures stop before requesting the entire course', async () => {
  const h = setup({ failAll: true, parts: 8 });
  await assert.rejects(h.handlers.resolve({ req: { url } }), /连续三节/);
  assert.equal(h.calls.filter((call) => call.address.includes('video.detail_info')).length, 3);
});

test('native HLS gets a TS filename, m3u8 request and no Cookie', async () => {
  const h = setup({ hls: true }),
    ctx = { req: { url } };
  await h.handlers.resolve(ctx);
  assert.equal(ctx.res.range, false);
  assert.match(ctx.res.files[0].name, /\.ts$/);
  assert.match(ctx.res.files[0].req.url, /\.m3u8$/);
  assert.equal(ctx.res.files[0].req.extra.header.Cookie, undefined);
});

test('errors are retried at most twice per task, preserving native protocol format', async () => {
  const h = setup(),
    ctx = { req: { url } };
  await h.handlers.resolve(ctx);
  const task = h.task(ctx.res.files[0]);
  for (let i = 0; i < 5; i++) await h.handlers.error({ task });
  assert.equal(task.continued, 2);
});

test('unsupported host and invalid course URL stop instead of downloading HTML', async () => {
  for (const version of ['', '1.8.1', '2.0.0-beta.2']) {
    const h = setup({ version });
    await assert.rejects(h.handlers.resolve({ req: { url } }), /Gopeed/);
    assert.equal(h.calls.length, 0);
  }
  await assert.rejects(
    setup().handlers.resolve({
      req: { url: 'https://appdemo.pc.xiaoe-tech.com/login' },
    }),
    /支持/
  );
});

test('production bundle has no imports and executes the same resolver in a Gopeed-like global scope', async () => {
  const bundle = readFileSync(new URL('../dist/index.js', import.meta.url), 'utf8');
  assert.doesNotMatch(bundle, /^import /m);
  const h = setup({ script: bundle }),
    ctx = { req: { url: url + '?p=1' } };
  await h.handlers.resolve(ctx);
  assert.equal(ctx.res.files.length, 1);
  assert.match(ctx.res.files[0].name, /\.mp4$/);
});
