"""Trace Keycloak login page directly."""
from playwright.sync_api import sync_playwright

KC_URL = "https://www.workbuddy.ai/auth/realms/copilot/protocol/openid-connect/auth?client_id=console&response_type=code&redirect_uri=https%3A%2F%2Fwww.workbuddy.ai%2Flogin%2F%3Fplatform%3DCLI%26state%3Dtest12345&scope=openid%20profile%20email&nonce=trace"

with sync_playwright() as p:
    browser = p.chromium.launch(headless=True)
    ctx = browser.new_context()
    page = ctx.new_page()

    print(f"Navigating to Keycloak directly...")
    
    seen = set()
    def on_response(resp):
        u = resp.url
        if u in seen: return
        seen.add(u)
        key = any(k in u.lower() for k in ["keycloak", "openid", "oauth", "google", "accounts.google", "sso", "login", "auth", "callback"])
        if key:
            loc = resp.headers.get("location", "")[:200]
            extra = f"\n    → 302 {loc}" if resp.status in (301, 302, 303) else ""
            print(f"  ← {resp.status} {u[:150]}{extra}")
    page.on("response", on_response)

    try:
        page.goto(KC_URL, wait_until="domcontentloaded", timeout=30000)
    except Exception as e:
        print(f"goto err: {e}")
    
    page.wait_for_timeout(4000)
    print(f"\nFinal URL: {page.url}")

    # Screenshot
    page.screenshot(path="/tmp/trace-kc.png", full_page=True)
    print("Screenshot saved.")

    text = page.inner_text("body")
    print(f"\n=== Page text ({len(text)} chars) ===")
    print(text[:2000])

    # All elements
    print("\n=== All form elements ===")
    all_inputs = page.locator("input, button, a")
    for i in range(all_inputs.count()):
        try:
            el = all_inputs.nth(i)
            tag = el.evaluate("e=>e.tagName")
            txt = (el.inner_text(timeout=300) or el.get_attribute("value") or "").strip()[:80]
            name = el.get_attribute("name") or ""
            type_ = el.get_attribute("type") or ""
            href = el.get_attribute("href") or ""
            cls = el.get_attribute("class") or ""
            if txt or name or href:
                print(f"  [{i}] <{tag}> name='{name}' type='{type_}' text='{txt}' href={href[:60]} cls={cls[:50]}")
        except:
            pass

    # All links containing google or identity provider
    print("\n=== Keycloak identity provider links ===")
    links = page.locator("a[href*='google'], a[href*='identity-provider'], a[href*='redirect'], a[href*='broker']")
    for i in range(links.count()):
        href = links.nth(i).get_attribute("href") or ""
        txt = links.nth(i).inner_text() or ""
        print(f"  [{i}] text='{txt.strip()[:50]}' href={href[:150]}")

    browser.close()
