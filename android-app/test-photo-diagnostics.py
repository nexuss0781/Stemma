from __future__ import annotations

import ast
import json
import io
from PIL import Image
import os
import struct
import threading
import zlib
import time
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parent
WWW = Path(os.environ.get("STEMMA_PHOTO_TEST_WWW", str(ROOT / "www")))
PORT = int(os.environ.get("PHOTO_DIAGNOSTICS_TEST_PORT", "8984"))
BASE_URL = f"http://127.0.0.1:{PORT}"
RESULT_PATH = ROOT / "photo-diagnostics-results.json"
PRIVATE_EMAIL = "private-owner@example.invalid"
PRIVATE_STUDENT_ID = "PRIVATE-STUDENT-ID-7429"
SECRET_MIME = "application/octet-stream; trace=secret-TOKEN"
SECRET_BODY = b'{"private":"BODY-SECRET-TOKEN"}'
SECRET_HEADER = "private-header-secret-TOKEN"

# This is the same native/plugin and remote-fetch mock used by test-bundle.py.
# Extract its INIT assignment as Python syntax only: never import or execute the
# test module itself. Only its deterministic auth/profile GET fixtures are added.
bundle_test = ast.parse((ROOT / "test-bundle.py").read_text())
INIT = next(
    ast.literal_eval(node.value)
    for node in bundle_test.body
    if isinstance(node, ast.Assign)
    and any(isinstance(target, ast.Name) and target.id == "INIT" for target in node.targets)
)
assert "let data={};" in INIT, "test-bundle INIT mock changed; update this test's extension point"
assert "window.__testSession || {authenticated:false,googleConfigured:true,faydaConfigured:false}" in INIT
AUTH_INIT = INIT.replace(
    "window.__testSession || {authenticated:false,googleConfigured:true,faydaConfigured:false}",
    "window.__testSession || {authenticated:true,authProvider:'google',googleConfigured:true,faydaConfigured:false,googleProfile:{email:'private-owner@example.invalid',name:'Private Owner'}}",
    1,
)
AUTH_INIT = AUTH_INIT.replace(
    "else if(url.pathname.startsWith('/api/likee'))",
    "else if(url.pathname==='/api/student-profile')data={profile:{firstName:'Avery',middleName:'Morgan',lastName:'Student',studentId:'PRIVATE-STUDENT-ID-7429',department:'Computer Science',nickName:'Avery',username:'private_owner_7429',bio:'Complete test profile'}};else if(url.pathname.startsWith('/api/likee'))",
    1,
)
assert "studentId:'PRIVATE-STUDENT-ID-7429'" in AUTH_INIT
AUTH_INIT += r'''
window.__copiedPhotoDiagnostics=null;
try{Object.defineProperty(navigator,'clipboard',{configurable:true,value:{writeText:async text=>{window.__copiedPhotoDiagnostics=String(text);}}});}catch{}
'''

def make_png(width: int, height: int) -> bytes:
    """Create a small, valid RGBA PNG without an external imaging dependency."""
    raw = b"".join(b"\0" + bytes((36, 126, 208, 255)) * width for _ in range(height))
    def chunk(kind: bytes, data: bytes) -> bytes:
        payload = kind + data
        return struct.pack(">I", len(data)) + payload + struct.pack(">I", zlib.crc32(payload) & 0xFFFFFFFF)
    return (b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", struct.pack(">2I5B", width, height, 8, 6, 0, 0, 0))
            + chunk(b"IDAT", zlib.compress(raw)) + chunk(b"IEND", b""))


PNG_31X23 = make_png(31, 23)

def make_webp_15284():
    out=io.BytesIO();Image.new("RGB",(31,23),(36,126,208)).save(out,format="WEBP",quality=85)
    data=out.getvalue();padding=15284-len(data)-8
    assert padding>=0 and padding%2==0
    result=data+b"JUNK"+struct.pack("<I",padding)+bytes(padding)
    result=result[:4]+struct.pack("<I",len(result)-8)+result[8:]
    with Image.open(io.BytesIO(result)) as image: assert image.size==(31,23)
    assert len(result)==15284
    return result

