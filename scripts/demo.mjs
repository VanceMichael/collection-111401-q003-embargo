import { createProvider } from '../provider/server.mjs';
import { collectScheduled } from '../src/domain.mjs';
import { Archive } from '../src/archive.mjs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const directory = await mkdtemp(join(tmpdir(), 'collection-'));
const provider = await createProvider();
const control = async change => {
  const response = await fetch(provider.base + '/_control', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(change),
  });
  if (!response.ok) throw new Error('控制面调整失败：' + response.status);
};

const publicationRequests = () => provider.audit.filter(entry => entry.path.startsWith('/publication/')).length;
const timeline = [];
const record = (phase, collector) => {
  const status = collector.status();
  timeline.push({
    phase,
    calibrated: status.calibrated,
    sourceWindow: status.sourceWindow,
    items: Object.fromEntries(Object.entries(status.items).map(([id, item]) =>
      [id, { status: item.status, version: item.version, release: item.release, note: item.note, receipt: item.receipt }])),
    publicationRequests: publicationRequests(),
  });
};

try {
  const collector = await collectScheduled(provider.base, directory, { pollIntervalMs: 200 });
  record('启动（来源时钟1000）：只校准与取排期，不请求正文', collector);

  await control({ mode: 'cancelled' });
  await collector.tick();
  record('sensor 被取消：留下明确状态，不请求正文', collector);

  await control({ clock: 1012 });
  await collector.tick();
  record('时钟推进到1012：camera 确认开放，领取排期版本 spec-1', collector);

  await control({ generation: 2, clock: 1015 });
  await collector.tick();
  record('camera 顺延至1030并改版为 spec-2：旧许可不抢领新版本', collector);

  await control({ clock: 1032 });
  await collector.tick();
  record('时钟推进到1032：确认顺延后的开放，领取 spec-2', collector);

  const restarted = await collectScheduled(provider.base, directory, { pollIntervalMs: 200 });
  record('模拟重启：恢复场次状态并重新校准，不重复领取、不凭旧计时器抢跑', restarted);
  await collector.stop();
  await restarted.stop();

  const receipts = await new Archive(directory).list();
  console.log(JSON.stringify({
    service: 'embargo',
    timeline,
    receipts: receipts.map(receipt => ({ id: receipt.id, digest: receipt.digest, size: receipt.size, source: receipt.source })),
    requests: provider.audit,
  }, null, 2));
} finally {
  await provider.close();
  await rm(directory, { recursive: true, force: true });
}
