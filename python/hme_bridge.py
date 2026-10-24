"""Node.js 与 hidemyemail-generator 之间的 JSON 标准输入桥接层。"""

import asyncio
import base64
import json
import re
import sys
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
VENDOR_SRC = ROOT / "vendor" / "hidemyemail-generator" / "src"
sys.path.insert(0, str(VENDOR_SRC))

from hidemyemail_generator.hidemyemail import HideMyEmail  # noqa: E402
from hidemyemail_generator.main import fetch_account_info_from_cookie  # noqa: E402


def parse_cookie_context(content: str, requested_region: str = "auto") -> tuple[str, str, str]:
    """在内存中解析原始 Cookie、cURL 或上游 Cookie 文件。"""
    text = str(content or "").strip()
    normalized = re.sub(r"(?:\\|\^)\s*\r?\n", " ", text)
    region_match = re.search(r"(?m)^HIDEMYEMAIL_REGION=(global|china)\s*$", text)
    region = region_match.group(1) if region_match else requested_region
    host_match = re.search(r"(?m)^HIDEMYEMAIL_MAILDOMAIN_HOST=([^\s]+)\s*$", text)
    curl_host_match = re.search(r"https://([A-Za-z0-9.-]*maildomainws\.icloud\.com(?:\.cn)?)/", normalized, re.I)
    maildomain_host = host_match.group(1).strip() if host_match else (curl_host_match.group(1).strip() if curl_host_match else "")
    encoded = re.search(r"(?m)^HIDEMYEMAIL_COOKIE_BASE64=([A-Za-z0-9+/=]+)\s*$", text)
    if encoded:
        return base64.b64decode(encoded.group(1)).decode("utf-8").strip(), region, maildomain_host
    cookie_arg = re.search(r"(?:^|\s)(?:-b|--cookie)\s+(?:\^?\"|')(.+?)(?:\^?\"|')(?=\s+-|\s*$)", normalized, re.I | re.S)
    if cookie_arg:
        return cookie_arg.group(1).replace('^\"', '"').replace('\\"', '"').strip(), region, maildomain_host
    header_arg = re.search(r"(?:-H|--header)\s+\^?(['\"])\s*cookie\s*:\s*(.*?)\^?\1", normalized, re.I | re.S)
    if header_arg:
        return header_arg.group(2).strip(), region, maildomain_host
    header = re.search(r"^\s*cookie\s*:\s*(.+?)\s*$", normalized, re.I | re.S)
    if header:
        return header.group(1).strip().strip("'\""), region, maildomain_host
    return text, region, maildomain_host


def ordered_regions(requested_region: str, maildomain_host: str) -> list[str]:
    """????????????????? cURL ??????? setup ???"""
    if requested_region in {"global", "china"}:
        return [requested_region]
    if str(maildomain_host or "").lower().endswith(".icloud.com.cn"):
        return ["china", "global"]
    return ["global", "china"]


async def validate_cookie(payload: dict) -> dict:
    """验证 CK 并返回经过筛选的账号信息。"""
    cookie, requested_region, maildomain_host = parse_cookie_context(payload.get("cookie", ""), payload.get("region", "auto"))
    if "X-APPLE" not in cookie:
        raise ValueError("CK 中未找到必要的 X-APPLE 字段")
    regions = ordered_regions(requested_region, maildomain_host)
    last_error = "CK 校验失败"
    for region in regions:
        resolved_host = maildomain_host or HideMyEmail.REGION_CONFIG[region]["maildomain_host"]
        try:
            account = await fetch_account_info_from_cookie(cookie, region, resolved_host)
        except Exception as error:
            last_error = str(error)
            continue
        if "error" in account:
            last_error = str(account["error"])
            continue
        ds_info = account.get("dsInfo", {})
        full_name = ds_info.get("fullName") or " ".join(filter(None, [ds_info.get("firstName"), ds_info.get("lastName")]))
        return {
            "ok": True,
            "cookie": cookie,
            "region": region,
            "appleId": ds_info.get("appleId") or "",
            "dsid": str(ds_info.get("dsid") or ""),
            "displayName": full_name or "",
            "featureAvailable": bool(ds_info.get("isHideMyEmailFeatureAvailable")),
            "userPartition": str(account.get("userPartition") or ""),
            "maildomainHost": resolved_host,
        }
    raise ValueError(last_error)


