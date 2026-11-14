import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createProvider } from '../provider/server.mjs';
import { receiveCurrent } from '../src/domain.mjs';
import { Archive } from '../src/archive.mjs';

async function controlled(provider, change) {
  const response = await fetch(provider.base + '/_control', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(change) });
  assert.equal(response.status, 200);
}

test('现有业务入口真实收存来源资料并可重新打开', async () => {
  const provider = await createProvider();
  const directory = await mkdtemp(join(tmpdir(), 'business-'));
  try {
    const result = await receiveCurrent(provider.base, directory);
    assert.ok(result);
    const archive = new Archive(directory);
    const receipts = await archive.list();
    assert.ok(receipts.length > 0);
    for (const receipt of receipts) assert.ok((await archive.read(receipt)).length > 0);
    assert.ok(provider.audit.some(request => !request.path.startsWith('/_')));
  } finally { await provider.close(); await rm(directory, { recursive: true, force: true }); }
});

test('来源时钟给区间而非单个本机时间', async () => {
 const provider = await createProvider();
 try {
const clock=await(await fetch(provider.base+'/time')).json();assert.ok(clock.lower<clock.upper);assert.equal(clock.epoch,'show-clock');
 } finally { await provider.close(); }
});

test('发布前没有可领取正文', async () => {
 const provider = await createProvider();
 try {
assert.equal((await fetch(provider.base+'/publication/camera?version=spec-1')).status,425);await controlled(provider,{clock:1012});assert.equal((await fetch(provider.base+'/publication/camera?version=spec-1')).status,200);
 } finally { await provider.close(); }
});

test('临时顺延和取消可以独立发生', async () => {
 const provider = await createProvider();
 try {
await controlled(provider,{generation:2,clock:1015,mode:'cancelled'});assert.equal((await fetch(provider.base+'/publication/camera?version=spec-2')).status,425);assert.equal((await fetch(provider.base+'/publication/sensor?version=sensor-1')).status,410);
 } finally { await provider.close(); }
});
