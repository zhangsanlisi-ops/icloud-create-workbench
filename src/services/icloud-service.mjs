import { decryptSecret, encryptSecret } from "../security.mjs";
import { accountIdentityKey } from "../repositories.mjs";

/** 创建 iCloud 账号与生成任务服务。 */
export function createIcloudService({ config, repositories, callBridge }) {
  /** 判断错误是否表示当前 CK 的全局会话已经失效。 */
  function isExpiredSessionError(message) {
    const text = String(message || "");
    if (isTransientNetworkError(text)) return false;
    return /invalid global session|session.*expired|global session|unauthorized|forbidden|401|403|CK\s*已失效/i.test(text);
  }

  /** 判断错误是否只是网络、代理、TLS 或 Apple 节点瞬时不可达。 */
  function isTransientNetworkError(message) {
    return /Cannot connect|connect.*failed|timed out|timeout|ECONN|ENOTFOUND|EAI_AGAIN|拒绝访问|CERTIFICATE_VERIFY_FAILED|certificate verify failed|self-signed certificate|ssl:default|ssl:True|Request timed out/i
      .test(String(message || ""));
  }

  /** 将会话失效错误转换为统一的 CK 过期业务错误。 */
  function toExpiredAccountError(accountId, error) {
    repositories.markAccountExpired(accountId);
    return Object.assign(new Error(error.message || "CK 已失效，请先更新 CK"), { status: 410, accountExpired: true });
  }

  /** 拒绝继续使用已经过期的 CK 执行敏感操作。 */
  function ensureAccountActive(account) {
    if (account.status === "expired") {
      throw Object.assign(new Error("CK 已过期，请先更新 CK"), { status: 409, accountExpired: true });
    }
  }

  /** 校验 CK 并转换为可持久化账号数据。 */
  async function prepareAccount(cookieInput, region = "auto") {
    if (!String(cookieInput || "").trim()) throw Object.assign(new Error("CK 不能为空"), { status: 400 });
    let checked;
    try {
      checked = await callBridge(config, "validate", { cookie: cookieInput, region });
    } catch (error) {
      throw Object.assign(new Error(error.message), { status: 400 });
    }
    if (!checked.featureAvailable) throw Object.assign(new Error("该 Apple ID 未检测到隐藏邮箱功能"), { status: 400 });
    const identityKey = accountIdentityKey(checked.region, checked.dsid, checked.appleId);
    return {
      identityKey,
      appleId: checked.appleId,
      dsid: checked.dsid,
      displayName: checked.displayName,
      region: checked.region,
      userPartition: checked.userPartition,
      maildomainHost: checked.maildomainHost,
      cookieEncrypted: encryptSecret(checked.cookie, config.encryptionKey)
    };
  }

  /** 导入并持久化一条 CK。 */
  async function importAccount(cookieInput, region) {
    return repositories.upsertAccount(await prepareAccount(cookieInput, region));
  }

  /** 更新指定账号的 CK，并确保它仍代表同一账号。 */
  async function updateCookie(accountId, cookieInput, region) {
    const existing = repositories.getAccountInternal(accountId);
    if (!existing || existing.status === "deleted") throw Object.assign(new Error("账号不存在"), { status: 404 });
    const prepared = await prepareAccount(cookieInput, region);
    if (prepared.identityKey !== existing.identity_key) {
      throw Object.assign(new Error(`新 CK 不属于当前 Apple ID：当前=${existing.apple_id || "(未知)"} / ${existing.region}:${existing.dsid || ""}，CK检测到=${prepared.appleId || "(未知)"} / ${prepared.region}:${prepared.dsid || ""}`), { status: 409 });
    }
    return repositories.updateAccountCookie(accountId, prepared);
  }

  /** 请求 Apple 校验已保存 CK，并持久化有效或过期状态。 */
  async function checkCookie(accountId) {
    const { account, cookie } = accountWithCookie(accountId);
    try {
      const prepared = await prepareAccount(cookie, account.region);
      if (prepared.identityKey !== account.identity_key) throw new Error("CK 返回的 Apple ID 与当前账号不一致");
      repositories.updateAccountCookie(accountId, prepared);
      return { valid: true, account: repositories.getAccount(accountId) };
    } catch (error) {
      if (isExpiredSessionError(error.message)) repositories.markAccountExpired(accountId);
      return { valid: false, error: error.message, account: repositories.getAccount(accountId) };
    }
  }

  /** 解密账号 CK，仅供受控的 Python 桥接调用。 */
  function accountWithCookie(accountId) {
    const account = repositories.getAccountInternal(accountId);
    if (!account || account.status === "deleted" || !account.cookie_encrypted) {
      throw Object.assign(new Error("账号不存在或 CK 已删除"), { status: 404 });
    }
    return { account, cookie: decryptSecret(account.cookie_encrypted, config.encryptionKey) };
  }

  /** 从 Apple 同步已有隐藏邮箱。 */
  async function syncAddresses(accountId) {
    const { account, cookie } = accountWithCookie(accountId);
    ensureAccountActive(account);
    let result;
    try {
      result = await callBridge(config, "list", {
        cookie,
        region: account.region,
        maildomainHost: account.maildomain_host
      });
    } catch (error) {
      if (isExpiredSessionError(error.message)) throw toExpiredAccountError(accountId, error);
      throw Object.assign(new Error(error.message), { status: 400 });
    }
    const activeRows = result.addresses.filter(item => item.active);
    repositories.updateMaildomainHost(accountId, result.maildomainHost);
    repositories.upsertAddresses(accountId, null, activeRows, "synced");
    return { synced: activeRows.length };
  }

  /** 创建并同步执行一批生成任务。 */
  async function generate(accountId, requestedCount, requestedPrefix) {
    const { account, cookie } = accountWithCookie(accountId);
    ensureAccountActive(account);
    const count = Number(requestedCount || config.batchLimit);
    if (!Number.isInteger(count) || count < 1 || count > config.batchLimit) {
      throw Object.assign(new Error(`每批只能生成 1-${config.batchLimit} 个`), { status: 400 });
    }
    if (repositories.hasRunningJob(accountId)) {
      throw Object.assign(new Error("该账号已有生成任务运行中"), { status: 409 });
    }
    if (account.cooldown_until && new Date(account.cooldown_until).getTime() > Date.now()) {
      throw Object.assign(new Error("该账号仍处于生成冷却期"), { status: 409, cooldownUntil: account.cooldown_until });
    }
    const prefix = String(requestedPrefix || account.label_prefix || "changsheng").trim();
    if (!/^[A-Za-z0-9_-]{1,24}$/.test(prefix)) {
      throw Object.assign(new Error("标签前缀只能包含字母、数字、下划线和短横线，最长 24 位"), { status: 400 });
    }
    const { job, labels } = repositories.createJobWithLabels(accountId, prefix, count);
    repositories.startJob(job.id);
    let result;
    try {
      result = await callBridge(config, "generate", {
        cookie,
        region: account.region,
        maildomainHost: account.maildomain_host,
        labels
      }, Math.max(90_000, count * 45_000));
    } catch (error) {
      if (isExpiredSessionError(error.message)) {
        // CK 失效时先结束已创建的批次，避免遗留 running 任务阻塞后续操作。
        repositories.finishJob(job.id, accountId, {
          generated: [],
          errors: [{ label: labels[0], error: error.message }]
        }, config.cooldownMinutes);
        throw toExpiredAccountError(accountId, error);
      }
      result = { generated: [], errors: [{ label: labels[0], error: error.message }] };
    }
    repositories.upsertAddresses(accountId, job.id, result.generated, "generated");
    repositories.updateMaildomainHost(accountId, result.maildomainHost);
    const finished = repositories.finishJob(job.id, accountId, result, config.cooldownMinutes);
    return { jobId: job.id, ...finished, generated: result.generated, errors: result.errors };
  }

  /** 先删除 Apple 侧别名，成功后才移除对应本地库存记录。 */
  async function deleteAddresses(ids) {
    const rows = repositories.getAddressesForAppleDeletion(ids);
    const foundIds = new Set(rows.map(row => row.id));
    const failed = ids.filter(id => !foundIds.has(id)).map(id => ({ id, error: "邮箱不存在或所属 CK 已删除" }));
    const groups = new Map();
    for (const row of rows) {
      if (!row.anonymousId) {
        failed.push({ id: row.id, email: row.email, error: "缺少 Apple 匿名标识，请先在 CK 页面同步邮箱" });
        continue;
      }
      const group = groups.get(row.accountId) || [];
      group.push(row);
      groups.set(row.accountId, group);
    }
    const deletedIds = [];
    for (const [accountId, addresses] of groups) {
      try {
        const { account, cookie } = accountWithCookie(accountId);
        ensureAccountActive(account);
        const result = await callBridge(config, "delete", {
          cookie, region: account.region, maildomainHost: account.maildomain_host, addresses
        }, Math.max(90_000, addresses.length * 30_000));
        repositories.updateMaildomainHost(accountId, result.maildomainHost);
        deletedIds.push(...result.deletedIds);
        failed.push(...result.failed);
      } catch (error) {
        if (isExpiredSessionError(error.message)) {
          try { throw toExpiredAccountError(accountId, error); } catch (accountError) { error = accountError; }
        }
        failed.push(...addresses.map(address => ({ id: address.id, email: address.email, error: error.message })));
      }
    }
    const deleted = repositories.deleteAddresses(deletedIds);
    return { deleted, failed };
  }

  return { importAccount, updateCookie, checkCookie, syncAddresses, generate, deleteAddresses };
}
