import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDatabase } from "../src/db.mjs";
import { createRepositories } from "../src/repositories.mjs";
import { createCampaignService } from "../src/services/campaign-service.mjs";

/** 创建带真实 SQLite 和模拟生成器的生产目标测试环境。 */
function createContext() {
  const directory = mkdtempSync(join(tmpdir(), "icloud-campaign-"));
  const db = createDatabase(join(directory, "test.db"));
  const repositories = createRepositories(db);
  const account = repositories.upsertAccount({
    identityKey: "campaign-account",
    appleId: "test@example.com",
    dsid: "1",
    displayName: "测试",
    region: "global",
    userPartition: "68",
    maildomainHost: "p68-maildomainws.icloud.com",
    cookieEncrypted: "encrypted"
  });
  let sequence = 0;
  let generateError = null;
  let generateResultErrors = null;
  let syncCalls = 0;
  let remoteCount = 0;

  const icloudService = {
    /** 模拟创建高库存目标前读取并同步 Apple 侧邮箱。 */
    async syncAddresses(accountId) {
      syncCalls++;
      const rows = Array.from({ length: remoteCount }, (_, index) => ({
        email: `remote-${index + 1}@icloud.com`,
        label: `remote-${index + 1}`
      }));
      repositories.upsertAddresses(accountId, null, rows, "synced");
      return { synced: rows.length };
    },
    /** 模拟每批生成并写入隐藏邮箱，同时设置六十分钟冷却。 */
    async generate(accountId, count, prefix) {
      if (generateError) throw generateError;
      if (generateResultErrors) return { generated: [], errors: generateResultErrors };
      const generated = Array.from({ length: count }, () => {
        sequence++;
        return {
          email: `campaign-${sequence}@icloud.com`,
          label: `${prefix}-${sequence}`,
          createdAt: new Date().toISOString()
        };
      });
      repositories.upsertAddresses(accountId, null, generated, "generated");
      db.prepare("UPDATE icloud_accounts SET cooldown_until = ? WHERE id = ?")
        .run(new Date(Date.now() + 60 * 60_000).toISOString(), accountId);
      return { generated, errors: [] };
    }
  };

  const service = createCampaignService({
    config: { targetDefault: 750, batchLimit: 5, cooldownMinutes: 60, retryMinutes: 5 },
    repositories,
    icloudService
  });

  /** 设置下一次生成时抛出的错误。 */
  function setGenerateError(error) {
    generateError = error;
  }

  /** 设置模拟 Apple 返回的批次错误。 */
  function setGenerateResultErrors(errors) {
    generateResultErrors = errors;
  }

  /** 设置模拟 Apple 侧已存在的邮箱数量。 */
  function setRemoteCount(count) {
    remoteCount = count;
  }

  /** 清理测试数据库和临时目录。 */
  function cleanup() {
    service.close();
    db.close();
    rmSync(directory, { recursive: true, force: true });
  }

  return { account, repositories, service, setGenerateError, setGenerateResultErrors, setRemoteCount, getSyncCalls: () => syncCalls, cleanup };
}

test("生产目标默认库存为 750 并在同步 Apple 库存后执行首批五个", async () => {
  const context = createContext();
  try {
    const campaign = await context.service.createCampaign({ accountId: context.account.id });
    assert.equal(campaign.targetTotal, 750);
    assert.equal(context.getSyncCalls(), 1);
    assert.equal(campaign.labelPrefix, "test");
    await context.service.wake();
    const stored = context.service.listCampaigns(10)[0];
    assert.equal(stored.currentTotal, 5);
    assert.equal(stored.generatedCount, 5);
    assert.equal(stored.status, "running");
    assert.ok(stored.nextRunAt);
  } finally {
    context.cleanup();
  }
});

test("生产目标支持停止和继续", async () => {
  const context = createContext();
  try {
    const campaign = await context.service.createCampaign({ accountId: context.account.id, targetTotal: 10 });
    assert.equal(context.getSyncCalls(), 0);
    context.service.stopCampaign(campaign.id);
    assert.equal(context.service.listCampaigns(10)[0].status, "stopped");
    context.service.resumeCampaign(campaign.id);
    assert.equal(context.service.listCampaigns(10)[0].status, "running");
  } finally {
    context.cleanup();
  }
});

test("目标上限为 750，超过 700 时先同步 Apple 库存", async () => {
  const context = createContext();
  try {
    await assert.rejects(
      context.service.createCampaign({ accountId: context.account.id, targetTotal: 751 }),
      error => error.status === 400 && error.message.includes("1-750")
    );
    assert.equal(context.getSyncCalls(), 0);
    context.setRemoteCount(750);
    await assert.rejects(
      context.service.createCampaign({ accountId: context.account.id, targetTotal: 750 }),
      error => error.status === 400 && error.message.includes("750")
    );
    assert.equal(context.getSyncCalls(), 1);
    assert.equal(context.repositories.countAddresses(context.account.id), 750);
  } finally {
    context.cleanup();
  }
});

