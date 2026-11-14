import { capture } from './client.mjs';
export async function receiveCurrent(base, directory) {
 const { bytes, receipt } = await capture(base + '/schedule', directory);
 const data = JSON.parse(bytes);
 return { receipt: receipt.id, revision: data.revision, publications: data.publications };
}
