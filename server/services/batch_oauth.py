"""批量 Google OAuth 登录。

核心思路：
  1. 用 Playwright **持久化 context** 保存 Google 登录态（~/.workbuddy/google-chromium/）
  2. 首次用 headless=False 打开浏览器，让用户手动登一次 Google → 之后永久复用
  3. 批量时：每轮调一次 /v2/plugin/auth/state 拿到 authUrl → 浏览器里打开 →
     点「Log in with Google」→ Keycloak → Google（已有会话，秒过）→ 回 Keycloak →
     回 workbuddy → /v2/plugin/auth/token 拿到令牌 → save_account 落盘
  4. 串行（一个浏览器页），避免 Keycloak session_code 冲突；单轮耗时 ~8-15s

使用：
  # 首次：建立 Google 会话（会弹 Chromium 窗口，手动登 Google）
  python -m server.services.batch_oauth setup

  # 批量：一次性跑 10 个账号
  python -m server.services.batch_oauth run --count 10

  # 也可以从后端 API 调用：POST /api/oauth/batch  {count, name_prefix}
"""
from __future__ import annotations

import asyncio
import json
import os
import secrets
import sys
import time
from pathlib import Path
from typing import Any

import httpx

from .browser_login import BrowserLogin, CN_BASE, INTL_BASE
from . import tencent as _tencent

# 持久化 Chromium profile 路径
PROFILE_DIR = Path(os.environ.get("WB_OAUTH_PROFILE", Path.home() / ".workbuddy" / "google-chromium"))
SERVER_BASE = os.environ.get("WB_SERVER_BASE", "http://localhost:7864")
SERVER_COOKIE = os.environ.get("WB_SERVER_COOKIE", "")  # 可选：直接用 cookie，绕过登录

JOBS_DIR = Path(os.environ.get("WB_OAUTH_JOBS", Path.home() / ".workbuddy" / "oauth-jobs"))


def get_httpx_client() -> httpx.AsyncClient:
    return httpx.AsyncClient(timeout=30, follow_redirects=True)


# ── 后端 OAuth 启动 / 轮询（绕过前端，直调我们自己的后端） ──

async def start_oauth(version: str, name: str = "") -> dict:
    """调我们管理端的 /api/oauth/start 拿到 {fid, auth_url, expires_at, interval}。

    直接用 httpx 带 cookie；如果 WB_SERVER_COOKIE 没配，会先登录拿 cookie。
    """
    async with httpx.AsyncClient(timeout=20, follow_redirects=True) as h:
        cookie = SERVER_COOKIE
        if not cookie:
            r = await h.post(f"{SERVER_BASE}/api/login", json={"username": "admin", "password": "admin"})
            if r.status_code != 200:
                raise RuntimeError(f"登录失败 {r.status_code}: {r.text}")
            cookie = h.cookies.get("wb_session", "")
        
        r = await h.post(
            f"{SERVER_BASE}/api/oauth/start",
            json={"name": name, "version": version},
            headers={"Content-Type": "application/json"},
            cookies={"wb_session": cookie} if cookie else None,
        )
        if r.status_code != 200:
            raise RuntimeError(f"oauth/start 失败 {r.status_code}: {r.text}")
        data = r.json()
        # 后端返回 {id, url, expires_at, interval}
        return {
            "fid": data["id"],
            "auth_url": data["url"],
            "expires_at": data["expires_at"],
            "interval": data["interval"],
            "cookie": cookie,
        }


async def poll_until_success(fid: str, cookie: str, timeout_sec: int = 300) -> dict:
    """轮询 /api/oauth/{fid}/poll 直到 success / expired / invalid。"""
    deadline = time.time() + timeout_sec
    async with httpx.AsyncClient(timeout=10) as h:
        while time.time() < deadline:
            r = await h.get(
                f"{SERVER_BASE}/api/oauth/{fid}/poll",
                cookies={"wb_session": cookie} if cookie else None,
            )
            if r.status_code == 200:
                data = r.json()
                if data.get("status") == "success":
                    return data
                if data.get("status") in ("expired", "invalid"):
                    raise RuntimeError(f"OAuth 会话 {data['status']}")
            await asyncio.sleep(2)
    raise TimeoutError(f"poll 超时 {timeout_sec}s")