def response_error(data: dict, fallback: str) -> str:
    """从 Apple API 响应中提取可读错误。"""
    error = data.get("error") if isinstance(data, dict) else None
    if isinstance(error, dict):
        return str(error.get("errorMessage") or fallback)
    return str(data.get("reason") or error or fallback) if isinstance(data, dict) else fallback


async def resolve_maildomain(cookie: str, region: str, preferred_host: str = "") -> tuple[str, dict]:
    """通过列表接口验证分片，错误分片自动回退到上游区域默认节点。"""
    default_host = HideMyEmail.REGION_CONFIG[region]["maildomain_host"]
    candidates = list(dict.fromkeys(host for host in [preferred_host, default_host] if host))
    last_error = "无法连接 iCloud maildomain 服务"
    for host in candidates:
        async with HideMyEmail(cookies=cookie, region=region, maildomain_host=host) as client:
            response = await client.list_email()
        if response.get("success"):
            return host, response
        last_error = response_error(response, last_error)
    raise ValueError(last_error)


async def generate_addresses(payload: dict) -> dict:
    """按标签顺序串行生成并保留隐藏邮箱。"""
    cookie, region, maildomain_host = parse_cookie_context(payload.get("cookie", ""), payload.get("region", "global"))
    maildomain_host = maildomain_host or str(payload.get("maildomainHost") or "")
    labels = [str(item).strip() for item in payload.get("labels", []) if str(item).strip()]
    generated = []
    errors = []
    maildomain_host, _ = await resolve_maildomain(cookie, region, maildomain_host)
    async with HideMyEmail(cookies=cookie, region=region, maildomain_host=maildomain_host) as client:
        for index, label in enumerate(labels):
            generated_response = await client.generate_email()
            if not generated_response.get("success"):
                errors.append({"label": label, "error": response_error(generated_response, "生成失败")})
                errors.extend({"label": skipped, "error": "前序操作失败，未继续执行"} for skipped in labels[index + 1 :])
                break
            email = generated_response.get("result", {}).get("hme")
            reserved_response = await client.reserve_email(email, label, "Generated by iCloud Create Workbench")
            if not reserved_response.get("success"):
                errors.append({"label": label, "error": response_error(reserved_response, "保留失败")})
                errors.extend({"label": skipped, "error": "前序操作失败，未继续执行"} for skipped in labels[index + 1 :])
                break
            generated.append({
                "email": email,
                "anonymousId": reserved_response.get("result", {}).get("anonymousId") or "",
                "label": label,
                "createdAt": datetime.now(timezone.utc).isoformat(),
            })
    return {"ok": True, "generated": generated, "errors": errors, "maildomainHost": maildomain_host}


async def list_addresses(payload: dict) -> dict:
    """读取 Apple 账号下的隐藏邮箱列表。"""
    cookie, region, maildomain_host = parse_cookie_context(payload.get("cookie", ""), payload.get("region", "global"))
    maildomain_host = maildomain_host or str(payload.get("maildomainHost") or "")
    maildomain_host, response = await resolve_maildomain(cookie, region, maildomain_host)
    rows = []
    for item in response.get("result", {}).get("hmeEmails", []):
        if item.get("hme"):
            rows.append({
                "email": item.get("hme"),
                "anonymousId": item.get("anonymousId") or "",
                "label": item.get("label") or "",
                "active": item.get("isActive") is not False,
                "createdAt": datetime.fromtimestamp(item.get("createTimestamp", 0) / 1000, timezone.utc).isoformat()
                if item.get("createTimestamp") else datetime.now(timezone.utc).isoformat(),
            })
    return {"ok": True, "addresses": rows, "maildomainHost": maildomain_host}


