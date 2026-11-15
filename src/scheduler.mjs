import { mkdir, open, readFile, rename } from 'node:fs/promises';
import { join } from 'node:path';
import { Archive } from './archive.mjs';
import { fetchLimited } from './client.mjs';

// 定时领取的核心约束（对应 docs/source-contract.md）：
// - 正文请求不作为计时探针：只有当前有效的校准证明来源时间已过 release，才允许请求正文。
// - 开放许可只适用于对应排期版本：版本或开放时间变化后，必须按新排期重新确认。
// - 校准不持久化：宿主单调时钟基点每次启动都不同，重启后必须重新向 /time 校准，
//   旧计时器不能在新进程里直接触发领取。
export class ScheduledCollector {
  constructor({ base, directory, pollIntervalMs = 1000, schedulePollIntervalMs = 0, now = () => performance.now() } = {}) {
    if (!base) throw new Error('缺少来源地址');
    if (!directory) throw new Error('缺少收件目录');
    this.base = base;
    this.directory = directory;
    this.pollIntervalMs = pollIntervalMs;
    this.schedulePollIntervalMs = schedulePollIntervalMs;
    this._now = now;
    this._archive = new Archive(directory);
    this._statePath = join(directory, 'collection.json');
    this._state = { revision: null, epoch: null, scheduleReceipt: null, items: {} };
    this._calibration = null;
    this._nextSchedulePollMono = 0;
    this._running = false;
    this._abort = null;
    this._calibrationNote = null;
    this._scheduleNote = null;
  }

  async start() {
    await this._load();
    await this.tick();
    return this;
  }

  async tick() {
    const now = this._now();
    await this._ensureCalibration(now);
    if (now >= this._nextSchedulePollMono) await this._pollSchedule();
    const window = this._sourceWindow(this._now());
    const due = [];
    for (const item of Object.values(this._state.items)) {
      if (item.status !== 'pending') continue;
      if (!window) { item.note = '校准不可用，无法确认开放'; continue; }
      if (window.lower >= item.release) due.push(item);
      else item.note = '等待开放确认';
    }
    // 各场次独立领取：顺延的场次只保持 pending，不会挡住其他已开放场次。
    await Promise.all(due.map(item => this._collect(item)));
    await this._save();
    return this._nextWakeDelay(this._now());
  }

  async run({ signal } = {}) {
    if (this._running) throw new Error('领取循环已在运行');
    this._running = true;
    this._abort = new AbortController();
    try {
      while (!this._abort.signal.aborted && !signal?.aborted) {
        let delay;
        try { delay = await this.tick(); }
        catch { delay = this.pollIntervalMs; }
        await sleep(Math.max(20, delay), this._abort.signal);
      }
    } finally {
      this._running = false;
      await this._save();
    }
  }

  async stop() { this._abort?.abort(); }

  status() {
    const window = this._sourceWindow(this._now());
    return {
      revision: this._state.revision,
      calibrated: window !== null,
      sourceWindow: window ? { lower: window.lower, upper: window.upper } : null,
      notes: { calibration: this._calibrationNote, schedule: this._scheduleNote },
      items: structuredClone(this._state.items),
    };
  }

  // 每次 tick 都重新校准，保证时间依据持续有效；网络耗时计入区间上界的不确定性。
  async _ensureCalibration(now) {
    try {
      const t0 = this._now();
      const { response, bytes } = await fetchLimited(this.base + '/time');
      const t1 = this._now();
      if (!response.ok) throw new Error(`时间依据响应异常：${response.status}`);
      const data = JSON.parse(bytes.toString('utf8'));
      if (typeof data.lower !== 'number' || typeof data.upper !== 'number' ||
          typeof data.validFor !== 'number' || typeof data.epoch !== 'string') {
        throw new Error('时间依据格式无效');
      }
      if (this._state.epoch && data.epoch !== this._state.epoch) this._nextSchedulePollMono = 0;
      const rttSeconds = Math.max(0, t1 - t0) / 1000;
      this._calibration = {
        epoch: data.epoch,
        monoBase: t1,
        lower: data.lower,
        upper: data.upper + rttSeconds,
        validUntilMono: t0 + data.validFor * 1000,
      };
      this._state.epoch = data.epoch;
      this._calibrationNote = null;
    } catch (error) {
      // 刷新失败时，未过期的旧校准仍可使用；已过期则不再证明任何开放。
      if (!this._calibration || this._calibration.validUntilMono <= now) this._calibration = null;
      this._calibrationNote = '校准失败：' + error.message;
    }
  }

  _sourceWindow(now) {
    const calibration = this._calibration;
    if (!calibration || now > calibration.validUntilMono) return null;
    const delta = (now - calibration.monoBase) / 1000;
    return { lower: calibration.lower + delta, upper: calibration.upper + delta };
  }