# ── Playwright 驱动 ──

def _ensure_playwright():
    try:
        from playwright.sync_api import sync_playwright  # noqa
        return True
    except ImportError:
        print("❌ playwright 未安装，请先: pip install playwright && playwright install chromium")
        return False


def run_setup_google_profile(headless: bool = False) -> Path:
    """打开持久化 Chromium，让用户手动登录 Google 一次。

    登录完后关闭浏览器即可，profile 会保存到 PROFILE_DIR。
    """
    if not _ensure_playwright():
        return PROFILE_DIR

    from playwright.sync_api import sync_playwright

    PROFILE_DIR.parent.mkdir(parents=True, exist_ok=True)

    with sync_playwright() as p:
        ctx = p.chromium.launch_persistent_context(
            str(PROFILE_DIR),
            headless=headless,
            args=["--no-sandbox", "--disable-dev-shm-usage"],
        )
        page = ctx.pages[0] if ctx.pages else ctx.new_page()
        # 先打开 workbuddy 的 Keycloak 页面
        page.goto(
            "https://www.workbuddy.ai/auth/realms/copilot/protocol/openid-connect/auth"
            "?client_id=console&response_type=code&redirect_uri=https%3A%2F%2Fwww.workbuddy.ai%2Flogin%2F"
            "&scope=openid%20profile%20email",
            wait_until="domcontentloaded",
            timeout=30000,
        )
        page.wait_for_timeout(2000)
        # 点 Log in with Google
        try:
            page.locator("a[href*='/broker/google/login']").first.click(timeout=5000)
        except Exception:
            print("⚠️ 没找到 Google 按钮，手动点一下")

        print("\n👉 请在弹出的浏览器里登录你的 Google 账号")
        print("👉 登录完成并看到 workbuddy 页面后，直接关掉浏览器就行")
        print(f"👉 Profile 保存位置: {PROFILE_DIR}")

        ctx.storage_state(path=str(PROFILE_DIR / "state.json"))
        input("\n按 Enter 关闭浏览器...")
        ctx.close()

    print(f"✅ Google profile 已保存到 {PROFILE_DIR}")
    return PROFILE_DIR


# ── 核心：串行跑 N 个 OAuth ──

