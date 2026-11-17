const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36';
const ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;
const SHOP = /^(app[a-z0-9]{1,64})\.(?:pc\.xiaoe-tech\.com|h5\.xiaoeknow\.com|h5\.xeknow\.com)$/;
const VIDEO = '/xe.course.business.video.detail_info.get/2.0.0';

function identifier(value) {
  if (typeof value !== 'string' || !ID.test(value)) throw new Error('课程或资源标识无效。');
  return value;
}

export function target(raw) {
  let url;
  try {
    url = new URL(raw);
  } catch (_) {
    throw new Error('请输入完整的小鹅通 HTTPS 课程链接。');
  }
  const host = SHOP.exec(url.hostname);
  const route = /^\/p\/t_pc\/course_pc_detail\/(column|video)\/([A-Za-z0-9_-]+)\/?$/.exec(url.pathname);
  if (url.protocol !== 'https:' || url.username || url.password || url.port || !host || !route) {
    throw new Error('目前支持小鹅通标准 PC/H5 店铺的 course_pc_detail/column 或 video 链接。');
  }
  return {
    app: host[1],
    id: identifier(route[2]),
    kind: route[1],
    origin: url.origin,
    page: url.origin + url.pathname,
    selection: url.searchParams.get('p'),
  };
}

export function apiOrigin(course, settings) {
  const value = String(settings.apiHost || '').trim();
  if (!value) throw new Error('请先设置“登录店铺/API 域名”和该店铺的 Cookie。');
  let url;
  try {
    url = new URL(value.includes('://') ? value : `https://${value}`);
  } catch (_) {
    throw new Error('API 域名无效。');
  }
  if (
    url.protocol !== 'https:' ||
    url.username ||
    url.password ||
    url.port ||
    url.pathname !== '/' ||
    url.search ||
    url.hash ||
    SHOP.exec(url.hostname)?.[1] !== course.app
  ) {
    throw new Error('API 域名必须是当前课程同一 app_id 的标准 HTTPS 店铺；不会向其他店铺发送 Cookie。');
  }
  return url.origin;
}

function cookie(settings) {
  const value = typeof settings.cookie === 'string' ? settings.cookie.trim() : '';
  if (!value || /[\r\n]/.test(value))
    throw new Error('请填写有效的店铺 Cookie，不是学习中心 Cookie，也不要包含“Cookie:”前缀。');
  if (/^cookie:/i.test(value)) throw new Error('仅粘贴 Cookie 的值，不要包含“Cookie:”前缀。');
  return value;
}

function apiHint(result) {
  const message =
    typeof result?.msg === 'string' ? result.msg : typeof result?.message === 'string' ? result.message : '';
  if (/参数/.test(message))
    return '服务器提示参数不匹配；请按浏览器实际请求选择 column.items 或 PC e_course 接口，不必先更换 Cookie。';
  if (/未登[录陆]|登录|登陸|token|cookie/i.test(message))
    return '服务器提示会话校验问题；请核对实际 API 域名及对应店铺 Cookie。';
  if (/权限|购买|订阅/.test(message)) return '服务器提示访问权限问题；请确认本人课程权限。';
  return '请核对店铺 API 域名、接口类型、登录会话及课程权限。';
}

