"""批量登录的会话隔离：N 个会话同属一个 owner，不能互相顶掉。

回归背景：start() 默认会清空该 owner 的旧会话（单个登录时防止叠出一堆浏览器
会话）。批量登录前端并发建 N 个会话，若照旧清空，只有最后一个能轮询到结果，
其余全是 404 —— 界面表现就是「只有最后一个格子能登录」。
"""
from __future__ import annotations

import sys
import unittest
from pathlib import Path

import httpx
from fastapi import HTTPException

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from server.services.browser_login import BrowserLogin


class BatchSessionTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        self.seq = 0

        def respond(req: httpx.Request) -> httpx.Response:
            if req.url.path.endswith('/state'):
                self.seq += 1
                state = f's{self.seq}'
                return httpx.Response(200, json={
                    'code': 0,
                    'data': {
                        'state': state,
                        'authUrl': f'https://www.workbuddy.ai/login?state={state}',
                    },
                })
            return httpx.Response(200, json={'code': 11217, 'msg': 'login ing'})

        self.manager = BrowserLogin(
            save_account=lambda *a, **kw: {},
            client_factory=lambda **kw: httpx.AsyncClient(
                transport=httpx.MockTransport(respond)
            ),
        )

    async def asyncTearDown(self):
        await self.manager.close()

    async def test_keep_leaves_earlier_sessions_pollable(self):
        first = await self.manager.start('owner', 'batch-01', 'intl')
        second = await self.manager.start('owner', 'batch-02', 'intl', keep=True)

        self.assertEqual(len(self.manager.flows), 2)
        self.assertEqual(
            (await self.manager.poll(first['id'], 'owner'))['status'], 'pending')
        self.assertEqual(
            (await self.manager.poll(second['id'], 'owner'))['status'], 'pending')

    async def test_default_start_still_replaces(self):
        stale = await self.manager.start('owner', 'single', 'intl')
        await self.manager.start('owner', 'single-again', 'intl')

        self.assertEqual(len(self.manager.flows), 1)
        with self.assertRaises(HTTPException) as ctx:
            await self.manager.poll(stale['id'], 'owner')
        self.assertEqual(ctx.exception.status_code, 404)


if __name__ == '__main__':
    unittest.main()