WEBP_15284=make_webp_15284()


class QuietHandler(SimpleHTTPRequestHandler):
    def log_message(self, _format, *_args):
        pass


def serve_www():
    handler = lambda *args, **kwargs: QuietHandler(*args, directory=str(WWW), **kwargs)
    server = ThreadingHTTPServer(("0.0.0.0", PORT), handler)
    server.daemon_threads = True
    threading.Thread(target=server.serve_forever, daemon=True).start()
    return server


local_requests: list[dict] = []
response_plan: list[dict] = []
page_errors: list[str] = []
plan_lock = threading.Lock()


def set_plan(*entries: dict):
    with plan_lock:
        response_plan.clear()
        response_plan.extend(entries)


def route_photo(route):
    request = route.request
    local_requests.append({"url": request.url, "method": request.method, "headers": request.headers})
    with plan_lock:
        entry = response_plan.pop(0) if response_plan else {"status": 404, "body": b""}
    if entry.get("abort"):
        route.abort(entry.get("abort", "failed"))
        return
    headers = dict(entry.get("headers", {}))
    if entry.get("mime") is not None:
        headers["Content-Type"] = entry["mime"]
    body = entry.get("body", b"")
    route.fulfill(status=entry.get("status", 200), headers=headers, body=body)


def assert_safe_snapshot(snapshot: dict):
    expected_keys = {
        "appVersion", "versionCode", "timestamp", "phase", "endpoint", "signedIn",
        "httpStatus", "errorCategory", "responseMime", "declaredByteLength", "byteLength",
        "route", "nativeStatus", "nativePhase", "nativeError", "decode", "retries",
        "attempt", "elapsedMs", "result", "magicType", "normalizedMime", "nativeMime", "nativeDeclaredByteLength", "headerValueCounts",
    }
    assert set(snapshot) == expected_keys, snapshot
    assert snapshot["appVersion"] == "1.0.8" and snapshot["versionCode"] == 9, snapshot
    assert snapshot["endpoint"] == "/api/student-profile/photo", snapshot
    assert PRIVATE_EMAIL not in json.dumps(snapshot)
    assert PRIVATE_STUDENT_ID not in json.dumps(snapshot)
    assert "private_owner_7429" not in json.dumps(snapshot)
    assert "blob:" not in json.dumps(snapshot).lower()
    assert "?" not in snapshot["endpoint"]
    assert snapshot["timestamp"] and snapshot["route"] in {"localhost-webview", "browser-unconfirmed", "native-proxy", "not-observed"}


def assert_no_device_reads_or_mutations(page, case_name):
    outcome = page.evaluate("""()=>{
      const calls=window.__calls||[];
      const deviceReads=calls.filter(c=>c.name==='StemmaMedia'&&['requestAccess','listAlbums','listMedia','thumbnail','readFile','selectFile','recentFiles'].includes(c.method));
      const mutations=calls.filter(c=>
        (c.name==='StemmaTransport'&&c.method==='request'&&['POST','PUT','PATCH','DELETE'].includes(String(c.options?.method||'GET').toUpperCase()))||
        (c.name==='Filesystem'&&c.method==='writeFile')
      );
      return {deviceReads,mutations};
    }""")
    assert not outcome["deviceReads"], (case_name, outcome)
    assert not outcome["mutations"], (case_name, outcome)
    assert all(item["method"] == "GET" for item in local_requests if item["url"].startswith(BASE_URL + "/api/student-profile/photo")), (case_name, local_requests)