export async function post(course, settings, fetcher, path, fields, json = false) {
  const origin = apiOrigin(course, settings);
  const headers = {
    Cookie: cookie(settings),
    Origin: origin,
    Referer: origin + '/',
    'User-Agent': UA,
    Accept: 'application/json, text/plain, */*',
    'Content-Type': json ? 'application/json' : 'application/x-www-form-urlencoded;charset=UTF-8',
  };
  if (json) {
    headers.Origin = course.origin;
    headers.Referer = course.page + '?product_id=' + encodeURIComponent(course.id);
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 20000);
  let failure = '店铺接口网络请求失败，请检查网络。';
  try {
    const response = await fetcher(origin + path, {
      method: 'POST',
      headers,
      body: json ? JSON.stringify(fields) : new URLSearchParams(fields).toString(),
      redirect: 'error',
      signal: controller.signal,
    });
    if (!response.ok) {
      failure = `店铺接口 HTTP ${Number(response.status) || '错误'}。`;
      throw new Error();
    }
    let result;
    try {
      result = await response.json();
    } catch (_) {
      failure = '店铺接口没有返回有效 JSON；请核对 API 域名和店铺登录。';
      throw new Error();
    }
    if (result?.code !== 0 || !result.data || typeof result.data !== 'object') {
      failure = `店铺接口 ${path.split('/')[1]} 拒绝请求（code=${
        Number.isSafeInteger(result?.code) ? result.code : '未知'
      }）。${apiHint(result)}`;
      throw new Error();
    }
    return result.data;
  } catch (_) {
    throw new Error(failure);
  } finally {
    clearTimeout(timer);
  }
}

function kind(item) {
  if ([3, '3', 'video'].includes(item.resource_type)) return 'video';
  if ([6, '6', 'column'].includes(item.resource_type)) return 'column';
  if (item.resource_type == null && String(item.resource_id).startsWith('v_')) return 'video';
  return null;
}

function title(item, fallback) {
  return String(item.resource_title || item.resource_name || item.title || item.name || fallback)
    .replace(/[\x00-\x1f\x7f]/g, ' ')
    .trim()
    .slice(0, 300);
}

export function limits(settings) {
  const maxPages = Number(settings.maxPages ?? 200),
    maxVideos = Number(settings.maxVideos ?? 2000);
  if (
    !Number.isInteger(maxPages) ||
    maxPages < 1 ||
    maxPages > 1000 ||
    !Number.isInteger(maxVideos) ||
    maxVideos < 1 ||
    maxVideos > 5000
  )
    throw new Error('页数应为 1–1000，视频上限应为 1–5000。');
  return { maxPages, maxVideos };
}

