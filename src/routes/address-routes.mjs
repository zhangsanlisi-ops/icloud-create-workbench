import { Router } from "express";

/** 将 CSV 字段进行安全转义。 */
function csvCell(value) {
  const text = String(value ?? "");
  return `"${text.replaceAll('"', '""')}"`;
}

const VALID_ADDRESS_STATES = ["unused", "used", "exported", "trash"];

/** 创建隐藏邮箱查询、导出和状态路由。 */
export function createAddressRouter(repositories, publicMailService, icloudService) {
  const router = Router();

  /** 按账号、状态或关键词查询隐藏邮箱。 */
  router.get("/", (req, res) => {
    const page = Math.max(1, Number(req.query.page || 1));
    const pageSize = Math.min(100, Math.max(10, Number(req.query.pageSize || 20)));
    const result = repositories.pageAddresses({
      accountId: req.query.accountId,
      state: req.query.state,
      search: String(req.query.search || "").slice(0, 100)
    }, page, pageSize);
    res.json({ addresses: result.rows, pagination: { page, pageSize, total: result.total, totalPages: Math.max(1, Math.ceil(result.total / pageSize)) } });
  });

  /** 下载当前筛选结果的 UTF-8 CSV。 */
  router.get("/export", (req, res) => {
    const rows = repositories.listAddresses({
      accountId: req.query.accountId,
      state: req.query.state,
      search: String(req.query.search || "").slice(0, 100)
    });
    const csv = ["邮箱,标签,状态,来源,Apple ID,创建时间", ...rows.map(row => [
      row.email, row.label, row.state, row.source, row.appleId, row.createdAt
    ].map(csvCell).join(","))].join("\r\n");
    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader("Content-Disposition", "attachment; filename=hidden-addresses.csv");
    res.send(`\uFEFF${csv}`);
  });

  /** 下载当前筛选结果的 MMA 文本，每行包含邮箱和标签。 */
  router.get("/export-mma", (req, res) => {
    const rows = repositories.listAddresses({
      accountId: req.query.accountId,
      state: req.query.state,
      search: String(req.query.search || "").slice(0, 100)
    });
    const content = rows.map(row => `${row.email}----${row.label}`).join("\r\n");
    res.setHeader("Content-Type", "text/plain; charset=utf-8");
    res.setHeader("Content-Disposition", "attachment; filename=hidden-addresses-mma.txt");
    res.send(`\uFEFF${content}`);
  });

  /** 按邮箱----取件地址格式导出选中的邮箱，并自动标记为已导出。 */
  router.post("/export-selected", (req, res) => {
    const ids = Array.isArray(req.body?.ids) ? [...new Set(req.body.ids.map(String))].slice(0, 200) : [];
    if (!ids.length) return res.status(400).json({ error: "请至少选择一个邮箱" });
    const rows = ids.map(id => {
      const address = repositories.getAddress(id);
      if (!address) return null;
      const access = publicMailService.createAccess(id);
      return { email: address.email, viewerUrl: access.viewerUrl };
    }).filter(Boolean);
    if (!rows.length) return res.status(404).json({ error: "选中的邮箱不存在" });
    repositories.updateAddressStates(ids, "exported");
    const content = rows.map(row => `${row.email}----${row.viewerUrl}`).join("\r\n");
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    res.setHeader("Content-Type", "text/plain; charset=utf-8");
    res.setHeader("Content-Disposition", `attachment; filename=selected-addresses-${stamp}.txt`);
    res.send(`\uFEFF${content}`);
  });

  /** 批量修改邮箱状态。 */
  router.patch("/batch-state", (req, res) => {
    const ids = Array.isArray(req.body?.ids) ? [...new Set(req.body.ids.map(String))].slice(0, 200) : [];
    const state = String(req.body?.state || "");
    if (!ids.length) return res.status(400).json({ error: "请至少选择一个邮箱" });
    if (!VALID_ADDRESS_STATES.includes(state)) return res.status(400).json({ error: "邮箱状态无效" });
    res.json({ updated: repositories.updateAddressStates(ids, state) });
  });

  /** 批量从 Apple 和本地库存删除选中的隐藏邮箱。 */
  router.delete("/batch", async (req, res) => {
    const ids = Array.isArray(req.body?.ids) ? [...new Set(req.body.ids.map(String))].slice(0, 1000) : [];
    if (!ids.length) return res.status(400).json({ error: "请至少选择一个邮箱" });
    res.json(await icloudService.deleteAddresses(ids));
  });

  /** 删除一个 CK 当前筛选出的全部隐藏邮箱，避免分页逐项勾选。 */
  router.delete("/batch-filter", async (req, res) => {
    const accountId = String(req.body?.accountId || "");
    if (!accountId) return res.status(400).json({ error: "请先筛选一个 CK 账号" });
    const rows = repositories.listAddresses({
      accountId,
      state: String(req.body?.state || ""),
      search: String(req.body?.search || "").slice(0, 100)
    });
    if (!rows.length) return res.status(404).json({ error: "当前筛选条件没有邮箱" });
    if (rows.length > 1000) return res.status(400).json({ error: "单次最多删除 1000 个邮箱" });
    res.json(await icloudService.deleteAddresses(rows.map(row => row.id)));
  });

  /** 返回隐私邮箱详情。 */
  router.get("/:id", (req, res) => {
    const address = repositories.getAddress(req.params.id);
    if (!address) return res.status(404).json({ error: "邮箱不存在" });
    res.json({ address });
  });

  /** 分页返回隐私邮箱关联邮件。 */
  router.get("/:id/messages", (req, res) => {
    if (!repositories.getAddress(req.params.id)) return res.status(404).json({ error: "邮箱不存在" });
    const page = Math.max(1, Number(req.query.page || 1));
    const pageSize = Math.min(100, Math.max(10, Number(req.query.pageSize || 20)));
    const result = repositories.pageAddressMessages(req.params.id, page, pageSize);
    res.json({ messages: result.rows, pagination: { page, pageSize, total: result.total, totalPages: Math.max(1, Math.ceil(result.total / pageSize)) } });
  });

  /** 生成或轮换邮箱公开访问链接。 */
  router.post("/:id/public-access", (req, res) => res.status(201).json(publicMailService.createAccess(req.params.id)));

  /** 撤销邮箱公开访问链接。 */
  router.delete("/:id/public-access", (req, res) => res.json(publicMailService.revokeAccess(req.params.id)));

  /** 修改隐藏邮箱本地状态。 */
  router.patch("/:id/state", (req, res) => {
    const state = String(req.body?.state || "");
    if (!VALID_ADDRESS_STATES.includes(state)) return res.status(400).json({ error: "邮箱状态无效" });
    if (!repositories.updateAddressState(req.params.id, state)) return res.status(404).json({ error: "邮箱不存在" });
    res.json({ ok: true });
  });
  return router;
}
