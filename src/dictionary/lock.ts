import { createHash, randomUUID } from "node:crypto";
import {
  lstat,
  mkdir,
  mkdtemp,
  open,
  readdir,
  rename,
  rmdir,
} from "node:fs/promises";
import { hostname } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

const host = createHash("sha256")
  .update(`${process.platform}:${hostname()}`)
  .digest("hex");
const ownerPattern =
  /^([a-f0-9]{64})-([1-9]\d{0,9})-[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;

async function statIfPresent(path: string) {
  try {
    return await lstat(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}

async function reserveLegacyLock(
  path: string,
  deadline: number,
): Promise<void> {
  for (;;) {
    const marker = await open(path, "wx").catch(
      (error: NodeJS.ErrnoException) => {
        if (error.code !== "EEXIST" && error.code !== "EISDIR") throw error;
      },
    );
    if (marker) return marker.close();

    const existing = await statIfPresent(path);
    if (existing?.isFile() && existing.size === 0) return;
    if (existing && !existing.isDirectory())
      throw new Error(
        `Unexpected dictionary lock at ${path}; inspect it before retrying`,
      );
    if (performance.now() >= deadline)
      throw new Error(
        `Dictionary lock timeout at ${path}; pending changes remain unsaved. Close all Pi sessions using this dictionary, then remove the empty legacy lock directory`,
      );
    await delay(10);
  }
}

function windowsLockContention(code?: string): boolean {
  return process.platform === "win32" && (code === "EPERM" || code === "EBUSY");
}

async function removeLockDirectory(
  path: string,
  allowNonempty = false,
): Promise<void> {
  for (let attempt = 0; ; attempt++) {
    try {
      await rmdir(path);
      return;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (
        code === "ENOENT" ||
        (allowNonempty && (code === "ENOTEMPTY" || code === "EEXIST"))
      )
        return;
      // Windows can report a sharing error while another writer removes this directory.
      if (!windowsLockContention(code) || attempt === 4) throw error;
      await delay(10);
    }
  }
}

export async function releaseDictionaryLock(
  lock: string,
  owner?: string,
): Promise<void> {
  if (owner) await removeLockDirectory(join(lock, owner));
  // A new owner's marker arrives atomically with its directory and makes rmdir fail.
  await removeLockDirectory(lock, true);
}

async function recoverAbandonedLock(lock: string): Promise<void> {
  const existing = await statIfPresent(lock);
  if (!existing) return;
  if (!existing.isDirectory())
    throw new Error(
      `Unexpected dictionary lock at ${lock}; inspect it before retrying`,
    );

  const entries = await readdir(lock, { withFileTypes: true }).catch(
    (error: NodeJS.ErrnoException) => {
      if (error.code !== "ENOENT") throw error;
      return [];
    },
  );
  if (entries.length === 0) return releaseDictionaryLock(lock);

  const owner = entries[0];
  const stamp = ownerPattern.exec(owner.name);
  const pid = Number(stamp?.[2]);
  if (
    entries.length !== 1 ||
    !owner.isDirectory() ||
    !stamp ||
    pid > 0x7fffffff
  )
    throw new Error(
      `Unrecognized dictionary lock at ${lock}; inspect it before retrying`,
    );
  if (stamp[1] !== host) return;
  try {
    process.kill(pid, 0);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ESRCH")
      await releaseDictionaryLock(lock, owner.name);
  }
}

export async function acquireDictionaryLock(
  path: string,
  timeoutMs: number,
  onDiagnostic: (message: string) => void,
): Promise<() => Promise<void>> {
  const deadline = performance.now() + timeoutMs;
  await reserveLegacyLock(`${path}.lock`, deadline);

  const lock = `${path}.lock-v2`;
  const owner = `${host}-${process.pid}-${randomUUID()}`;
  const staging = await mkdtemp(`${lock}.stage-`);
  try {
    await mkdir(join(staging, owner));
    for (;;) {
      try {
        await rename(staging, lock);
        return () => releaseDictionaryLock(lock, owner);
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (
          code !== "EEXIST" &&
          code !== "ENOTEMPTY" &&
          !windowsLockContention(code)
        )
          throw error;
        await recoverAbandonedLock(lock).catch(
          (recoveryError: NodeJS.ErrnoException) => {
            if (!windowsLockContention(recoveryError.code)) throw recoveryError;
          },
        );
        if (performance.now() >= deadline)
          throw new Error(
            `Dictionary lock timeout at ${lock}; pending changes remain unsaved. If it persists, close all Pi sessions using this dictionary before inspecting the lock`,
            { cause: error },
          );
        await delay(10);
      }
    }
  } catch (error) {
    await releaseDictionaryLock(staging, owner).catch((cleanupError) =>
      onDiagnostic(
        `Dictionary lock staging cleanup failed at ${staging}: ${String(cleanupError)}`,
      ),
    );
    throw error;
  }
}
