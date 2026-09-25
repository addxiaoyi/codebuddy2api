"""Click Google broker link → trace full redirect chain."""
from playwright.sync_api import sync_playwright

KC_URL = "https://www.workbuddy.ai/auth/realms/copilot/protocol/openid-connect/auth?client_id=console&response_type=code&redirect_uri=https%3A%2F%2Fwww.workbuddy.ai%2Flogin%2F%3Fplatform%3DCLI%26state%3Dtrace12345&scope=openid%20profile%20email"

with sync_playwright() as p:
    browser = p.chromium.launch(headless=True)
    ctx = browser.new_context()
    page = ctx.new_page()

    print(f"Navigating to Keycloak...")
    page.goto(KC_URL, wait_until="domcontentloaded", timeout=30000)
    page.wait_for_timeout(2000)

    # Find and click Google broker
    google_link = page.locator("a[href*='/broker/google/login']").first
    url = google_link.get_attribute("href")
    print(f"\nGoogle broker URL:\n  {url}\n")
    
    # Navigate there directly to capture redirects
    seen = set()
    def on_response(resp):
        u = resp.url
        if u in seen: return
        seen.add(u)
        key = any(k in u.lower() for k in ["accounts.google", "google.com/o", "oauth2", "signin", "keycloak", "callback", "broker"])
        if key or resp.status in (301, 302, 303):
            loc = resp.headers.get("location", "")[:200]
            extra = f"\n    → 302 {loc}" if resp.status in (301, 302, 303) else ""
            print(f"  ← {resp.status} {u[:140]}{extra}")
    page.on("response", on_response)

    print("Following Google broker redirect chain...")
    try:
        page.goto(url, wait_until="domcontentloaded", timeout=30000)
    except Exception as e:
        print(f"navigation err: {str(e)[:100]}")
    
    page.wait_for_timeout(2000)
    print(f"\nFinal URL: {page.url}")
    
    # Check if we're on Google's sign-in page
    if "google" in page.url:
        text = page.inner_text("body")
        print(f"\nGoogle page text ({len(text)} chars):")
        print(text[:800])
        page.screenshot(path="/tmp/trace-google.png")
    else:
        page.screenshot(path="/tmp/trace-final.png")

    browser.close()
