"""Trace Keycloak (workbuddy.ai auth realm) login page and Google OAuth chain."""
from playwright.sync_api import sync_playwright

with sync_playwright() as p:
    browser = p.chromium.launch(headless=True)
    ctx = browser.new_context()
    page = ctx.new_page()

    print("=== Step 1: Load workbuddy login page with real OAuth state ===")
    # First get a real OAuth state from our backend
    import httpx
    r = httpx.post("http://localhost:7864/api/oauth/start", 
                   json={"version": "intl"},
                   headers={"Content-Type": "application/json"},
                   cookies={"wb_session": "eyJ1c2VybmFtZSI6ICJhZG1pbiIsICJyb2xlIjogImFkbWluIiwgInN2IjogMCwgImlhdCI6IDE3OTAzMTQ1OTksICJvcmlnIjogMTc5MDMxNDU5OSwgImV4cCI6IDE3OTA0MDA5OTl9fDYxN2EyYzlhMWY0N2EyYTQzMWMwZDA3YzQ2OWI2NmM0ODA2ZjE3NDUyY2RhZTYyYmZjOTQ3MDQyZTI2YzYwMzU="})
    oauth_data = r.json()
    state = oauth_data["url"].split("state=")[1].split("&")[0]
    print(f"  state={state}")
    print(f"  oauth_url={oauth_data['url']}")

    # Trace all requests  
    seen = set()
    def on_response(resp):
        u = resp.url
        if u in seen: return
        seen.add(u)
        if any(k in u.lower() for k in ["keycloak", "openid", "oauth", "google", "sso", "login", "auth"]):
            loc = resp.headers.get("location", "")[:160]
            extra = f"  → 302 {loc}" if resp.status in (301, 302, 303) else ""
            print(f"  ← {resp.status} {u[:130]}{extra}")
    page.on("response", on_response)

    print("\n=== Step 2: Navigate through OAuth URL ===")
    page.goto(oauth_data["url"], wait_until="domcontentloaded", timeout=30000)
    page.wait_for_timeout(3000)
    print(f"  Final URL: {page.url}")
    page.screenshot(path="/tmp/trace-keycloak.png", full_page=True)

    text = page.inner_text("body")
    print(f"\n=== Page text ===")
    print(text[:1500])

    # List all clickable elements  
    print("\n=== Clickable elements ===")
    all_a = page.locator("a, button, [role='button'], input[type='submit']")
    n = all_a.count()
    for i in range(min(n, 30)):
        try:
            el = all_a.nth(i)
            tag = el.evaluate("e=>e.tagName")
            txt = el.inner_text(timeout=300).strip()[:80] or el.get_attribute("value") or "(no text)"
            href = el.get_attribute("href") or ""
            onclick = el.get_attribute("onclick") or ""
            cls = el.get_attribute("class") or ""
            print(f"  [{i}] <{tag}> text='{txt}' href={href[:60]} cls={cls[:40]}")
        except:
            pass

    # List all forms and inputs
    print("\n=== Forms & Inputs ===")
    forms = page.locator("form")
    for i in range(forms.count()):
        print(f"  Form[{i}] action={forms.nth(i).get_attribute('action')}")
        inputs = forms.nth(i).locator("input")
        for j in range(inputs.count()):
            t = inputs.nth(j).get_attribute("type") or "text"
            n_ = inputs.nth(j).get_attribute("name") or ""
            ph = inputs.nth(j).get_attribute("placeholder") or ""
            print(f"    input type={t} name={n_} placeholder={ph}")

    browser.close()
