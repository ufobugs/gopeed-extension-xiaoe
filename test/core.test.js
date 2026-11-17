import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as core from '../src/core.js';

const page = 'https://appdemo.pc.xiaoe-tech.com/p/t_pc/course_pc_detail/column/p_demo';
const course = core.target(page);
const settings = {
  apiHost: 'appdemo.pc.xiaoe-tech.com',
  cookie: 'ko_token=fixture-only',
};
const reply = (data) => ({ ok: true, json: async () => ({ code: 0, data }) });
const video = (i) => ({
  resource_id: 'v_' + i,
  resource_type: 3,
  resource_name: '课时' + i,
});
const fetcherFor = (data) => async () => reply(data);

test('identify standard merchant URLs and reject unrelated routes/credentials', () => {
  assert.equal(course.app, 'appdemo');
  assert.equal(course.kind, 'column');
  assert.equal(core.target(page.replace('/column/p_demo', '/video/v_one') + '?p=1').kind, 'video');
  assert.equal(core.target(page + '?token=do-not-persist&p=2').page, page);
  for (const address of [
    page.replace('https:', 'http:'),
    page.replace('appdemo.pc.xiaoe-tech.com', 'evil.example'),
    page.replace('/column/', '/audio/'),
    page.replace('https://', 'https://user:pass@'),
    page.replace('.com/', '.com:444/'),
  ])
    assert.throws(() => core.target(address));
});

test('Cookie/API host binding is exact; never automatically replay a shop Cookie to another shop', async () => {
  assert.equal(core.apiOrigin(course, settings), 'https://appdemo.pc.xiaoe-tech.com');
  assert.equal(
    core.apiOrigin(course, { apiHost: 'https://appdemo.h5.xiaoeknow.com/' }),
    'https://appdemo.h5.xiaoeknow.com'
  );
  for (const apiHost of [
    '',
    'appother.pc.xiaoe-tech.com',
    'appdemo.pc.xiaoe-tech.com.evil.example',
    'https://appdemo.pc.xiaoe-tech.com/path',
  ])
    assert.throws(() => core.apiOrigin(course, { apiHost }));
  let calls = 0;
  for (const cookie of ['', 'Cookie: ko_token=fixture', 'ko_token=x\nInjected: value'])
    await assert.rejects(
      core.post(
        course,
        { ...settings, cookie },
        async () => {
          calls++;
        },
        '/test',
        {}
      ),
      /Cookie/
    );
  assert.equal(calls, 0);
});

test('original column POST preserves bracketed form fields and scoped headers', async () => {
  const result = await core.catalog(course, settings, async (url, options) => {
    assert.equal(url, 'https://appdemo.pc.xiaoe-tech.com/xe.course.business.column.items.get/2.0.0');
    assert.equal(options.redirect, 'error');
    assert.equal(options.headers.Cookie, 'ko_token=fixture-only');
    assert.equal(options.headers.Origin, 'https://appdemo.pc.xiaoe-tech.com');
    assert.equal(options.headers['Content-Type'], 'application/x-www-form-urlencoded;charset=UTF-8');
    assert.deepEqual(Object.fromEntries(new URLSearchParams(options.body)), {
      'bizData[column_id]': 'p_demo',
      'bizData[page_index]': '1',
      'bizData[page_size]': '8',
      'bizData[sort]': 'desc',
    });
    return reply({ list: [video(1)], total: 1 });
  });
  assert.equal(result.entries[0].title, '课时1');
  assert.equal(JSON.stringify(result).includes('fixture-only'), false);
});

test('paginate all lessons with server total and reject incomplete or repeated pages', async () => {
  const pages = [];
  const result = await core.catalog(course, settings, async (_, options) => {
    const page = Number(new URLSearchParams(options.body).get('bizData[page_index]'));
    pages.push(page);
    return reply({
      total: 10,
      list: page === 1 ? Array.from({ length: 8 }, (_, i) => video(i)) : [video(8), video(9)],
    });
  });
  assert.equal(result.entries.length, 10);
  assert.deepEqual(pages, [1, 2]);
  await assert.rejects(core.catalog(course, settings, fetcherFor({ list: [video(1)], total: 10 })), /不完整/);
  await assert.rejects(
    core.catalog(
      course,
      { ...settings, maxPages: 1 },
      fetcherFor({
        list: Array.from({ length: 8 }, (_, i) => video(i)),
        total: 20,
      })
    ),
    /页数/
  );
  await assert.rejects(
    core.catalog(
      course,
      settings,
      fetcherFor({
        list: Array.from({ length: 8 }, (_, i) => video(i)),
        total: 20,
      })
    ),
    /重复/
  );
});