export async function catalog(course, settings, fetcher) {
  const { maxPages, maxVideos } = limits(settings);
  if (course.kind === 'video')
    return {
      title: course.id,
      entries: [{ id: course.id, product: '', title: course.id }],
      skipped: 0,
    };
  const adapter = settings.adapter || 'original';
  if (!['original', 'pc', 'web'].includes(adapter)) throw new Error('接口适配器无效。');
  const queue = [course.id],
    columns = new Set(),
    videos = new Set(),
    entries = [];
  let skipped = 0;
  function walk(items, column, depth = 0) {
    if (depth > 20) throw new Error('目录层级超过上限。');
    for (const item of items) {
      if (!item || typeof item !== 'object' || Array.isArray(item)) {
        skipped++;
        continue;
      }
      if (item.app_id && item.app_id !== course.app) {
        skipped++;
        continue;
      }
      const type = kind(item),
        id = item.resource_id;
      if (type && !ID.test(typeof id === 'string' ? id : '')) throw new Error('目录含有无效资源标识。');
      if (type === 'video' && !videos.has(id)) {
        videos.add(id);
        entries.push({
          id,
          product: typeof item.product_id === 'string' && ID.test(item.product_id) ? item.product_id : '',
          title: title(item, id),
          column,
        });
        if (entries.length > maxVideos) throw new Error('视频数量超过设置上限，未将部分目录当成完整目录。');
      } else if (type === 'column' && !columns.has(id)) queue.push(id);
      const children = item.children || item.items;
      if (Array.isArray(children)) walk(children, column, depth + 1);
      else if (!type) skipped++;
    }
  }
  while (queue.length) {
    const column = queue.shift();
    if (columns.has(column)) continue;
    if (columns.size >= 100) throw new Error('子专栏数量超过上限。');
    columns.add(column);
    const seen = new Set();
    let completed = false,
      received = 0;
    for (let page = 1; page <= maxPages; page++) {
      const size = adapter === 'web' ? 20 : adapter === 'original' ? 8 : 50;
      const path =
        adapter === 'web'
          ? '/xe.course.business_go.column.items.get/2.0.0'
          : adapter === 'original'
          ? '/xe.course.business.column.items.get/2.0.0'
          : '/xe.course.business_go.avoidlogin.e_course.resource_catalog_list.get/1.0.0';
      const fields =
        adapter === 'web'
          ? { column_id: column, page_index: page, page_size: size, content_app_id: null, sort: 'desc' }
          : adapter === 'original'
          ? {
              'bizData[column_id]': column,
              'bizData[page_index]': String(page),
              'bizData[page_size]': String(size),
              'bizData[sort]': 'desc',
            }
          : {
              app_id: course.app,
              course_id: column,
              order: 'asc',
              p_id: '0',
              page: String(page),
              page_size: String(size),
              sub_course_id: '',
              resource_id: '',
              is_display_auth_sections: '0',
            };
      const data = await post(course, settings, fetcher, path, fields, adapter === 'web');
      if (!Array.isArray(data.list)) throw new Error('目录响应缺少课时列表。');
      if (adapter === 'pc' && ![1, '1', true].includes(data.available))
        throw new Error('当前店铺会话无法读取目录，请检查店铺登录和课程权限。');
      const total = data.total == null || data.total === '' ? null : Number(data.total);
      if (total !== null && (!Number.isSafeInteger(total) || total < 0)) throw new Error('目录总数无效。');
      let added = 0;
      function identity(item) {
        if (!item || typeof item !== 'object') return null;
        const children = item.children || item.items;
        return [
          item.app_id || course.app,
          item.resource_id || '',
          kind(item),
          Array.isArray(children) ? children.map(identity) : [],
        ];
      }
      for (const item of data.list) {
        const key = JSON.stringify(identity(item));
        if (!seen.has(key)) {
          seen.add(key);
          added++;
        }
      }
      if (data.list.length && !added) throw new Error('目录接口重复返回同一页，已停止。');
      received += added;
      walk(data.list, column);
      if ((total !== null && received >= total) || (total === null && data.list.length < size)) {
        completed = true;
        break;
      }
      if (!data.list.length || data.list.length < size) throw new Error('目录返回不完整，未当成整套课程。');
    }
    if (!completed) throw new Error('目录页数达到上限，结果尚未完整。');
  }
  if (!entries.length) throw new Error('目录未取得视频，请检查店铺 Cookie、接口适配器或课程类型。');
  return { title: course.id, entries, skipped };
}

export async function courseTitle(course, settings, fetcher) {
  try {
    const data = await post(course, settings, fetcher, '/xe.course.business.core.info.get/2.0.0', {
      resource_id: course.id,
    });
    return data.resource_id === course.id ? title(data, course.id) : course.id;
  } catch (_) {
    return course.id;
  }
}

export function select(entries, selection) {
  if (selection == null || selection === '') return entries;
  const indexes = new Set();
  for (const part of selection.split(',')) {
    const match = /^(\d+)(?:-(\d+))?$/.exec(part);
    if (!match) throw new Error('p 参数应为编号或范围，例如 p=1,3,5-8。');
    const first = Number(match[1]),
      last = Number(match[2] || match[1]);
    if (
      !Number.isSafeInteger(first) ||
      !Number.isSafeInteger(last) ||
      first < 1 ||
      last < first ||
      last > entries.length
    )
      throw new Error('课时选择超出目录范围。');
    for (let i = first - 1; i < last; i++) indexes.add(i);
  }
  return entries.filter((_, i) => indexes.has(i));
}

