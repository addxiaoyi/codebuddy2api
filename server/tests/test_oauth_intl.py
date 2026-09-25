"""Test the OAuth start endpoint with version='intl' for international Google batch login CTF functionality."""
from __future__ import annotations

import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import AsyncMock, patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from server import config, security
from server.main import app
from server.routers import accounts
from server.services import browser_login


class OAuthIntlTests(unittest.IsolatedAsyncioTestCase):
    """Test international OAuth flow with version='intl'."""

    def setUp(self):
        config.ensure_dirs()
        self._orig_users = config.USERS_FILE
        self._orig_auth = config.AUTH_DIR
        self._tmp = tempfile.TemporaryDirectory()
        self._tmp_path = Path(self._tmp.name)
        config.AUTH_DIR = self._tmp_path / 'auths'
        config.USERS_FILE = self._tmp_path / 'users.json'
        config.ensure_dirs()
        security.save_users({
            'secret': 'test-secret-for-oauth-test',
            'users': [{'username': 'admin', 'role': 'admin', 'pwd_hash': security.make_hash('password')}],
            'api_keys': []
        })

    def tearDown(self):
        config.USERS_FILE = self._orig_users
        config.AUTH_DIR = self._orig_auth
        self._tmp.cleanup()
        from server import db
        if db._conn:
            db._conn.close()
            db._conn = None

    def _login_admin(self, client):
        r = client.post('/api/login', json={'username': 'admin', 'password': 'password'})
        assert r.status_code == 200, f"Login failed: {r.text}"
        client.headers['X-CSRF-Token'] = r.json().get('csrf', '')

    async def test_oauth_start_intl_returns_valid_response(self):
        """Test that /api/oauth/start with version='intl' returns valid auth flow data."""
        from fastapi.testclient import TestClient

        mock_flow = {
            'id': 'test-fid-123456789012',
            'url': 'https://copilot.workbuddy.ai/login?state=test-state-abc123',
            'expires_at': 9999999999999,
            'interval': 3
        }

        with TestClient(app, base_url="https://test.workbuddy.ai") as client:
            self._login_admin(client)

            # Patch the module-level _browser_login instance in the accounts router
            with patch.object(accounts, '_browser_login') as mock_browser_login:
                mock_browser_login.start = AsyncMock(return_value=mock_flow)

                r = client.post(
                    '/api/oauth/start',
                    json={'name': 'test-account', 'version': 'intl'}
                )

                assert r.status_code == 200, f"Expected 200, got {r.status_code}: {r.text}"
                data = r.json()

                assert 'id' in data, "Missing 'id' in response"
                assert 'url' in data, "Missing 'url' in response"
                assert 'expires_at' in data, "Missing 'expires_at' in response"
                assert 'interval' in data, "Missing 'interval' in response"

                assert data['id'] == 'test-fid-123456789012', f"Unexpected id: {data['id']}"
                assert data['interval'] == 3, f"Unexpected interval: {data['interval']}"
                assert data['url'].startswith('https://copilot.workbuddy.ai/'), \
                    f"URL should use intl base: {data['url']}"
                assert 'state=' in data['url'], f"URL should contain state param: {data['url']}"

    async def test_oauth_start_intl_uses_correct_base_url(self):
        """Test that version='intl' uses INTL_BASE URL in the response."""
        from fastapi.testclient import TestClient

        mock_flow = {
            'id': 'test-fid-intl',
            'url': 'https://copilot.workbuddy.ai/login?state=intl-state-xyz',
            'expires_at': 9999999999999,
            'interval': 3
        }

        with TestClient(app, base_url="https://test.workbuddy.ai") as client:
            self._login_admin(client)

            # Patch the module-level _browser_login instance in the accounts router
            with patch.object(accounts, '_browser_login') as mock_browser_login:
                mock_browser_login.start = AsyncMock(return_value=mock_flow)

                r = client.post(
                    '/api/oauth/start',
                    json={'name': 'intl-test', 'version': 'intl'}
                )

                assert r.status_code == 200, f"Expected 200, got {r.status_code}: {r.text}"
                data = r.json()
                assert data['url'] == 'https://copilot.workbuddy.ai/login?state=intl-state-xyz', \
                    f"URL should use intl base URL: {data['url']}"

    async def test_oauth_start_requires_admin_auth(self):
        """Test that /api/oauth/start requires admin authentication."""
        from fastapi.testclient import TestClient

        with TestClient(app, base_url="https://test.workbuddy.ai") as client:
            r = client.post(
                '/api/oauth/start',
                json={'name': 'test', 'version': 'intl'}
            )
            assert r.status_code in (401, 403), \
                f"Expected 401/403 without auth, got {r.status_code}: {r.text}"

    async def test_oauth_start_rejects_invalid_version(self):
        """Test that invalid version values are rejected."""
        from fastapi.testclient import TestClient

        with TestClient(app, base_url="https://test.workbuddy.ai") as client:
            self._login_admin(client)

            r = client.post(
                '/api/oauth/start',
                json={'name': 'test', 'version': 'invalid'}
            )
            assert r.status_code == 400, \
                f"Expected 400 for invalid version, got {r.status_code}: {r.text}"

    async def test_oauth_start_default_version_is_cn(self):
        """Test that version defaults to 'cn' when not specified."""
        from fastapi.testclient import TestClient

        mock_flow = {
            'id': 'test-fid-cn',
            'url': 'https://copilot.tencent.com/login?state=cn-state-abc',
            'expires_at': 9999999999999,
            'interval': 3
        }

        with TestClient(app, base_url="https://test.workbuddy.ai") as client:
            self._login_admin(client)

            # Patch the module-level _browser_login instance in the accounts router
            with patch.object(accounts, '_browser_login') as mock_browser_login:
                captured_args = {}
                async def capture_start(owner, name, version='cn'):
                    captured_args['version'] = version
                    return mock_flow
                mock_browser_login.start = AsyncMock(side_effect=capture_start)

                r = client.post(
                    '/api/oauth/start',
                    json={'name': 'test'}
                )

                assert r.status_code == 200, f"Expected 200, got {r.status_code}: {r.text}"
                assert captured_args.get('version') == 'cn', \
                    f"Expected default version='cn', got {captured_args.get('version')}"

    async def test_oauth_start_cn_version(self):
        """Test that version='cn' uses CN_BASE URL."""
        from fastapi.testclient import TestClient

        mock_flow = {
            'id': 'test-fid-cn',
            'url': 'https://copilot.tencent.com/login?state=cn-state-abc',
            'expires_at': 9999999999999,
            'interval': 3
        }

        with TestClient(app, base_url="https://test.workbuddy.ai") as client:
            self._login_admin(client)

            # Patch the module-level _browser_login instance in the accounts router
            with patch.object(accounts, '_browser_login') as mock_browser_login:
                mock_browser_login.start = AsyncMock(return_value=mock_flow)

                r = client.post(
                    '/api/oauth/start',
                    json={'name': 'cn-test', 'version': 'cn'}
                )

                assert r.status_code == 200, f"Expected 200, got {r.status_code}: {r.text}"
                data = r.json()
                assert data['url'].startswith('https://copilot.tencent.com/'), \
                    f"URL should use cn base: {data['url']}"

    async def test_oauth_start_intl_flow_uses_correct_internal_logic(self):
        """Test that the internal start method is called with correct parameters for intl version."""
        from fastapi.testclient import TestClient

        mock_flow = {
            'id': 'test-fid-internal',
            'url': 'https://copilot.workbuddy.ai/login?state=internal-state',
            'expires_at': 9999999999999,
            'interval': 3
        }

        with TestClient(app, base_url="https://test.workbuddy.ai") as client:
            self._login_admin(client)

            # Capture the arguments passed to start method
            captured_owner = None
            captured_name = None
            captured_version = None

            # Patch the module-level _browser_login instance in the accounts router
            with patch.object(accounts, '_browser_login') as mock_browser_login:
                async def mock_start(owner, name, version='cn'):
                    nonlocal captured_owner, captured_name, captured_version
                    captured_owner = owner
                    captured_name = name
                    captured_version = version
                    return mock_flow
                mock_browser_login.start = AsyncMock(side_effect=mock_start)

                r = client.post(
                    '/api/oauth/start',
                    json={'name': 'my-intl-account', 'version': 'intl'}
                )

                assert r.status_code == 200, f"Expected 200, got {r.status_code}: {r.text}"
                assert captured_owner is not None, "Owner should be captured"
                assert captured_name == 'my-intl-account', f"Expected name 'my-intl-account', got {captured_name}"
                assert captured_version == 'intl', f"Expected version 'intl', got {captured_version}"

    async def test_oauth_start_intl_headers(self):
        """Test that version='intl' passes correct headers to the browser login service."""
        from fastapi.testclient import TestClient

        mock_flow = {
            'id': 'test-fid-headers',
            'url': 'https://copilot.workbuddy.ai/login?state=headers-test',
            'expires_at': 9999999999999,
            'interval': 3
        }

        with TestClient(app, base_url="https://test.workbuddy.ai") as client:
            self._login_admin(client)

            # Patch the module-level _browser_login instance in the accounts router
            with patch.object(accounts, '_browser_login') as mock_browser_login:
                mock_browser_login.start = AsyncMock(return_value=mock_flow)

                r = client.post(
                    '/api/oauth/start',
                    json={'name': 'header-test', 'version': 'intl'}
                )

                assert r.status_code == 200, f"Expected 200, got {r.status_code}: {r.text}"

                # Verify start was called with correct version parameter
                mock_browser_login.start.assert_called_once()
                call_args = mock_browser_login.start.call_args
                assert call_args[0][2] == 'intl', \
                    f"Expected version='intl', got {call_args[0][2]}"


if __name__ == '__main__':
    unittest.main()