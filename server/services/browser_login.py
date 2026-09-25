"""浏览器 OAuth 登录流程（上游 browser_login.py 的移植）。

支持国内版（copilot.tencent.com）与国际版（copilot.workbuddy.ai）双版本：
  - version='intl' → copilot.workbuddy.ai + workbuddy.ai Origin
  - version='cn'   → copilot.tencent.com   + www.codebuddy.cn Origin

流程：
  1. start  → POST /v2/plugin/auth/state?platform=CLI → 返回 {id, url, expires_at, interval}
  2. poll   → GET  /v2/plugin/auth/token  + GET /v2/plugin/login/account
                拿到 accessToken/refreshToken/uid/nickname → 调用 save_account 落盘
  3. cancel → 丢弃 flow，释放资源

flow 在内存里、随 fid 过期清理（TTL=300s）。并发安全：guard + lock 双重防护。
"""
from __future__ import annotations

import asyncio
import math
import secrets
import time
from urllib.parse import parse_qs, urlsplit

import httpx
from fastapi import HTTPException

from .realm import CN, GLOBAL

CN_BASE = 'https://copilot.tencent.com'
CN_HEADERS = {
    'Content-Type': 'application/json',
    'Accept': 'application/json, text/plain, */*',
    'X-Requested-With': 'XMLHttpRequest',
    'Origin': 'https://www.codebuddy.cn',
    'Referer': 'https://www.codebuddy.cn/',
    'User-Agent': 'CLI/2.63.2 CodeBuddy/2.63.2',
}

INTL_BASE = 'https://copilot.workbuddy.ai'
INTL_HEADERS = {
    'Content-Type': 'application/json',
    'Accept': 'application/json, text/plain, */*',
    'X-Requested-With': 'XMLHttpRequest',
    'Origin': 'https://workbuddy.ai',
    'Referer': 'https://workbuddy.ai/',
    'User-Agent': 'CLI/2.63.2 CodeBuddy/2.63.2',
}
TTL = 300