test('traverse same-shop nested columns once, deduplicate videos, and skip cross-shop/audio', async () => {
  const child = { resource_id: 'p_child', resource_type: 6 };
  const seen = [];
  const result = await core.catalog(course, settings, async (_, options) => {
    const column = new URLSearchParams(options.body).get('bizData[column_id]');
    seen.push(column);
    const list =
      column === 'p_demo'
        ? [child, { children: [video(1), { ...video(8), app_id: 'appother' }] }, { resource_type: 1 }]
        : [video(2), video(1), child];
    return reply({ list, total: list.length });
  });
  assert.deepEqual(seen, ['p_demo', 'p_child']);
  assert.deepEqual(
    result.entries.map((item) => item.id),
    ['v_1', 'v_2']
  );
  assert.equal(result.skipped, 2);
});

test('PC adapter distinguishes authentication failure from an empty catalog', async () => {
  await assert.rejects(
    core.catalog(course, { ...settings, adapter: 'pc' }, fetcherFor({ list: [], total: 0, available: 0 })),
    /会话/
  );
  const result = await core.catalog(course, { ...settings, adapter: 'pc' }, async (url, options) => {
    assert.match(url, /resource_catalog_list/);
    assert.equal(new URLSearchParams(options.body).get('course_id'), 'p_demo');
    return reply({ list: [video(1)], total: 1, available: 1 });
  });
  assert.equal(result.entries.length, 1);
});

test('current web catalog uses business_go JSON with numeric pagination and actual course Referer', async () => {
  const calls = [];
  const result = await core.catalog(course, { ...settings, adapter: 'web' }, async (url, options) => {
    assert.equal(url, 'https://appdemo.pc.xiaoe-tech.com/xe.course.business_go.column.items.get/2.0.0');
    assert.equal(options.headers['Content-Type'], 'application/json');
    assert.equal(options.headers.Referer, page + '?product_id=p_demo');
    const body = JSON.parse(options.body);
    calls.push(body);
    assert.deepEqual(body, {
      column_id: 'p_demo',
      page_index: calls.length,
      page_size: 20,
      content_app_id: null,
      sort: 'desc',
    });
    return reply({
      total: 21,
      list: (body.page_index === 1 ? Array.from({ length: 20 }, (_, i) => video(i)) : [video(20)]).map((item) => ({
        resource_id: item.resource_id,
        resource_type: item.resource_type,
        resource_title: item.resource_name,
      })),
    });
  });
  assert.equal(result.entries.length, 21);
  assert.equal(result.entries[0].title, '课时0');
  assert.equal(result.entries[20].title, '课时20');
  assert.equal(calls.length, 2);
});

test('select numbered lessons, deduplicate ranges, and reject oversized/malformed ranges', () => {
  const entries = Array.from({ length: 8 }, (_, i) => i);
  assert.deepEqual(core.select(entries, '1,3,5-8,3'), [0, 2, 4, 5, 6, 7]);
  assert.equal(core.select(entries, null), entries);
  for (const input of ['0', '8-3', '1-999999999', 'invalid', '9']) assert.throws(() => core.select(entries, input));
});

test('restore address obfuscation including Unicode and preserve signed URL bytes', async () => {
  const url = 'https://cdn.example/video.mp4?token=a%2Fb&x=1+2&x=3';
  const encoded =
    Buffer.from(JSON.stringify([{ url: 'https://cdn.example/first.mp4' }, { title: '中文😀', url }]))
      .toString('base64')
      .replace(/[1234]/g, (char) => ({ 1: '@', 2: '#', 3: '$', 4: '%' })[char]) + 'abcd';
  assert.equal(core.decodeContainer(encoded).title, '中文😀');
  const media = await core.playback(course, { id: 'v_one', product: 'p_demo' }, settings, async (_, options) => {
    const body = new URLSearchParams(options.body);
    assert.equal(body.get('bizData[resource_id]'), 'v_one');
    assert.equal(body.get('bizData[product_id]'), 'p_demo');
    return reply({ video_urls: encoded });
  });
  assert.equal(media.url, url);
  assert.equal(media.extension, 'mp4');
});

