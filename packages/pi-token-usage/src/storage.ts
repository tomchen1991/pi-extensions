import { link, mkdir, open, unlink } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import type { UsageRecord } from "./record.js";

/** Complete files only: a same-filesystem hard link publishes without overwriting. */
export async function storeRecord(root: string, record: UsageRecord): Promise<void> {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:00:00\.000Z$/.test(record.hourStart) ||
      !/^[a-f0-9-]{36}$/.test(record.id)) throw new Error("INVALID_STORAGE_KEY");
  const dir = join(root, "events", record.hourStart.slice(0, 10), record.hourStart.slice(11, 13));
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const target = join(dir, `${record.id}.json`);
  const temporary = join(dir, `.${record.id}.${randomUUID()}.tmp`);
  const file = await open(temporary, "wx", 0o600);
  try {
    try {
      await file.writeFile(`${JSON.stringify(record)}\n`, "utf8");
      await file.sync();
    } finally {
      await file.close();
    }
    await link(temporary, target);
  } finally {
    await unlink(temporary);
  }
}