def open_authenticated_page(browser, response_entries):
    context = browser.new_context(viewport={"width": 390, "height": 844})
    context.add_init_script(AUTH_INIT)
    page = context.new_page()
    page.on("pageerror", lambda error: page_errors.append(str(error)))
    page.route("**/api/student-profile/photo", route_photo)
    set_plan(*response_entries)
    response = page.goto(BASE_URL + "/", wait_until="networkidle")
    assert response and response.ok, "bundled app shell failed to load"
    page.wait_for_function("window.StemmaPhotoDiagnostics && window.StemmaPhotoDiagnostics.snapshot()")
    page.wait_for_function("!document.getElementById('onboarding-screen') || document.getElementById('onboarding-screen').hidden", timeout=10000)
    page.wait_for_function("document.querySelector('.nav-item[data-route=profile]')")
    return context, page


def navigate_profile(page):
    page.locator('.nav-item[data-route="profile"]').click()
    page.locator('#dashboard-grid[aria-label="Your profile"]').wait_for(state="visible")
    page.wait_for_function("document.querySelector('#dashboard-grid[aria-label=\"Your profile\"] .student-profile-page')")


def get_report(page):
    panel = page.locator('details[data-photo-diagnostics]')
    panel.wait_for(state="attached")
    assert panel.locator("summary").inner_text() == "Photo diagnostics"
    if not panel.evaluate("el=>el.open"):
        panel.locator("summary").click()
    assert panel.locator("button[data-copy-photo-diagnostics]").inner_text() == "Copy details"
    assert page.locator(".student-profile-notice").count() == 1
    assert page.locator(".student-profile-notice").evaluate("el=>el.nextElementSibling===document.querySelector('details[data-photo-diagnostics]')")
    text = panel.locator("pre[data-photo-diagnostic-text]").text_content()
    snapshot = json.loads(text)
    assert_safe_snapshot(snapshot)
    return panel, text, snapshot


def assert_success_both_views(browser, mime="image/png", headers=None, body=PNG_31X23, magic="PNG", normalized="image/png"):
    context, page = open_authenticated_page(browser, [{"status": 200, "mime": mime, "body": body, "headers":headers or {}}])
    page.wait_for_function("()=>{const i=document.getElementById('overview-profile-photo');return i&&i.complete&&i.naturalWidth===31&&i.naturalHeight===23}")
    overview = page.evaluate("({src:document.getElementById('overview-profile-photo').getAttribute('src'),hidden:document.getElementById('overview-profile-photo').hidden,snapshot:window.StemmaPhotoDiagnostics.snapshot()})")
    assert not overview["hidden"] and overview["src"], overview
    assert overview["snapshot"]["result"] == "success" and overview["snapshot"]["decode"] == {"ok": True, "width": 31, "height": 23}, overview
    navigate_profile(page)
    page.wait_for_function("()=>{const i=document.getElementById('profile-photo-image');return i&&i.complete&&i.naturalWidth===31&&i.naturalHeight===23}")
    image = page.evaluate("({width:document.getElementById('profile-photo-image').naturalWidth,height:document.getElementById('profile-photo-image').naturalHeight})")
    assert image == {"width": 31, "height": 23}, image
    assert page.locator("details[data-photo-diagnostics],.student-profile-notice").count() == 0
    snap = page.evaluate("window.StemmaPhotoDiagnostics.snapshot()")
    assert snap["result"] == "success" and snap["decode"] == {"ok": True, "width": 31, "height": 23}, snap
    assert snap["byteLength"] == len(body), snap
    assert snap["declaredByteLength"]==len(body) and snap["headerValueCounts"]["responseContentLength"]==1,snap
    assert snap["magicType"]==magic and snap["normalizedMime"]==normalized,snap
    assert snap["responseMime"]==(mime.split(';')[0].lower() if mime else "missing"),snap
    assert_no_device_reads_or_mutations(page,"valid-image-"+str(mime))
    if headers:
        assert snap["nativeMime"]==headers.get("X-Stemma-Photo-Content-Type"),snap
        expected_length=headers.get("X-Stemma-Photo-Content-Length","missing")
        assert snap["nativeDeclaredByteLength"]==(int(expected_length) if expected_length.isdigit() else expected_length),snap
        assert snap["route"]=="native-proxy",snap
        for suffix,key in [("Type","nativeContentType"),("Length","nativeContentLength")]:
            value=headers.get("X-Stemma-Photo-Content-"+suffix+"-Values")
            if value is not None:assert snap["headerValueCounts"][key]==int(value),snap
    assert snap["headerValueCounts"]["responseContentType"]==(mime.count(',')+1 if mime else 0),snap
    assert all(r["method"] == "GET" for r in local_requests), local_requests
    context.close()
    return {"overviewDecoded31x23": True, "profileDecoded31x23": True, "failurePanelHidden": True}