export function decodeContainer(value) {
  if (typeof value !== 'string' || value.length < 8 || value.length > 1024 * 1024)
    throw new Error('播放地址编码长度不受支持。');
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
  const text = value.slice(0, -4).replace(/[@#$%]/g, (char) => ({ '@': '1', '#': '2', $: '3', '%': '4' })[char]);
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(text) || text.replace(/=+$/, '').length % 4 === 1)
    throw new Error('无法识别播放地址编码。');
  let bits = 0,
    available = 0,
    encoded = '';
  for (const char of text.replace(/=+$/, '')) {
    bits = (bits << 6) | alphabet.indexOf(char);
    available += 6;
    if (available >= 8) {
      available -= 8;
      encoded += '%' + ((bits >> available) & 255).toString(16).padStart(2, '0');
    }
  }
  try {
    const result = JSON.parse(decodeURIComponent(encoded));
    if (Array.isArray(result) && result.length) return result[result.length - 1];
    if (result && typeof result === 'object' && !Array.isArray(result)) return result;
  } catch (_) {
    /* Never include encoded input in errors. */
  }
  throw new Error('播放地址编码没有返回可识别媒体对象。');
}

export function mediaURL(value) {
  if (typeof value !== 'string' || /[\x00-\x20\x7f]/.test(value)) throw new Error('媒体地址无效。');
  let url;
  try {
    url = new URL(value);
  } catch (_) {
    throw new Error('媒体地址无效。');
  }
  if (
    url.protocol !== 'https:' ||
    url.username ||
    url.password ||
    url.port ||
    url.hash ||
    !/^[a-z0-9.-]+\.[a-z]{2,}$/i.test(url.hostname) ||
    /(?:^|\.)(?:localhost|local|internal|test|invalid)$/.test(url.hostname)
  )
    throw new Error('仅支持公共 HTTPS 媒体地址，不向媒体域名发送店铺 Cookie。');
  return url;
}

function protectedMedia(value) {
  return ['drm', 'drm_type', 'key_system', 'encrypted', 'encryption'].some((key) => value?.[key] && value[key] !== '0');
}

export function plainMedia(container) {
  const queue = [[container, 0]];
  let visited = 0;
  while (queue.length) {
    const [node, depth] = queue.shift();
    if (++visited > 512 || depth > 8) throw new Error('媒体容器超过解析上限。');
    if (typeof node === 'string') {
      if (node.length > 1024 * 1024) continue;
      if (/^[\s]*[\[{]/.test(node)) {
        try {
          queue.push([JSON.parse(node), depth + 1]);
        } catch (_) {}
        continue;
      }
      let url;
      try {
        url = mediaURL(node);
      } catch (_) {
        continue;
      }
      const extension = /\.(mp4|m4v|webm|m3u8)$/i.exec(url.pathname)?.[1].toLowerCase();
      if (extension)
        return {
          url: node,
          kind: extension === 'm3u8' ? 'hls' : 'file',
          extension,
        };
    } else if (Array.isArray(node)) queue.push(...node.slice(0, 512).map((item) => [item, depth + 1]));
    else if (node && typeof node === 'object' && !protectedMedia(node)) {
      for (const key of ['url', 'video_url', 'play_url', 'src', 'original', 'fhd', 'hd', 'sd'])
        if (key in node) queue.push([node[key], depth + 1]);
    }
  }
  throw new Error('播放接口未提供支持的普通视频地址。');
}

export async function playback(course, entry, settings, fetcher) {
  const adapter = settings.adapter || 'original';
  const fields =
    adapter === 'original'
      ? {
          'bizData[resource_id]': identifier(entry.id),
          'bizData[product_id]': entry.product ? identifier(entry.product) : '',
          'bizData[opr_sys]': 'Win32',
        }
      : {
          resource_id: identifier(entry.id),
          product_id: entry.product ? identifier(entry.product) : '',
          opr_sys: 'Win32',
          pack: '',
        };
  const data = await post(course, settings, fetcher, VIDEO, fields);
  if (protectedMedia(data) || data.is_preview === true || data.is_preview === 1)
    throw new Error('接口未提供普通完整视频。');
  let value = data.video_urls;
  if (typeof value === 'string' && !/^(?:https?:\/\/|\s*[\[{])/.test(value)) value = decodeContainer(value);
  return plainMedia(value);
}

export async function hlsMedia(address, fetcher, depth = 0) {
  if (depth > 4) throw new Error('HLS 主列表跳转层级过多。');
  mediaURL(address);
  const controller = new AbortController(),
    timer = setTimeout(() => controller.abort(), 20000);
  let text;
  try {
    const response = await fetcher(address, {
      headers: mediaHeaders(),
      redirect: 'error',
      credentials: 'omit',
      signal: controller.signal,
    });
    if (!response.ok) throw new Error();
    text = await response.text();
  } catch (_) {
    throw new Error('HLS 播放列表请求失败，请检查地址是否过期。');
  } finally {
    clearTimeout(timer);
  }
  if (text.length > 4 * 1024 * 1024 || !text.trimStart().startsWith('#EXTM3U'))
    throw new Error('服务器未返回有效 HLS 播放列表。');
  const lines = text.split(/\r?\n/).map((line) => line.trim());
  const variants = [];
  for (let i = 0; i < lines.length; i++)
    if (lines[i].startsWith('#EXT-X-STREAM-INF:')) {
      if (/(?:^|,)AUDIO=/.test(lines[i])) throw new Error('暂不支持独立音轨 HLS。');
      if (!lines[i + 1] || lines[i + 1].startsWith('#')) throw new Error('HLS 变体地址缺失。');
      variants.push({
        bandwidth: Number(/BANDWIDTH=(\d+)/.exec(lines[i])?.[1] || 0),
        url: new URL(lines[i + 1], address).href,
      });
    }
  if (variants.length) return hlsMedia(variants.sort((a, b) => b.bandwidth - a.bandwidth)[0].url, fetcher, depth + 1);
  if (!lines.includes('#EXT-X-ENDLIST')) throw new Error('只支持已结束的 HLS 点播，不支持直播。');
  if (lines.some((line) => /^#EXT-X-(?:SESSION-KEY|GAP|DISCONTINUITY)(?::|$)/.test(line)))
    throw new Error('HLS 包含不支持的时间线或密钥特性。');
  for (const line of lines) {
    if (line.startsWith('#EXT-X-KEY:') && !/METHOD=NONE(?:,|$)/.test(line)) {
      if (!/METHOD=AES-128(?:,|$)/.test(line) || /KEYFORMAT="(?!identity")/.test(line))
        throw new Error('仅支持标准 AES-128 identity HLS，不支持 DRM 或专有密钥。');
      const key = /URI="([^"]+)"/.exec(line)?.[1];
      if (!key) throw new Error('HLS 密钥地址缺失。');
      mediaURL(new URL(key, address).href);
    }
    if (line && !line.startsWith('#')) mediaURL(new URL(line, address).href);
    if (line.startsWith('#EXT-X-MAP:')) {
      const init = /URI="([^"]+)"/.exec(line)?.[1];
      if (!init) throw new Error('HLS 初始化分片地址缺失。');
      mediaURL(new URL(init, address).href);
    }
  }
  return {
    url: address,
    kind: 'hls',
    extension: lines.some((line) => line.startsWith('#EXT-X-MAP:')) ? 'mp4' : 'ts',
  };
}

export function mediaHeaders() {
  return { Referer: 'https://www.h5.xiaoeknow.com/', 'User-Agent': UA };
}

export function filename(id, title, extension) {
  identifier(id);
  const suffix = '.' + extension;
  let result = '';
  const budget = 100 - suffix.length;
  let bytes = 0;
  for (const char of String(title || id).replace(/[<>:"/\\|?*\x00-\x1f\x7f]/g, '_')) {
    const size = encodeURIComponent(char).replace(/%[A-F\d]{2}/gi, 'x').length;
    if (bytes + size > budget) break;
    result += char;
    bytes += size;
  }
  return result + suffix;
}
