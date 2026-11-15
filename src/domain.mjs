import { capture } from './client.mjs';
import { ScheduledCollector } from './scheduler.mjs';

export async function receiveCurrent(base, directory) {
 const { bytes, receipt } = await capture(base + '/schedule', directory);
 const data = JSON.parse(bytes);
 return { receipt: receipt.id, revision: data.revision, publications: data.publications };
}

export async function collectScheduled(base, directory, options = {}) {
  const collector = new ScheduledCollector({ base, directory, ...options });
  await collector.start();
  return collector;
}