test("同一 CK 只能保留一个未完成生产目标", async () => {
  const context = createContext();
  try {
    const campaign = await context.service.createCampaign({ accountId: context.account.id, targetTotal: 10 });
    await assert.rejects(
      context.service.createCampaign({ accountId: context.account.id, targetTotal: 20 }),
      error => error.status === 409
    );
    context.service.stopCampaign(campaign.id);
    await assert.rejects(
      context.service.createCampaign({ accountId: context.account.id, targetTotal: 20 }),
      error => error.status === 409
    );
  } finally {
    context.cleanup();
  }
});

test("数据库唯一索引防止并发绕过业务预检", () => {
  const context = createContext();
  try {
    context.repositories.createCampaign({
      accountId: context.account.id,
      targetTotal: 10,
      batchSize: 5,
      labelPrefix: "first",
      nextRunAt: new Date().toISOString()
    });
    assert.throws(
      () => context.repositories.createCampaign({
        accountId: context.account.id,
        targetTotal: 20,
        batchSize: 5,
        labelPrefix: "second",
        nextRunAt: new Date().toISOString()
      }),
      error => error.status === 409 && error.message === "该 CK 已有未结束任务"
    );
  } finally {
    context.cleanup();
  }
});

test("生产目标可修改后续批次标签前缀并同步 CK 默认值", async () => {
  const context = createContext();
  try {
    const campaign = await context.service.createCampaign({
      accountId: context.account.id,
      targetTotal: 10,
      labelPrefix: "old-prefix"
    });
    const result = context.service.updateLabelPrefix(campaign.id, { labelPrefix: "new_prefix" });
    assert.equal(result.labelPrefix, "new_prefix");
    assert.equal(context.service.listCampaigns(10)[0].labelPrefix, "new_prefix");
    assert.equal(context.repositories.getAccountInternal(context.account.id).label_prefix, "new_prefix");
  } finally {
    context.cleanup();
  }
});

test("删除生产目标时保留已经生成的邮箱库存", async () => {
  const context = createContext();
  try {
    const campaign = await context.service.createCampaign({ accountId: context.account.id, targetTotal: 10 });
    await context.service.wake();
    assert.equal(context.repositories.countAddresses(context.account.id), 5);
    context.service.deleteCampaign(campaign.id);
    assert.equal(context.service.listCampaigns(10).length, 0);
    assert.equal(context.repositories.countAddresses(context.account.id), 5);
  } finally {
    context.cleanup();
  }
});

test("失效 CK 的生产目标会自动停止，避免五分钟后继续重试", async () => {
  const context = createContext();
  try {
    const campaign = await context.service.createCampaign({ accountId: context.account.id, targetTotal: 10 });
    context.setGenerateError(Object.assign(new Error("Invalid global session"), { status: 410, accountExpired: true }));
    await context.service.wake();
    const stored = context.service.listCampaigns(10).find(item => item.id === campaign.id);
    assert.equal(stored.status, "stopped");
    assert.equal(stored.nextRunAt, null);
    assert.equal(stored.lastError, "Invalid global session");
  } finally {
    context.cleanup();
  }
});

test("Apple 邮箱容量已满时停止生产目标并保留错误", async () => {
  const context = createContext();
  try {
    const campaign = await context.service.createCampaign({ accountId: context.account.id, targetTotal: 10 });
    context.setGenerateResultErrors([{ label: "test-1", error: "Maximum number of Hide My Email addresses reached" }]);
    await context.service.wake();
    const stored = context.service.listCampaigns(10).find(item => item.id === campaign.id);
    assert.equal(stored.status, "stopped");
    assert.equal(stored.nextRunAt, null);
    assert.match(stored.lastError, /Maximum number/);
  } finally {
    context.cleanup();
  }
});

test("Apple 短时限流不会误判为容量已满", async () => {
  const context = createContext();
  try {
    const campaign = await context.service.createCampaign({ accountId: context.account.id, targetTotal: 10 });
    context.setGenerateResultErrors([{ label: "test-1", error: "Email rate limit reached, try later" }]);
    await context.service.wake();
    const stored = context.service.listCampaigns(10).find(item => item.id === campaign.id);
    assert.equal(stored.status, "running");
    assert.ok(stored.nextRunAt);
  } finally {
    context.cleanup();
  }
});

test("已过期 CK 不能新建生产目标", async () => {
  const context = createContext();
  try {
    context.repositories.markAccountExpired(context.account.id);
    await assert.rejects(
      context.service.createCampaign({ accountId: context.account.id, targetTotal: 10 }),
      error => error.status === 409 && error.accountExpired === true
    );
  } finally {
    context.cleanup();
  }
});
