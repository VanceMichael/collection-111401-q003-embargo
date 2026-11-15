import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createProvider } from '../provider/server.mjs';
import { collectScheduled } from '../src/domain.mjs';
import { Archive } from '../src/archive.mjs';

async function controlled(provider, change) {
  const response = await fetch(provider.base + '/_control', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(change) });
  assert.equal(response.status, 200);
}

const publicationRequests = provider => provider.audit.filter(entry => entry.path.startsWith('/publication/'));
const timeRequests = provider => provider.audit.filter(entry => entry.path === '/time');

test('开放确认前不请求正文，确认后领取对应排期版本', async () => {
  const provider = await createProvider();
  const directory = await mkdtemp(join(tmpdir(), 'scheduled-'));
  try {
    const collector = await collectScheduled(provider.base, directory, { pollIntervalMs: 100 });
    let status = collector.status();
    assert.equal(status.items.camera.status, 'pending');
    assert.equal(status.items.sensor.status, 'pending');
    assert.equal(publicationRequests(provider).length, 0);

    await controlled(provider, { clock: 1012 });
    await collector.tick();
    status = collector.status();
    assert.equal(status.items.camera.status, 'received');
    assert.equal(status.items.sensor.status, 'received');

    const requests = publicationRequests(provider);
    assert.equal(requests.length, 2);
    assert.ok(requests.every(entry => entry.query.includes('version=')));
    const firstCalibration = provider.audit.findIndex(entry => entry.path === '/time');
    assert.ok(firstCalibration >= 0);
    for (const entry of requests) assert.ok(provider.audit.indexOf(entry) > firstCalibration, '正文请求必须发生在校准之后');

    const archive = new Archive(directory);
    const receipts = await archive.list();
    const camera = receipts.find(receipt => receipt.source.publication === 'camera');
    assert.ok(camera);
    assert.equal(JSON.parse(await archive.read(camera)).version, 'spec-1');
    await collector.stop();
  } finally { await provider.close(); await rm(directory, { recursive: true, force: true }); }
});

test('顺延不抢跑新版本，也不阻塞其他已开放场次', async () => {
  const provider = await createProvider();
  const directory = await mkdtemp(join(tmpdir(), 'postponed-'));
  try {
    const collector = await collectScheduled(provider.base, directory, { pollIntervalMs: 100 });

    await controlled(provider, { clock: 1007 });
    await collector.tick();
    let status = collector.status();
    assert.equal(status.items.sensor.status, 'received');
    assert.equal(status.items.camera.status, 'pending');
    assert.equal(publicationRequests(provider).length, 1);

    await controlled(provider, { generation: 2, clock: 1015 });
    await collector.tick();
    status = collector.status();
    assert.equal(status.items.camera.status, 'pending');
    assert.equal(status.items.camera.version, 'spec-2');
    assert.equal(status.items.camera.release, 1030);
    assert.equal(publicationRequests(provider).filter(entry => entry.path.includes('camera')).length, 0);

    await controlled(provider, { clock: 1032 });
    await collector.tick();
    status = collector.status();
    assert.equal(status.items.camera.status, 'received');
    assert.equal(status.items.camera.version, 'spec-2');
    assert.equal(status.items.camera.history.length, 0);

    const archive = new Archive(directory);
    const receipts = await archive.list();
    const camera = receipts.find(receipt => receipt.source.publication === 'camera' && receipt.source.version === 'spec-2');
    assert.ok(camera);
    assert.equal(JSON.parse(await archive.read(camera)).version, 'spec-2');
    await collector.stop();
  } finally { await provider.close(); await rm(directory, { recursive: true, force: true }); }
});

test('取消的场次留下明确状态且不请求正文', async () => {
  const provider = await createProvider();
  const directory = await mkdtemp(join(tmpdir(), 'cancelled-'));
  try {
    const collector = await collectScheduled(provider.base, directory, { pollIntervalMs: 100 });
    await controlled(provider, { mode: 'cancelled' });
    await collector.tick();
    const status = collector.status();
    assert.equal(status.items.sensor.status, 'cancelled');
    assert.equal(status.items.sensor.note, '来源已取消');
    assert.equal(status.items.camera.status, 'pending');
    assert.equal(publicationRequests(provider).length, 0);
    await collector.stop();
  } finally { await provider.close(); await rm(directory, { recursive: true, force: true }); }
});