def assert_failure_case(browser, name, response, expected_status, expected_category, expected_mime=None, native=None):
    local_requests.clear()
    context, page = open_authenticated_page(browser, [response])
    if response.get("abort"):
        # Wait for the request rejection and then show the real page's diagnostic panel.
        page.wait_for_function("window.StemmaPhotoDiagnostics.snapshot()?.result==='failure'", timeout=10000)
    navigate_profile(page)
    panel, text, snapshot = get_report(page)
    assert snapshot["result"] == "failure" and snapshot["httpStatus"] == expected_status, (name, snapshot)
    assert snapshot["errorCategory"] == expected_category, (name, snapshot)
    if expected_mime is not None:
        assert snapshot["responseMime"] == expected_mime, (name, snapshot)
    if native:
        for key, value in native.items():
            assert snapshot[key] == value, (name, key, snapshot)
    assert_no_device_reads_or_mutations(page, name)
    copy = panel.locator("button[data-copy-photo-diagnostics]")
    copy.click()
    page.wait_for_function("window.__copiedPhotoDiagnostics!==null")
    copied = page.evaluate("window.__copiedPhotoDiagnostics")
    assert copied == text, (name, "clipboard did not capture exact rendered JSON", copied, text)
    for secret in (PRIVATE_EMAIL, PRIVATE_STUDENT_ID, "private_owner_7429", "BODY-SECRET-TOKEN", SECRET_HEADER, "secret-TOKEN", "RAW-ERROR-BODY-TOKEN", "blob:"):
        assert secret.lower() not in copied.lower(), (name, "sensitive value leaked", secret, copied)
    context.close()
    return snapshot