async def run_batch(
    count: int,
    version: str = "intl",
    name_prefix: str = "batch",
    job_id: str | None = None,
    on_progress=None,
    headless: bool = True,
) -> dict:
    """跑 N 个 OAuth。每个都是：start → Playwright 走 Google → poll → save。

    on_progress(counter, total, result_dict) 回调，可选。
    返回 {ok: N, failed: M, accounts: [...]}
    """
    if not _ensure_playwright():
        return {"ok": 0, "failed": count, "error": "playwright 不可用"}

    from playwright.async_api import async_playwright

    PROFILE_DIR.parent.mkdir(parents=True, exist_ok=True)

    # 先调我们自己后端拿 cookie（OAuth start 需要 admin 鉴权）
    first = await start_oauth(version, name="__auth_probe__")
    cookie = first["cookie"]

    results = {"ok": [], "failed": []}

    async with async_playwright() as pw:
        ctx = await pw.chromium.launch_persistent_context(
            str(PROFILE_DIR),
            headless=headless,
            args=["--no-sandbox", "--disable-dev-shm-usage", "--disable-blink-features=AutomationControlled"],
        )
        try:
            page = ctx.pages[0] if ctx.pages else await ctx.new_page()

            for i in range(1, count + 1):
                name = f"{name_prefix}-{i:02d}"
                print(f"\n▶ [{i}/{count}] start OAuth ...", flush=True)

                # 1. 启动 OAuth
                oauth = await start_oauth(version, name=name)
                fid = oauth["fid"]
                auth_url = oauth["auth_url"]
                print(f"   fid={fid[:16]}...", flush=True)

                # 2. 浏览器打开 authUrl → Keycloak → Google broker
                try:
                    await page.goto(auth_url, wait_until="domcontentloaded", timeout=30000)
                except Exception as e:
                    print(f"   ⚠️  goto 超时，继续等 ...")

                # 3. 等页面加载 → 找 Google broker 按钮点击
                clicked = False
                for _ in range(15):  # 最多等 15s
                    await asyncio.sleep(1)
                    try:
                        # 可能我们已经被重定向到 Google（profile 已有会话 → auto-redirect）
                        cur_url = page.url
                        if "accounts.google.com" in cur_url and "signin" in cur_url:
                            print(f"   已到 Google 登录页，等自动完成 ...", flush=True)
                            # 等 Google 回调跳回 workbuddy
                            for _2 in range(60):
                                await asyncio.sleep(1)
                                if "workbuddy.ai/login" in page.url or "code=" in page.url.lower():
                                    break
                            clicked = True
                            break

                        # 还在 Keycloak → 找 Google broker 按钮
                        broker = page.locator("a[href*='/broker/google/login']").first
                        if await broker.count() > 0:
                            await broker.click(timeout=3000)
                            clicked = True
                            print(f"   已点 Google broker，等 OAuth 完成 ...", flush=True)
                            # 等待 OAuth 闭环
                            for _2 in range(90):
                                await asyncio.sleep(1)
                                if (
                                    "workbuddy.ai/login" in page.url
                                    or "code=" in page.url.lower()
                                    or (await page.locator("text=authorization").count() > 0)
                                ):
                                    break
                            break
                    except Exception:
                        pass

                if not clicked:
                    print(f"   ❌ 没点到 Google broker（可能 profile 过期 / 页面结构变了）")
                    results["failed"].append({"name": name, "error": "broker_not_clicked"})
                    if on_progress:
                        try: on_progress(i, count, {"ok": False, "name": name, "error": "broker_not_clicked"})
                        except: pass
                    continue

                # 4. 轮询我们后端等 token 就绪
                try:
                    account = await poll_until_success(fid, cookie, timeout_sec=180)
                    print(f"   ✅ ok  {account.get('nickname') or account.get('uid') or fid[:10]}", flush=True)
                    results["ok"].append({"name": name, **account})
                    if on_progress:
                        try: on_progress(i, count, {"ok": True, "name": name, **account})
                        except: pass
                except Exception as e:
                    print(f"   ❌ 轮询失败: {e}", flush=True)
                    results["failed"].append({"name": name, "error": str(e)[:200]})
                    if on_progress:
                        try: on_progress(i, count, {"ok": False, "name": name, "error": str(e)[:200]})
                        except: pass

                await asyncio.sleep(1)

        finally:
            await ctx.close()

    print(f"\n📊 完成: {len(results['ok'])}/{count} 成功，{len(results['failed'])} 失败", flush=True)
    return {
        "ok": len(results["ok"]),
        "failed": len(results["failed"]),
        "accounts": results["ok"],
        "errors": results["failed"],
    }


# ── CLI 入口 ──

def _cli():
    import argparse

    p = argparse.ArgumentParser(description="批量 Google OAuth 登录 workbuddy 国际版")
    sp = p.add_subparsers(dest="cmd", required=True)

    p_setup = sp.add_parser("setup", help="首次：打开 Chromium 手动登 Google（持久化 profile）")
    p_setup.add_argument("--headless", action="store_true", help="无头模式（适合已有 profile 只需刷新）")

    p_run = sp.add_parser("run", help="批量跑")
    p_run.add_argument("--count", type=int, default=1, help="要生成的账号数")
    p_run.add_argument("--version", choices=["intl", "cn"], default="intl", help="国内/国际版")
    p_run.add_argument("--name-prefix", default="batch", help="账号备注前缀")
    p_run.add_argument("--headless", action="store_true", default=True, help="无头（默认）")
    p_run.add_argument("--show-browser", action="store_true", help="显示浏览器（调试用）")

    args = p.parse_args()

    if args.cmd == "setup":
        run_setup_google_profile(headless=args.headless)
        return

    if args.cmd == "run":
        count = args.count
        if count <= 0:
            print("count 必须 > 0"); sys.exit(1)

        if not PROFILE_DIR.exists():
            print(f"❌ 没找到 Google profile（{PROFILE_DIR}），请先跑 `python -m server.services.batch_oauth setup`")
            sys.exit(1)

        headless = not args.show_browser
        result = asyncio.run(
            run_batch(
                count=count,
                version=args.version,
                name_prefix=args.name_prefix,
                headless=headless,
            )
        )
        print(json.dumps(result, indent=2, ensure_ascii=False))


if __name__ == "__main__":
    _cli()