class BrowserLogin:
    def __init__(self, save_account, client_factory=None, clock=time.time):
        self.save_account = save_account
        self.client_factory = client_factory or (
            lambda **kw: httpx.AsyncClient(headers=CN_HEADERS, timeout=20, follow_redirects=False)
        )
        self.clock = clock
        self.flows: dict[str, dict] = {}
        self.guard = asyncio.Lock()

    async def _discard(self, fid: str) -> None:
        flow = self.flows.pop(fid, None)
        if flow and hasattr(flow.get('client'), 'aclose'):
            await flow['client'].aclose()

    async def cleanup(self) -> None:
        now = self.clock()
        for fid, flow in list(self.flows.items()):
            if flow['expires'] <= now and not flow['lock'].locked():
                await self._discard(fid)

    async def close(self) -> None:
        for fid in list(self.flows):
            await self._discard(fid)

    async def cancel_owner(self, owner: str) -> None:
        for fid, flow in list(self.flows.items()):
            if flow['owner'] == owner:
                async with flow['lock']:
                    await self._discard(fid)

    @staticmethod
    def envelope(response: httpx.Response) -> dict:
        if response.status_code != 200:
            raise HTTPException(502, '授权服务暂时不可用，请稍后重试')
        try:
            obj = response.json()
        except ValueError:
            raise HTTPException(502, '授权服务返回格式异常，请重新生成链接')
        if not isinstance(obj, dict):
            raise HTTPException(502, '授权服务返回格式异常')
        return obj

    async def start(self, owner: str, name: str | None, version: str = 'cn') -> dict:
        """发起浏览器 OAuth 授权流程。

        owner: 用户 session token 哈希（用于隔离并发）
        name:  账号备注名（可为空）
        version: 'cn' 或 'intl'
        """
        async with self.guard:
            await self.cleanup()
            if len(self.flows) >= 16:
                raise HTTPException(429, '等待授权的请求过多，请稍后重试')
            await self.cancel_owner(owner)

            if version == 'intl':
                base = INTL_BASE
                headers = dict(INTL_HEADERS)
                valid_hostname = 'copilot.workbuddy.ai'
                valid_redirect = 'workbuddy.ai'
            else:
                base = CN_BASE
                headers = dict(CN_HEADERS)
                valid_hostname = 'copilot.tencent.com'
                valid_redirect = 'www.codebuddy.cn'

            client = self.client_factory(headers=headers, timeout=20, follow_redirects=False)
            try:
                obj = self.envelope(
                    await client.post(
                        f'{base}/v2/plugin/auth/state',
                        params={'platform': 'CLI'},
                        json={},
                    )
                )
                data = obj.get('data') or {}
                if obj.get('code') != 0 or not isinstance(data, dict):
                    raise HTTPException(502, '无法生成授权链接，请稍后重试')
                state, url = data.get('state') or '', data.get('authUrl') or ''
                if not isinstance(state, str) or not (1 <= len(state) <= 2048):
                    raise HTTPException(502, '授权服务缺少有效的登录信息')
                if not isinstance(url, str) or len(url) > 8192:
                    raise HTTPException(502, '授权服务缺少有效的登录信息')
                parts = urlsplit(url)
                if (parts.scheme != 'https'
                        or parts.hostname != valid_hostname
                        or parts.port not in (None, 443)
                        or parts.username or parts.password
                        or parts.path != '/login'
                        or parse_qs(parts.query).get('state') != [state]):
                    raise HTTPException(502, '授权链接校验失败，请重新生成')

                fid = secrets.token_urlsafe(24)
                flow = {
                    'owner': owner,
                    'state': state,
                    'client': client,
                    'name': name or '',
                    'expires': self.clock() + TTL,
                    'lock': asyncio.Lock(),
                    'next_poll': 0,
                    'tokens': None,
                    'saved': None,
                    'version': version,
                }
                self.flows[fid] = flow
                return {
                    'id': fid,
                    'url': url,
                    'expires_at': int(flow['expires'] * 1000),
                    'interval': 3,
                }
            except BaseException:
                await client.aclose()
                raise

    def get(self, fid: str, owner: str) -> dict:
        flow = self.flows.get(fid)
        if not flow or flow['owner'] != owner:
            raise HTTPException(404, '授权会话不存在，请重新生成登录链接')
        return flow

    async def cancel(self, fid: str, owner: str) -> dict:
        flow = self.get(fid, owner)
        async with flow['lock']:
            await self._discard(fid)
        return {'status': 'cancelled'}

    async def poll(self, fid: str, owner: str) -> dict:
        flow = self.get(fid, owner)
        if flow['lock'].locked():
            return {'status': 'pending'}
        async with flow['lock']:
            if fid not in self.flows:
                raise HTTPException(404, '授权会话已取消')
            if flow['expires'] <= self.clock():
                await self._discard(fid)
                return {'status': 'expired'}
            if flow['saved']:
                return {'status': 'success', **flow['saved']}
            if flow['next_poll'] > self.clock():
                return {'status': 'pending'}
            flow['next_poll'] = self.clock() + 3

            if flow['version'] == 'intl':
                base = INTL_BASE
                headers = dict(INTL_HEADERS)
            else:
                base = CN_BASE
                headers = dict(CN_HEADERS)

            client = flow['client']
            if flow['tokens'] is None:
                resp = await client.get(
                    f'{base}/v2/plugin/auth/token',
                    params={'state': flow['state']},
                    headers=headers,
                )
                obj = self.envelope(resp)
                if obj.get('code') == 11217:
                    return {'status': 'pending'}
                if obj.get('code') != 0:
                    raise HTTPException(502, '上游授权未成功，请重新生成链接并登录')
                tokens = obj.get('data')
                if not isinstance(tokens, dict) or not tokens.get('accessToken') or not tokens.get('refreshToken'):
                    raise HTTPException(502, '授权服务没有返回完整凭据，请重新登录')
                flow['tokens'] = tokens

            tok = flow['tokens']
            resp = await client.get(
                f'{base}/v2/plugin/login/account',
                params={'state': flow['state']},
                headers={**headers, 'Authorization': f'Bearer {tok["accessToken"]}'},
            )
            obj = self.envelope(resp)
            acct = obj.get('data')
            if obj.get('code') != 0 or not isinstance(acct, dict) or not acct.get('uid'):
                raise HTTPException(502, '授权已完成，但账号信息暂未获取成功，请稍后重试')

            auth = {k: tok[k] for k in ['accessToken', 'refreshToken', 'domain'] if k in tok}
            expiry = tok.get('expiresAt')
            if isinstance(expiry, (int, float)) and math.isfinite(expiry) and expiry > 0:
                auth['expiresAt'] = int(expiry * 1000 if expiry < 100000000000 else expiry)
            else:
                seconds = tok.get('expiresIn')
                if not isinstance(seconds, (int, float)) or not math.isfinite(seconds) or seconds <= 0:
                    raise HTTPException(502, '授权服务没有返回有效的令牌到期时间')
                auth['expiresAt'] = int((self.clock() + seconds) * 1000)

            if flow['expires'] <= self.clock():
                await self._discard(fid)
                return {'status': 'expired'}

            doc = {
                'account': {k: acct.get(k, '') for k in ['uid', 'enterpriseId', 'nickname']},
                'auth': auth,
                'version': flow['version'],
            }
            flow['saved'] = self.save_account(doc, flow['name'])
            flow['tokens'] = None
            flow['state'] = ''
            await client.aclose()
            return {'status': 'success', **flow['saved']}
