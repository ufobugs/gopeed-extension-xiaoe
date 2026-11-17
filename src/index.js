import * as core from './core.js';

function userFacing(handler) {
  return async (ctx) => {
    try {
      return await handler(ctx);
    } catch (error) {
      throw new MessageError(error.message || '小鹅通解析失败。');
    }
  };
}

function requireHost() {
  const version = gopeed.host?.env?.version || '';
  const parsed = /^(\d+)\.(\d+)\.(\d+)(?:-beta\.(\d+))?(?:\+[\w.-]+)?$/.exec(version);
  if (
    !parsed ||
    Number(parsed[1]) < 2 ||
    (Number(parsed[1]) === 2 &&
      Number(parsed[2]) === 0 &&
      Number(parsed[3]) === 0 &&
      parsed[4] &&
      Number(parsed[4]) < 3)
  ) {
    throw new Error('小鹅通插件需要支持原生 HLS 的 Gopeed 2.0.0-beta.3 或更新版本。');
  }
}

async function prepare(course, entry) {
  const media = await core.playback(course, entry, gopeed.settings, fetch);
  return media.kind === 'hls' ? core.hlsMedia(media.url, fetch) : media;
}

gopeed.events.onResolve(
  userFacing(async (ctx) => {
    requireHost();
    const course = core.target(ctx.req.url);
    core.apiOrigin(course, gopeed.settings);
    const catalog = await core.catalog(course, gopeed.settings, fetch);
    const entries = core.select(catalog.entries, course.selection);
    gopeed.logger.info?.(`小鹅通目录读取完成：共 ${catalog.entries.length} 节，本次解析 ${entries.length} 节。`);
    const deadline = Date.now() + 120000;
    let consecutiveFailures = 0;
    const files = [],
      failed = [];
    const workers = Number(gopeed.settings.resolveWorkers ?? 3);
    if (!Number.isInteger(workers) || workers < 1 || workers > 4) throw new Error('解析并发数应为 1–4。');
    for (let offset = 0; offset < entries.length; offset += workers) {
      if (Date.now() >= deadline)
        throw new Error('播放信息解析超过两分钟，已停止；请在课程链接添加 p=1 或按范围分批解析。');
      const batch = entries.slice(offset, offset + workers);
      // Wait for the whole bounded batch; results retain catalog order even
      // when the network finishes lessons in a different order.
      const results = await Promise.all(
        batch.map(async (entry) => {
          try {
            return { media: await prepare(course, entry) };
          } catch (error) {
            return { error };
          }
        })
      );
      for (let i = 0; i < batch.length; i++) {
        const entry = batch[i];
        gopeed.logger.info?.(`小鹅通解析进度 ${files.length + failed.length + 1}/${entries.length}：${entry.id}`);
        try {
          if (results[i].error) throw results[i].error;
          const media = results[i].media;
          consecutiveFailures = 0;
          const order = catalog.entries.indexOf(entry) + 1;
          const labels = {
            [gopeed.info.identity]: '1',
            type: 'xiaoe-video',
            course: course.page,
            resource: entry.id,
            product: entry.product || '',
            kind: media.kind,
            extension: media.extension,
          };
          files.push({
            name: core.filename(entry.id, `${String(order).padStart(3, '0')} ${entry.title}`, media.extension),
            req: {
              url: media.url,
              rawUrl: ctx.req.url,
              labels,
              extra: { header: core.mediaHeaders() },
            },
          });
        } catch (error) {
          failed.push({ resource: entry.id, message: error.message });
          consecutiveFailures++;
          if (!files.length && consecutiveFailures >= 3)
            throw new Error(`连续三节播放信息解析失败，已停止，未继续等待整套课程。首项：${failed[0].message}`);
        }
      }
    }
    if (!files.length) throw new Error(`没有课时解析成功。${failed[0]?.message || '目录没有可下载视频。'}`);
    if (failed.length)
      gopeed.logger.warn(`${failed.length} 个课时解析失败；首项：${failed[0].resource}，${failed[0].message}`);
    if (catalog.skipped) gopeed.logger.debug(`跳过 ${catalog.skipped} 个非视频或跨店铺条目。`);
    ctx.res = {
      name: await core.courseTitle(course, gopeed.settings, fetch),
      files,
      range: files.every((file) => file.req.labels.kind === 'file'),
    };
  })
);

async function refresh(task) {
  const req = task.meta.req,
    labels = req.labels;
  if (labels.type !== 'xiaoe-video') return;
  const course = core.target(labels.course);
  const media = await prepare(course, {
    id: labels.resource,
    product: labels.product,
  });
  if (media.kind !== labels.kind || media.extension !== labels.extension)
    throw new Error('媒体格式已变化，请重新创建该课时任务。');
  await req.setUrl(media.url);
}

gopeed.events.onStart(
  userFacing(async (ctx) => {
    requireHost();
    await refresh(ctx.task);
  })
);
gopeed.events.onError(
  userFacing(async (ctx) => {
    const req = ctx.task.meta.req;
    if (req.labels.type !== 'xiaoe-video') return;
    const count = Number(req.labels.xiaoeRetries || 0);
    if (!Number.isSafeInteger(count) || count >= 2) return;
    await req.putLabel('xiaoeRetries', String(count + 1));
    await refresh(ctx.task);
    await ctx.task.continue();
  })
);
