import test from "node:test";
import assert from "node:assert/strict";
import { waitForCredentialKeyPersistence } from "../src/main/services/credential-persistence";
test("Windows credential save waits for Chromium OS key on disk, not only encryption success", async () => {
  let reads = 0,
    sleeps = 0;
  await waitForCredentialKeyPersistence("unused", "win32", {
    readState: async () => {
      reads++;
      if (reads === 1)
        throw Object.assign(Error("not committed"), { code: "ENOENT" });
      if (reads === 2) return "{}";
      if (reads === 3) return '{"os_crypt":{"encrypted_key":""}}';
      return '{"os_crypt":{"encrypted_key":"synthetic-protected-key"}}';
    },
    sleep: async () => {
      sleeps++;
    },
  });
  assert.equal(reads, 4);
  assert.equal(sleeps, 3);
});
test("Uncommitted Windows key rejects save; other OS does not depend on Local State", async () => {
  await assert.rejects(
    waitForCredentialKeyPersistence("unused", "win32", {
      timeoutMs: 0,
      readState: async () => '{"os_crypt":{}}',
    }),
    /未持久化/,
  );
  let reads = 0;
  await waitForCredentialKeyPersistence("unused", "darwin", {
    readState: async () => {
      reads++;
      throw Error("must not read");
    },
  });
  assert.equal(reads, 0);
});