async def delete_addresses(payload: dict) -> dict:
    """按 Apple 实时列表删除隐藏邮箱，避免本地旧匿名标识造成误删失败。"""
    cookie, region, maildomain_host = parse_cookie_context(payload.get("cookie", ""), payload.get("region", "global"))
    maildomain_host = maildomain_host or str(payload.get("maildomainHost") or "")
    items = [item for item in payload.get("addresses", []) if item.get("anonymousId")]
    if not items:
        raise ValueError("没有可删除的 iCloud 隐藏邮箱")
    maildomain_host, list_response = await resolve_maildomain(cookie, region, maildomain_host)
    deleted = []
    failed = []
    async with HideMyEmail(cookies=cookie, region=region, maildomain_host=maildomain_host) as client:
        for item in items:
            # 本地记录可能来自旧 CK 或历史同步；以 Apple 当前列表的 anonymousId 为准。
            live_rows = list_response.get("result", {}).get("hmeEmails", [])
            live_item = next((row for row in live_rows if row.get("hme") == item.get("email")), None)
            if not live_item:
                # Apple 列表已没有该别名，说明先前请求已生效或用户在网页端删过，安全清理本地记录。
                deleted.append(str(item.get("id") or ""))
                continue
            anonymous_id = str(live_item.get("anonymousId") or item["anonymousId"])
            deactivated_response = {"success": True} if live_item.get("isActive") is False else await client.deactivate_email(anonymous_id)
            deactivation_error = response_error(deactivated_response, "iCloud 停用失败")
            if not deactivated_response.get("success") and "invalid request for private email" not in deactivation_error.lower():
                failed.append({"id": str(item.get("id") or ""), "email": str(item.get("email") or ""),
                               "error": deactivation_error})
                continue
            # Apple 停用为异步状态：轮询到列表明确显示 inactive 才发永久删除，不能靠固定睡眠赌时序。
            for delay in (1, 2, 3, 5):
                await asyncio.sleep(delay)
                list_response = await client.list_email()
                live_rows = list_response.get("result", {}).get("hmeEmails", [])
                live_item = next((row for row in live_rows if row.get("hme") == item.get("email")), None)
                if not live_item:
                    deleted.append(str(item.get("id") or ""))
                    break
                if live_item.get("isActive") is False:
                    anonymous_id = str(live_item.get("anonymousId") or anonymous_id)
                    break
            else:
                failed.append({"id": str(item.get("id") or ""), "email": str(item.get("email") or ""),
                               "error": "Apple 尚未确认邮箱已停用，请稍后重试"})
                continue
            if str(item.get("id") or "") in deleted:
                continue
            response = await client.delete_email(anonymous_id)
            if not response.get("success"):
                # 删除接口偶尔已完成但仍回 Invalid request；再次读取 Apple 列表判定真实最终状态。
                await asyncio.sleep(3)
                list_response = await client.list_email()
                live_rows = list_response.get("result", {}).get("hmeEmails", [])
                if not any(row.get("hme") == item.get("email") for row in live_rows):
                    deleted.append(str(item.get("id") or ""))
                    continue
                response = await client.delete_email(anonymous_id)
            if response.get("success"):
                deleted.append(str(item.get("id") or ""))
            else:
                failed.append({"id": str(item.get("id") or ""), "email": str(item.get("email") or ""),
                               "error": response_error(response, "iCloud 删除失败")})
    return {"ok": True, "deletedIds": deleted, "failed": failed, "maildomainHost": maildomain_host}


async def dispatch(command: str, payload: dict) -> dict:
    """将命令分派到对应的桥接操作。"""
    if command == "validate":
        return await validate_cookie(payload)
    if command == "generate":
        return await generate_addresses(payload)
    if command == "list":
        return await list_addresses(payload)
    if command == "delete":
        return await delete_addresses(payload)
    raise ValueError("不支持的 Python 桥接命令")


def main() -> None:
    """读取标准输入并保证标准输出只包含一行 JSON。"""
    try:
        command = sys.argv[1] if len(sys.argv) > 1 else ""
        payload = json.loads(sys.stdin.read() or "{}")
        result = asyncio.run(dispatch(command, payload))
        print(json.dumps(result, ensure_ascii=False, separators=(",", ":")))
    except Exception as error:  # 桥接边界需要统一转换所有异常
        print(json.dumps({"ok": False, "error": str(error)}, ensure_ascii=False, separators=(",", ":")))
        raise SystemExit(1)


if __name__ == "__main__":
    main()
