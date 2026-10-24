import { ImapFlow } from "imapflow";
import { simpleParser } from "mailparser";
import { decryptSecret, encryptSecret } from "../security.mjs";

/** 从邮件文本中提取常见验证码。 */
export function extractCode(text) {
  const content = String(text || "");
  const patterns = [
    /(?:验证码|校验码|动态码|登录代码|認証コード|ログインコード|verification code|security code|login code|temporary code|OTP)[^0-9]{0,40}([0-9]{4,8})/i,
    /\b([0-9]{6})\b/
  ];
  for (const pattern of patterns) {
    const match = content.match(pattern);
    if (match) {
      const code = match[1].toUpperCase();
      if (/^([0-9])\1{3,7}$/.test(code)) continue;
      return code;
    }
  }
  return "";
}

/** 规范化邮件内联资源 Content-ID，便于匹配 cid: 引用。 */
function normalizeCid(value) {
  const raw = String(value || "").trim().replace(/^<|>$/g, "");
  if (!raw) return "";
  try {
    return decodeURIComponent(raw).toLowerCase();
  } catch {
    return raw.toLowerCase();
  }
}

/** 将 HTML 中的 cid: 内联图片替换为浏览器可直接显示的 data URL。 */
export function inlineAttachmentCidImages(html, attachments) {
  const sourceHtml = String(html || "");
  if (!sourceHtml || !Array.isArray(attachments) || !attachments.length) return sourceHtml;
  const cidToDataUrl = new Map();
  for (const attachment of attachments) {
    const cid = normalizeCid(attachment?.contentId);
    const contentType = String(attachment?.contentType || "");
    if (!cid || !contentType.startsWith("image/") || !Buffer.isBuffer(attachment?.content)) continue;
    cidToDataUrl.set(cid, `data:${contentType};base64,${attachment.content.toString("base64")}`);
  }
  if (!cidToDataUrl.size) return sourceHtml;
  return sourceHtml.replace(/cid:([^"')\s>]+)/gi, (full, cidValue) => {
    const dataUrl = cidToDataUrl.get(normalizeCid(cidValue));
    return dataUrl || full;
  });
}

/** 创建全局 IMAP 收件服务。 */
export function createInboxService({ config, repositories }) {
  const activeSyncs = new Set();

  /** 计算下一次后台同步时间。 */
  function nextSyncAt() {
    return new Date(Date.now() + config.inboxSyncIntervalSeconds * 1000).toISOString();
  }

  /** 返回不包含密码的 IMAP 配置。 */
  function getConfig(accountId) {
    const stored = repositories.getInboxConfigInternal(accountId);
    if (!stored) return { configured: false };
    return {
      configured: Boolean(stored.host && stored.email && stored.password_encrypted),
      host: stored.host,
      port: stored.port,
      secure: Boolean(stored.secure),
      email: stored.email,
      mailbox: stored.mailbox,
      hasPassword: Boolean(stored.password_encrypted),
      lastSyncAt: stored.last_sync_at || "",
      nextSyncAt: stored.next_sync_at || "",
      lastError: stored.last_error || ""
    };
  }

  /** 校验并保存 IMAP 配置，密码为空时保留旧密码。 */
  function saveConfig(accountId, input) {
    const account = repositories.getAccountInternal(accountId);
    if (!account || account.status === "deleted") throw Object.assign(new Error("CK 账号不存在"), { status: 404 });
    const existing = repositories.getInboxConfigInternal(accountId);
    const host = String(input.host || "").trim();
    const email = String(input.email || "").trim();
    const port = Number(input.port || 993);
    if (!host || !email || !Number.isInteger(port)) throw Object.assign(new Error("IMAP 主机、端口和邮箱不能为空"), { status: 400 });
    const passwordEncrypted = input.password
      ? encryptSecret(String(input.password), config.encryptionKey)
      : existing?.password_encrypted;
    if (!passwordEncrypted) throw Object.assign(new Error("首次配置必须填写 IMAP 密码或授权码"), { status: 400 });
    const mailbox = String(input.mailbox || "INBOX").trim() || "INBOX";
    const connectionChanged = !existing || existing.host !== host || existing.port !== port
      || existing.email !== email || existing.mailbox !== mailbox || Boolean(existing.secure) !== (input.secure !== false);
    repositories.saveInboxConfig(accountId, {
      host,
      port,
      secure: input.secure !== false,
      email,
      passwordEncrypted,
      mailbox
    });
    if (connectionChanged) repositories.resetInboxSyncState(accountId);
    return getConfig(accountId);
  }

  /** 在邮件原文中匹配已知隐藏邮箱地址。 */
  function matchHiddenAddress(accountId, text) {
    const lower = String(text || "").toLowerCase();
    return repositories.listAddresses({ accountId }).find(item => lower.includes(item.email.toLowerCase()))?.email || "";
  }

  /** 选择需要同步的文件夹：收件箱、垃圾邮件，以及 QQ/163 常见分类箱。 */
  function selectSyncMailboxes(boxes, configuredMailbox) {
    const selected = new Set([configuredMailbox || "INBOX"]);
    for (const box of boxes || []) {
      const path = String(box.path || "");
      const specialUse = String(box.specialUse || "");
      if (!path) continue;
      if (/\\(Inbox|Junk)/i.test(specialUse)) selected.add(path);
      if (/(junk|spam|垃圾|广告|推广|订阅)/i.test(path)) selected.add(path);
    }
    return [...selected].filter(path => !/(sent|draft|trash|deleted|已发送|草稿|已删除)/i.test(path));
  }

  /** 将解析后的邮件头打平成可搜索文本。 */
  function flattenHeaders(headers) {
    if (!headers?.entries) return "";
    return [...headers.entries()].map(([key, value]) => {
      if (Array.isArray(value)) return `${key}: ${value.map(item => item?.text || item?.value || String(item)).join(" ")}`;
      if (value?.text) return `${key}: ${value.text}`;
      if (value?.value) return `${key}: ${value.value}`;
      return `${key}: ${String(value || "")}`;
    }).join("\n");
  }

  /** 解析并保存 IMAP 拉取到的一封邮件。 */
  async function saveMessage(accountId, mailbox, message, updateOnly = false) {
    const parsed = await simpleParser(message.source);
    const bodyText = String(parsed.text || "").slice(0, 100_000);
    const resolvedHtml = inlineAttachmentCidImages(parsed.html, parsed.attachments);
    const bodyHtml = typeof resolvedHtml === "string" ? resolvedHtml.slice(0, 300_000) : "";
    const htmlText = bodyHtml.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ");
    const rawHeaderText = Buffer.isBuffer(message.source)
      ? message.source.toString("utf8", 0, Math.min(message.source.length, 200_000)).split(/\r?\n\r?\n/, 1)[0]
      : "";
    const searchable = [
      flattenHeaders(parsed.headers),
      rawHeaderText,
      parsed.headers?.get("delivered-to") || "",
      parsed.headers?.get("x-original-to") || "",
      parsed.headers?.get("envelope-to") || "",
      parsed.to?.text || "",
      parsed.cc?.text || "",
      bodyText,
      htmlText
    ].join("\n");
    return repositories.insertMessage(accountId, {
      uid: `${accountId}:${mailbox}:${message.uid}`,
      subject: parsed.subject || "",
      sender: parsed.from?.text || "",
      recipient: matchHiddenAddress(accountId, searchable),
      code: extractCode(`${parsed.subject || ""}\n${bodyText}\n${htmlText}`),
      preview: (bodyText || htmlText).replace(/\s+/g, " ").slice(0, 240),
      bodyText,
      bodyHtml,
      receivedAt: (parsed.date || message.internalDate || new Date()).toISOString()
    }, { updateOnly });
  }

  /** 连接 IMAP 并按 UID 增量同步邮件。 */
  async function sync(accountId, options = {}) {
    if (activeSyncs.has(accountId)) throw Object.assign(new Error("该 CK 的邮箱正在同步"), { status: 409 });
    const stored = repositories.getInboxConfigInternal(accountId);
    if (!stored?.password_encrypted) throw Object.assign(new Error("尚未配置 IMAP 收件邮箱"), { status: 400 });
    activeSyncs.add(accountId);
    const clientOptions = {
      host: stored.host,
      port: stored.port,
      secure: Boolean(stored.secure),
      auth: { user: stored.email, pass: decryptSecret(stored.password_encrypted, config.encryptionKey) },
      logger: false,
      connectionTimeout: 15_000,
      greetingTimeout: 15_000,
      socketTimeout: 30_000
    };
    if (config.inboxProxy) clientOptions.proxy = config.inboxProxy;
    const client = new ImapFlow(clientOptions);
    client.on("error", error => {
      // ImapFlow may emit socket errors (for example ECONNRESET) outside the
      // awaited sync flow. Without a listener Node treats that as an unhandled
      // error and exits, which breaks the public pickup service behind the
      // Cloudflare tunnel. Keep the service alive and let the current sync
      // retry on its next scheduled run.
      console.warn(`IMAP connection warning for account ${accountId}: ${error?.message || error}`);
    });
    let added = 0;
    let scanned = 0;
    let primaryLastUid = Number(stored.last_uid || 0);
    let primaryUidValidity = String(stored.uid_validity || "");
    const primaryMailbox = stored.mailbox || "INBOX";

    async function syncMailbox(mailbox) {
      const state = repositories.getInboxMailboxState(accountId, mailbox);
      let lastUid = Number(state?.last_uid ?? (mailbox === primaryMailbox ? stored.last_uid : 0) ?? 0);
      let uidValidity = String(state?.uid_validity ?? (mailbox === primaryMailbox ? stored.uid_validity : "") ?? "");
      const needsHtmlBackfill = state ? !Boolean(state.html_backfill_done) : mailbox === primaryMailbox && !Boolean(stored.html_backfill_done);
      const lock = await client.getMailboxLock(mailbox);
      let localAdded = 0;
      let localScanned = 0;
      try {
        const total = Number(client.mailbox?.exists || 0);
        const currentValidity = String(client.mailbox?.uidValidity || "");
        if (uidValidity && currentValidity && uidValidity !== currentValidity) lastUid = 0;
        uidValidity = currentValidity;
        if (!total) {
          repositories.updateInboxMailboxState(accountId, mailbox, { lastUid, uidValidity, htmlBackfillDone: true, lastSyncAt: new Date().toISOString(), lastError: "" });
          return { added: 0, scanned: 0, lastUid, uidValidity };
        }
        const uidNext = Number(client.mailbox?.uidNext || 0);
        if (!options.forceRecent && !needsHtmlBackfill && lastUid > 0 && uidNext > 0 && lastUid >= uidNext - 1) {
          repositories.updateInboxMailboxState(accountId, mailbox, { lastUid, uidValidity, htmlBackfillDone: true, lastSyncAt: new Date().toISOString(), lastError: "" });
          return { added: 0, scanned: 0, lastUid, uidValidity };
        }
        const query = { uid: true, source: true, envelope: true, internalDate: true };
        const range = needsHtmlBackfill
          ? `${Math.max(1, total - 499)}:*`
          : options.forceRecent ? `${Math.max(1, total - 49)}:*`
          : lastUid > 0 ? `${lastUid + 1}:*` : `${Math.max(1, total - 99)}:*`;
        const fetchOptions = !needsHtmlBackfill && !options.forceRecent && lastUid > 0 ? { uid: true } : undefined;
        for await (const message of client.fetch(range, query, fetchOptions)) {
          localScanned++;
          lastUid = Math.max(lastUid, Number(message.uid || 0));
          const inserted = await saveMessage(accountId, mailbox, message, needsHtmlBackfill);
          if (inserted) localAdded++;
        }
        repositories.updateInboxMailboxState(accountId, mailbox, { lastUid, uidValidity, htmlBackfillDone: true, lastSyncAt: new Date().toISOString(), lastError: "" });
        if (mailbox === primaryMailbox && needsHtmlBackfill) repositories.completeInboxHtmlBackfill(accountId);
        return { added: localAdded, scanned: localScanned, lastUid, uidValidity };
      } catch (error) {
        repositories.updateInboxMailboxState(accountId, mailbox, { lastUid, uidValidity, htmlBackfillDone: !needsHtmlBackfill, lastSyncAt: new Date().toISOString(), lastError: error.message });
        throw error;
      } finally {
        lock.release();
      }
    }

    try {
      await client.connect();
      const boxes = await client.list().catch(() => []);
      const mailboxes = selectSyncMailboxes(boxes, primaryMailbox);
      const errors = [];
      for (const mailbox of mailboxes) {
        try {
          const result = await syncMailbox(mailbox);
          added += result.added;
          scanned += result.scanned;
          if (mailbox === primaryMailbox) {
            primaryLastUid = result.lastUid;
            primaryUidValidity = result.uidValidity;
          }
        } catch (error) {
          errors.push(`${mailbox}: ${error.message}`);
        }
      }
      const lastError = errors.join("；").slice(0, 1000);
      repositories.updateInboxSyncState(accountId, { lastUid: primaryLastUid, uidValidity: primaryUidValidity, lastSyncAt: new Date().toISOString(), nextSyncAt: nextSyncAt(), lastError });
      if (errors.length && !scanned) throw new Error(lastError);
      return { added, scanned, mailboxes: mailboxes.length, errors };
    } catch (error) {
      repositories.updateInboxSyncState(accountId, { lastUid: primaryLastUid, uidValidity: primaryUidValidity, lastSyncAt: stored.last_sync_at, nextSyncAt: nextSyncAt(), lastError: error.message });
      throw error;
    } finally {
      await client.logout().catch(() => {});
      activeSyncs.delete(accountId);
    }
  }

  return { getConfig, saveConfig, sync };
}