def main():
    if not WWW.is_dir() or not (WWW / "index.html").is_file():
        raise RuntimeError(f"Bundled www shell is missing: {WWW}")
    server = serve_www()
    page_errors.clear()
    results = {}
    try:
        with sync_playwright() as p:
            browser = p.chromium.launch(executable_path=os.environ.get("CHROMIUM_PATH", "/usr/bin/chromium"), headless=True, args=["--no-sandbox"])
            try:
                # Fail early if the just-built regular www bundle does not carry the feature.
                probe_context, probe_page = open_authenticated_page(browser, [{"status": 200, "mime": "image/png", "body": PNG_31X23}])
                assert probe_page.evaluate("typeof window.StemmaPhotoDiagnostics==='object'"), "bundle lacks StemmaPhotoDiagnostics; rebuild www before running this test"
                probe_context.close()
                local_requests.clear()

                results["successfulImage"] = assert_success_both_views(browser)
                results["octetStreamRecoveredBothViews"]=assert_success_both_views(browser,"application/octet-stream")
                results["missingMimeRecoveredBothViews"]=assert_success_both_views(browser,None)
                results["unexpectedMimeRecoveredBothViews"]=assert_success_both_views(browser,"binary/octet-stream")
                results["duplicateMimeRecoveredBothViews"]=assert_success_both_views(browser,"image/png, image/png")
                results["upstreamMetadataPreserved"]=assert_success_both_views(browser,"application/octet-stream",{"X-Stemma-Photo-Route":"native-proxy","X-Stemma-Photo-Status":"200","X-Stemma-Photo-Phase":"headers","X-Stemma-Photo-Error":"none","X-Stemma-Photo-Content-Type":"image/jpg","X-Stemma-Photo-Content-Length":"missing"})

                native_headers={"X-Stemma-Photo-Route":"native-proxy","X-Stemma-Photo-Status":"200","X-Stemma-Photo-Phase":"headers","X-Stemma-Photo-Error":"none","X-Stemma-Photo-Content-Type":"image/webp","X-Stemma-Photo-Content-Length":"15284","X-Stemma-Photo-Content-Type-Values":"1","X-Stemma-Photo-Content-Length-Values":"1"}
                results["webp15284DecodesBothViews"]=assert_success_both_views(browser,"image/webp",native_headers,WEBP_15284,"WebP","image/webp")
                duplicate_upstream={**native_headers,"X-Stemma-Photo-Content-Type":"image/webp, image/webp","X-Stemma-Photo-Content-Type-Values":"2","X-Stemma-Photo-Content-Length-Values":"2"}
                results["upstreamDuplicatesCanonicalOnOutput"]=assert_success_both_views(browser,"image/webp",duplicate_upstream,WEBP_15284,"WebP","image/webp")
                owner=assert_failure_case(browser,"legacy105-duplicated-header-report",{"status":200,"mime":"image/webp, image/webp","body":WEBP_15284,"headers":{**native_headers,"Content-Length":"15284, 15284"}},200,"content-length","image/webp, image/webp")
                assert owner["headerValueCounts"]=={"responseContentType":2,"responseContentLength":2,"nativeContentType":1,"nativeContentLength":1},owner
                assert owner["byteLength"] is None and owner["declaredByteLength"]=="invalid",owner
                results["legacy105FailureNowIdentifiesDuplicateCounts"]=True

                local_requests.clear()
                auth_snapshot = assert_failure_case(browser, "401", {"status": 401, "mime": "text/plain", "body": SECRET_BODY}, 401, "http", "text/plain")
                assert auth_snapshot["signedIn"] is False, auth_snapshot
                results["http401"] = {"status": auth_snapshot["httpStatus"], "visible": True, "noDeviceReadOrMutation": True}

                local_requests.clear()
                server_snapshot = assert_failure_case(browser, "503-native-tls", {
                    "status": 503, "mime": "image/png", "body": SECRET_BODY,
                    "headers": {"X-Stemma-Photo-Route": "native-proxy", "X-Stemma-Photo-Status": "503", "X-Stemma-Photo-Phase": "connect", "X-Stemma-Photo-Error": "tls"},
                }, 503, "tls", "image/png", {"route": "native-proxy", "nativeStatus": 503, "nativePhase": "connect", "nativeError": "tls"})
                results["http503NativeHeaders"] = {"status": server_snapshot["httpStatus"], "nativeRouteAndTlsCaptured": True, "noDeviceReadOrMutation": True}

                local_requests.clear()
                unsupported = assert_failure_case(browser, "unsupported-mime", {
                    "status": 200, "mime": SECRET_MIME, "body": SECRET_BODY,
                    "headers": {"X-Stemma-Photo-Route": "native-proxy", "X-Stemma-Photo-Status": "not-a-status", "X-Stemma-Photo-Phase": "untrusted-phase", "X-Stemma-Photo-Error": SECRET_HEADER},
                }, 200, "non-image", "application/octet-stream", {"route": "native-proxy", "nativeStatus": None, "nativePhase": None, "nativeError": None})
                assert unsupported["responseMime"] == "application/octet-stream" and unsupported["magicType"]=="unknown"
                results["unsupportedMimeAndHostileHeaders"] = {"mimeSanitized": True, "untrustedHeadersDiscarded": True}

                local_requests.clear()
                bad_length = assert_failure_case(browser, "invalid-content-length", {
                    "status": 200, "mime": "image/png", "body": PNG_31X23,
                    "headers": {"Content-Length": "not-a-length-TOKEN"},
                }, 200, "content-length", "image/png")
                assert bad_length["declaredByteLength"] == "invalid", bad_length
                results["invalidContentLength"] = {"invalidValueNotCopied": True, "declaredLengthInvalid": True}

                local_requests.clear()
                corrupt = assert_failure_case(browser, "corrupt-image", {"status": 200, "mime": "image/png", "body": PNG_31X23[:33]+b"RAW-ERROR-BODY-TOKEN-corrupt"}, 200, "corrupt-image", "image/png")
                assert corrupt["decode"]["ok"] is False, corrupt
                results["corruptImageDecode"] = {"actualDecodeFailure": True, "decode": corrupt["decode"]}
                non_image=assert_failure_case(browser,"html-spoofed-image",{"status":200,"mime":"image/png","body":b"<html><body>RAW-ERROR-BODY-TOKEN login</body></html>"},200,"non-image","image/png")
                assert non_image["magicType"]=="unknown" and non_image["phase"]=="signature-validation"
                results["htmlRejectedBeforeDecode"]=True
                unsupported_image=assert_failure_case(browser,"unsupported-gif",{"status":200,"mime":"image/gif","body":b"GIF89a"+b"\x00"*20},200,"mime","image/gif")
                assert unsupported_image["magicType"]=="GIF" and unsupported_image["decode"]["ok"] is None
                results["recognizedUnsupportedGifRejected"]=True

                local_requests.clear()
                aborted = assert_failure_case(browser, "network-abort", {"abort": "failed"}, None, "network")
                assert aborted["httpStatus"] is None, aborted
                results["networkAbort"] = {"networkFailureVisible": True, "noDeviceReadOrMutation": True}

                local_requests.clear()
                not_found = assert_failure_case(browser, "404", {"status": 404, "mime": "text/plain", "body": b"not found"}, 404, "not-found", "text/plain")
                results["http404"] = {"status": not_found["httpStatus"], "notFoundVisible": True, "noDeviceReadOrMutation": True}

                # A transient 503 then a successful retry should clear the UI diagnostics.
                local_requests.clear()
                context, page = open_authenticated_page(browser, [
                    {"status": 503, "mime": "text/plain", "body": SECRET_BODY},
                    {"status": 200, "mime": "image/png", "body": PNG_31X23},
                ])
                navigate_profile(page)
                panel, _, first = get_report(page)
                assert first["httpStatus"] == 503 and first["result"] == "failure", first
                page.locator("button[data-retry-profile-photo]").click()
                page.wait_for_function("window.StemmaPhotoDiagnostics.snapshot()?.result==='success'", timeout=10000)
                page.wait_for_function("!document.querySelector('details[data-photo-diagnostics]')")
                page.wait_for_function("()=>{const i=document.getElementById('profile-photo-image');return i&&i.complete&&i.naturalWidth===31&&i.naturalHeight===23}")
                retried = page.evaluate("window.StemmaPhotoDiagnostics.snapshot()")
                assert retried["retries"] == 1 and retried["attempt"] == 2, retried
                assert page.locator(".student-profile-notice,details[data-photo-diagnostics]").count() == 0
                assert len(local_requests) == 2, local_requests
                assert all(request["method"] == "GET" for request in local_requests), local_requests
                assert_no_device_reads_or_mutations(page, "retry503-success")
                results["retry503ThenSuccess"] = {"retries": retried["retries"], "panelHiddenAfterSuccess": True, "decode": retried["decode"]}
                context.close()

                assert not page_errors, page_errors
                results["browserPageErrors"] = page_errors
                output = {"ok": True, "results": results}
                RESULT_PATH.write_text(json.dumps(output, indent=2) + "\n")
                print(json.dumps(output, indent=2))
            finally:
                browser.close()
    finally:
        server.shutdown()
        server.server_close()


if __name__ == "__main__":
    main()