test('plain media does not search arbitrary fields or accept protected/unsafe protocols', () => {
  for (const container of [
    { unknown: 'https://cdn.example/video.mp4' },
    { drm: true, url: 'https://cdn.example/video.mp4' },
    'http://cdn.example/video.mp4',
    'https://localhost/video.mp4',
    'https://127.0.0.1/video.mp4',
    'https://user:pass@cdn.example/video.mp4',
    'file:///video.mp4',
    'https://cdn.example/no-extension',
  ])
    assert.throws(() => core.plainMedia(container));
  assert.equal(core.plainMedia('{"hd":{"url":"https://cdn.example/video.mp4"}}').kind, 'file');
  assert.throws(
    () => core.decodeContainer('PRIVATE-ENCODING'),
    (error) => !error.message.includes('PRIVATE')
  );
});

test('network, invalid JSON, and permission errors never echo secrets', async () => {
  for (const fetcher of [
    async () => {
      throw new Error('ko_token=PRIVATE https://private.example');
    },
    async () => ({ ok: false, status: 403 }),
    async () => ({
      ok: true,
      json: async () => {
        throw new Error('PRIVATE');
      },
    }),
    async () => ({
      ok: true,
      json: async () => ({ code: 8, message: 'ko_token=PRIVATE' }),
    }),
  ])
    await assert.rejects(
      core.post(course, settings, fetcher, '/test', {}),
      (error) => !/PRIVATE|private.example/.test(error.message)
    );
});

test('code 8 parameter rejection identifies the interface instead of blaming Cookie', async () => {
  await assert.rejects(
    core.post(
      course,
      settings,
      async () => ({ ok: true, json: async () => ({ code: 8, msg: '参数有误 PRIVATE' }) }),
      '/xe.course.business.column.items.get/2.0.0',
      {}
    ),
    (error) =>
      /column.items.get/.test(error.message) && /参数不匹配/.test(error.message) && !/PRIVATE/.test(error.message)
  );
});

const mediaList = '#EXTM3U\n#EXT-X-TARGETDURATION:4\n#EXTINF:4,\nsegment.ts\n#EXT-X-ENDLIST\n';
test('HLS chooses best muxed variant, retains format, and sends only media headers', async () => {
  const calls = [];
  const result = await core.hlsMedia('https://cdn.example/master.m3u8', async (url, options) => {
    calls.push(url);
    assert.equal(options.headers.Cookie, undefined);
    assert.equal(options.headers.Referer, 'https://www.h5.xiaoeknow.com/');
    assert.equal(options.credentials, 'omit');
    return {
      ok: true,
      text: async () =>
        calls.length === 1
          ? '#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=100\nlow.m3u8\n#EXT-X-STREAM-INF:BANDWIDTH=1000\nhigh.m3u8\n'
          : mediaList,
    };
  });
  assert.equal(result.url, 'https://cdn.example/high.m3u8');
  assert.equal(result.extension, 'ts');
  const fmp4 = await core.hlsMedia(result.url, async () => ({
    ok: true,
    text: async () => mediaList.replace('#EXTINF:', '#EXT-X-MAP:URI="init.mp4"\n#EXTINF:'),
  }));
  assert.equal(fmp4.extension, 'mp4');
});

test('HLS allows standard AES-128 and rejects live/DRM/unsafe resources or HTML', async () => {
  const aes = mediaList.replace('#EXTINF:', '#EXT-X-KEY:METHOD=AES-128,URI="key.bin",KEYFORMAT="identity"\n#EXTINF:');
  assert.equal(
    (
      await core.hlsMedia('https://cdn.example/media.m3u8', async () => ({
        ok: true,
        text: async () => aes,
      }))
    ).kind,
    'hls'
  );
  for (const text of [
    '<html>Login</html>',
    mediaList.replace('#EXT-X-ENDLIST', ''),
    aes.replace('AES-128', 'SAMPLE-AES'),
    aes.replace('identity', 'com.example.drm'),
    mediaList.replace('segment.ts', 'https://127.0.0.1/private'),
    mediaList.replace('#EXTINF:', '#EXT-X-DISCONTINUITY\n#EXTINF:'),
  ])
    await assert.rejects(
      core.hlsMedia('https://cdn.example/media.m3u8', async () => ({
        ok: true,
        text: async () => text,
      }))
    );
});

test('filenames use lesson titles without resource IDs and remain Windows-safe and UTF-8 bounded', () => {
  const name = core.filename('v_one', '课程😀:/'.repeat(80), 'ts');
  assert.ok(Buffer.byteLength(name) <= 100);
  assert.match(name, /^课程/);
  assert.equal(core.filename('v_one', '001 考试介绍、学习方法', 'mp4'), '001 考试介绍、学习方法.mp4');
  assert.match(name, /\.ts$/);
  assert.doesNotMatch(name, /[<>:"/\\|?*]/);
});