  async _pollSchedule() {
    this._nextSchedulePollMono = this._now() + this.schedulePollIntervalMs;
    let response, bytes;
    try {
      ({ response, bytes } = await fetchLimited(this.base + '/schedule'));
      if (!response.ok) throw new Error(`排期响应异常：${response.status}`);
    } catch (error) {
      this._scheduleNote = '排期获取失败：' + error.message;
      return;
    }
    const data = JSON.parse(bytes.toString('utf8'));
    if (!Array.isArray(data.publications)) { this._scheduleNote = '排期格式无效'; return; }
    if (data.revision !== this._state.revision) {
      const receipt = await this._archive.save(bytes, {
        url: this.base + '/schedule', status: response.status,
        type: response.headers.get('content-type'), revision: data.revision ?? null,
      });
      this._state.revision = data.revision ?? null;
      this._state.scheduleReceipt = receipt.id;
    }
    this._applySchedule(data.publications);
    this._scheduleNote = null;
  }

  _applySchedule(publications) {
    for (const pub of publications) {
      if (!pub || typeof pub.id !== 'string') continue;
      let item = this._state.items[pub.id];
      if (!item) {
        item = this._state.items[pub.id] = {
          id: pub.id, status: 'pending', note: '等待开放确认',
          release: null, version: null, receipt: null, digest: null, history: [],
        };
      }
      if (pub.status === 'cancelled') {
        if (item.status === 'received' && item.version === pub.version) {
          item.note = '已领取，来源后续取消';
        } else {
          if (item.status === 'received' && item.receipt) {
            item.history.push({ version: item.version, receipt: item.receipt, digest: item.digest });
          }
          item.status = 'cancelled';
          item.receipt = null;
          item.digest = null;
          item.note = '来源已取消';
        }
      } else if (item.version !== pub.version) {
        // 排期版本已变化：旧版本的领取许可不适用于新版本，已收旧版本移入历史。
        if (item.status === 'received' && item.receipt) {
          item.history.push({ version: item.version, receipt: item.receipt, digest: item.digest });
        }
        item.status = 'pending';
        item.receipt = null;
        item.digest = null;
        item.note = '等待开放确认';
      } else if (item.status === 'cancelled') {
        item.status = 'pending';
        item.note = '等待开放确认';
      }
      item.release = pub.release;
      item.version = pub.version;
    }
  }

  async _collect(item) {
    // 请求前再次核验：没有当前有效的校准证明已开放，就不发出正文请求。
    const window = this._sourceWindow(this._now());
    if (!window || window.lower < item.release) {
      item.note = '开放许可已失效，等待重新校准';
      return;
    }
    const url = `${this.base}/publication/${encodeURIComponent(item.id)}?version=${encodeURIComponent(item.version)}`;
    let response, bytes;
    try {
      ({ response, bytes } = await fetchLimited(url));
    } catch (error) {
      item.note = '领取失败：' + error.message;
      return;
    }
    if (response.status === 200) {
      const receipt = await this._archive.save(bytes, {
        url, status: response.status, type: response.headers.get('content-type'),
        publication: item.id, version: item.version, release: item.release, revision: this._state.revision,
      });
      item.status = 'received';
      item.receipt = receipt.id;
      item.digest = receipt.digest;
      item.note = '已领取';
    } else if (response.status === 410) {
      item.status = 'cancelled';
      item.note = '来源已取消';
    } else if (response.status === 409) {
      item.note = '排期版本已变化，刷新排期后重新确认';
      await this._pollSchedule();
    } else if (response.status === 425) {
      // 校准与来源时钟不一致：放弃当前校准，下一 tick 重新校准，而不是反复试探。
      this._calibration = null;
      item.note = '来源仍未开放，重新校准时间依据';
    } else {
      item.note = `领取失败：${response.status}`;
    }
  }

  _nextWakeDelay(now) {
    let next = now + this.pollIntervalMs;
    const window = this._sourceWindow(now);
    if (window) {
      for (const item of Object.values(this._state.items)) {
        if (item.status !== 'pending' || typeof item.release !== 'number') continue;
        next = Math.min(next, now + Math.max(0, (item.release - window.lower) * 1000));
      }
    }
    if (this._calibration) next = Math.min(next, Math.max(now, this._calibration.validUntilMono));
    return Math.max(0, next - now);
  }

  async _load() {
    let data;
    try {
      data = JSON.parse(await readFile(this._statePath, 'utf8'));
    } catch (error) {
      if (error.code === 'ENOENT') return;
      throw error;
    }
    // 只恢复排期与场次状态；校准留在内存里，重启后必须重新获得。
    this._state.revision = data.revision ?? null;
    this._state.epoch = data.epoch ?? null;
    this._state.scheduleReceipt = data.scheduleReceipt ?? null;
    this._state.items = data.items ?? {};
  }

  async _save() {
    await mkdir(this.directory, { recursive: true });
    const staging = this._statePath + '.pending';
    const handle = await open(staging, 'w', 0o600);
    try {
      await handle.writeFile(JSON.stringify({
        revision: this._state.revision,
        epoch: this._state.epoch,
        scheduleReceipt: this._state.scheduleReceipt ?? null,
        items: this._state.items,
      }, null, 2));
      await handle.sync();
    } finally {
      await handle.close();
    }
    await rename(staging, this._statePath);
  }
}

function sleep(ms, signal) {
  return new Promise(resolve => {
    const timer = setTimeout(cleanup, ms);
    function cleanup() {
      clearTimeout(timer);
      signal?.removeEventListener('abort', cleanup);
      resolve();
    }
    signal?.addEventListener('abort', cleanup, { once: true });
  });
}