test('校准过期且来源不可用时不确认开放、不请求正文', async () => {
  const provider = await createProvider();
  const directory = await mkdtemp(join(tmpdir(), 'uncalibrated-'));
  let now = 0;
  try {
    const collector = await collectScheduled(provider.base, directory, { pollIntervalMs: 100, now: () => now });
    await controlled(provider, { clock: 1012 });
    await provider.close();
    now = 20000;
    await collector.tick();
    const status = collector.status();
    assert.equal(status.calibrated, false);
    assert.equal(status.items.camera.status, 'pending');
    assert.match(status.items.camera.note, /无法确认开放/);
    assert.equal(publicationRequests(provider).length, 0);
    await collector.stop();
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('重启后重新校准，不凭旧状态重复领取或抢跑', async () => {
  const provider = await createProvider();
  const directory = await mkdtemp(join(tmpdir(), 'restart-'));
  try {
    await controlled(provider, { clock: 1012 });
    const first = await collectScheduled(provider.base, directory, { pollIntervalMs: 100 });
    assert.equal(first.status().items.camera.status, 'received');
    await first.stop();
    const receiptsBefore = (await new Archive(directory).list()).length;
    const requestsBefore = publicationRequests(provider).length;
    const calibrationsBefore = timeRequests(provider).length;

    const persisted = JSON.parse(await readFile(join(directory, 'collection.json'), 'utf8'));
    assert.ok(!('calibration' in persisted), '持久化状态不得包含校准');

    const second = await collectScheduled(provider.base, directory, { pollIntervalMs: 100 });
    const status = second.status();
    assert.equal(status.items.camera.status, 'received');
    assert.equal(status.items.sensor.status, 'received');
    await second.tick();
    assert.ok(timeRequests(provider).length > calibrationsBefore, '重启后必须重新校准');
    assert.equal(publicationRequests(provider).length, requestsBefore);
    assert.equal((await new Archive(directory).list()).length, receiptsBefore);
    await second.stop();
  } finally { await provider.close(); await rm(directory, { recursive: true, force: true }); }
});

test('排期版本被拒（409）后刷新排期并按新版本领取', async () => {
  const provider = await createProvider();
  const directory = await mkdtemp(join(tmpdir(), 'conflict-'));
  try {
    // 排期轮询间隔拉到最大，模拟收件方持有过期排期
    const collector = await collectScheduled(provider.base, directory, { pollIntervalMs: 100, schedulePollIntervalMs: 3_600_000 });
    await controlled(provider, { generation: 2, clock: 1032 });
    await collector.tick();
    let status = collector.status();
    assert.equal(status.items.camera.status, 'pending');
    assert.equal(status.items.camera.version, 'spec-2');

    await collector.tick();
    status = collector.status();
    assert.equal(status.items.camera.status, 'received');
    assert.equal(status.items.camera.version, 'spec-2');
    const cameraRequests = publicationRequests(provider).filter(entry => entry.path.includes('camera'));
    assert.equal(cameraRequests.length, 2);
    assert.ok(cameraRequests[0].query.includes('version=spec-1'));
    assert.ok(cameraRequests[1].query.includes('version=spec-2'));
    await collector.stop();
  } finally { await provider.close(); await rm(directory, { recursive: true, force: true }); }
});

test('领取循环持续推进已开放场次并可随时停止', async () => {
  const provider = await createProvider();
  const directory = await mkdtemp(join(tmpdir(), 'loop-'));
  try {
    const collector = await collectScheduled(provider.base, directory, { pollIntervalMs: 50 });
    const running = collector.run();
    try {
      await controlled(provider, { clock: 1012 });
      const deadline = Date.now() + 3000;
      while (collector.status().items.camera?.status !== 'received') {
        assert.ok(Date.now() < deadline, '循环未及时领取已开放场次');
        await new Promise(resolve => setTimeout(resolve, 25));
      }
      assert.equal(collector.status().items.sensor.status, 'received');
    } finally {
      await collector.stop();
      await running;
    }
  } finally { await provider.close(); await rm(directory, { recursive: true, force: true }); }
});
