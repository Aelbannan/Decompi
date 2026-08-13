/**
 * Child process for the cross-process claim race test (tests/daemon.test.ts
 * "two real processes race claims on one SQLite file"). Spawned with
 * `node --import tsx <this-file> <db> <go-file> <ready-file> <owner> <epoch> <count>`.
 *
 * Opens the store file (applying the adapter's WAL + busy_timeout pragmas),
 * signals readiness, then spins on the `go` file so both children release as
 * close to simultaneously as the OS allows — making the per-item INSERTs
 * genuinely overlap across processes. It then claims items `wi_0..wi_N-1`
 * and prints one JSON line: `{"ok": [boolean, ...]}` on success or
 * `{"error": "<message>"}` on failure (e.g. an unhandled SQLITE_BUSY).
 */
import { existsSync, writeFileSync } from "node:fs";
import { SqliteAdapter } from "../../src/core/store/sqlite.js";
import { ClaimStore } from "../../src/target/claim.js";

const [file, goFile, readyFile, owner, epoch, countArg] = process.argv.slice(2);
const itemCount = Number(countArg);

async function main(): Promise<void> {
  const db = new SqliteAdapter(file);
  try {
    const store = new ClaimStore(db);
    writeFileSync(readyFile, "ready");
    // Synchronous spin: the tightest release the OS allows.
    while (!existsSync(goFile)) {
      // busy-wait for the parent's go signal
    }
    const ok: boolean[] = [];
    for (let i = 0; i < itemCount; i++) {
      const won = await store.claim({
        workItemId: `wi_${i}`,
        owner,
        epoch,
        ttlMs: 60_000,
      });
      ok.push(won);
    }
    process.stdout.write(JSON.stringify({ ok }));
  } catch (err) {
    process.stdout.write(
      JSON.stringify({ error: err instanceof Error ? err.message : String(err) }),
    );
  } finally {
    db.close();
  }
}

void main();
