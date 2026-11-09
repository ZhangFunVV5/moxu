import { readFile } from "node:fs/promises";
import path from "node:path";
/** Windows safeStorage uses a profile AES key which Chromium writes asynchronously.
 * A readable encrypted config is not durable until that OS-protected key is on disk.
 * Do not edit Local State: wait for Chromium to commit its own preferences instead.
 */
export async function waitForCredentialKeyPersistence(
  userData: string,
  platform: NodeJS.Platform = process.platform,
  options: {
    timeoutMs?: number;
    readState?: () => Promise<string>;
    sleep?: () => Promise<void>;
  } = {},
): Promise<void> {
  if (platform !== "win32") return;
  const readState =
    options.readState ??
    (() => readFile(path.join(userData, "Local State"), "utf8"));
  const sleep =
    options.sleep ?? (() => new Promise((resolve) => setTimeout(resolve, 50)));
  const deadline = Date.now() + (options.timeoutMs ?? 15000);
  for (;;) {
    try {
      const state = JSON.parse(await readState());
      if (
        typeof state?.os_crypt?.encrypted_key === "string" &&
        state.os_crypt.encrypted_key.length > 0
      )
        return;
    } catch {}
    if (Date.now() >= deadline)
      throw new Error("系统加密主密钥尚未持久化，模型设置未保存，请稍后重试");
    await sleep();
  }
}
