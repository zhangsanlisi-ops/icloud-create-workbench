import { createHash, randomBytes } from "node:crypto";

/** 计算公开访问密钥的不可逆哈希。 */
function hashToken(token) {
  return createHash("sha256").update(String(token)).digest("hex");
}

/** 创建隐私邮箱公开邮件访问服务。 */
export function createPublicMailService({ config, repositories, inboxService }) {
  const onDemandSyncStartedAt = new Map();
  const onDemandSyncInFlight = new Map();
  const onDemandSyncLastWarnAt = new Map();
  const ON_DEMAND_SYNC_THROTTLE_MS = Math.max(5_000, Number(config.inboxSyncIntervalSeconds || 10) * 1000);
  const FORCE_SYNC_THROTTLE_MS = 5_000;
  const ON_DEMAND_SYNC_WARN_THROTTLE_MS = 60_000;

  function boundedWait(promise, waitMs) {
    const ms = Math.max(0, Math.min(15_000, Number(waitMs || 0)));
    if (!ms || !promise) return Promise.resolve(false);
    return Promise.race([
      promise.then(() => true, () => false),
      new Promise(resolve => setTimeout(() => resolve(false), ms))
    ]);
  }

  function warnOnDemandSync(accountId, error) {
    if (Number(error?.status) === 409) return;
    const now = Date.now();
    const lastWarnAt = onDemandSyncLastWarnAt.get(accountId) || 0;
    if (now - lastWarnAt < ON_DEMAND_SYNC_WARN_THROTTLE_MS) return;
    onDemandSyncLastWarnAt.set(accountId, now);
    const details = Array.isArray(error?.errors)
      ? `: ${error.errors.map(item => item?.message || item).filter(Boolean).join("; ")}`
      : "";
    console.warn(`public mail on-demand sync failed: ${error?.message || error}${details}`);
  }

  async function syncIfDue(result, options = {}) {
    if (!result?.accountId || !inboxService) return;
    const accountId = result.accountId;
    const stored = repositories.getInboxConfigInternal(accountId);
    if (!stored?.password_encrypted) return;
    const now = Date.now();
    const next = new Date(stored.next_sync_at || 0).getTime();
    const lastStarted = onDemandSyncStartedAt.get(accountId) || 0;
    const forceSync = Boolean(options.forceSync);
    const waitMs = forceSync ? (Number(options.waitMs || 8_000) || 8_000) : Number(options.waitMs || 0);
    if (!forceSync && next && next > now) return;
    const inFlight = onDemandSyncInFlight.get(accountId);
    if (inFlight) {
      await boundedWait(inFlight, waitMs);
      return;
    }
    const throttleMs = forceSync ? FORCE_SYNC_THROTTLE_MS : ON_DEMAND_SYNC_THROTTLE_MS;
    if (now - lastStarted < throttleMs) return;
    onDemandSyncStartedAt.set(accountId, now);
    const promise = inboxService.sync(accountId, { forceRecent: forceSync })
      .catch(error => warnOnDemandSync(accountId, error))
      .finally(() => onDemandSyncInFlight.delete(accountId));
    onDemandSyncInFlight.set(accountId, promise);
    await boundedWait(promise, waitMs);
  }

  function toPublicResult(result) {
    if (!result) return null;
    return { email: result.email, message: result.message };
  }

  /** 为邮箱生成或轮换一次性展示的公开访问密钥。 */
  function createAccess(addressId) {
    const address = repositories.getAddress(addressId);
    if (!address) throw Object.assign(new Error("邮箱不存在"), { status: 404 });
    const token = randomBytes(32).toString("base64url");
    repositories.savePublicAccess(addressId, hashToken(token));
    const encodedEmail = encodeURIComponent(address.email);
    return {
      token,
      apiUrl: `${config.appOrigin}/openapi/mail/${encodedEmail}/${token}/latest`,
      viewerUrl: `${config.appOrigin}/mail/${encodedEmail}/${token}`
    };
  }

  /** 撤销指定邮箱的公开访问。 */
  function revokeAccess(addressId) {
    if (!repositories.getAddress(addressId)) throw Object.assign(new Error("邮箱不存在"), { status: 404 });
    repositories.revokePublicAccess(addressId);
    return { ok: true };
  }

  /** 使用邮箱和公开密钥读取最新邮件。 */
  async function getLatest(email, token, options = {}) {
    if (!email || !token || String(token).length < 32) return null;
    const tokenHash = hashToken(token);
    const first = repositories.getLatestPublicMail(email, tokenHash);
    if (!first) return null;
    await syncIfDue(first, options);
    return toPublicResult(repositories.getLatestPublicMail(email, tokenHash));
  }

  return { createAccess, revokeAccess, getLatest };
}
