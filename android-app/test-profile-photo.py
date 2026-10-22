from __future__ import annotations

import ast
import json
import os
import threading
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parent
WWW = ROOT / "www"
PORT = int(os.environ.get("PROFILE_PHOTO_TEST_PORT", "8974"))
BASE_URL = f"http://127.0.0.1:{PORT}"
RESULT_PATH = ROOT / "profile-photo-results.json"

# Reuse the repository's normal bundled-shell/native-plugin test mock. The
# added branch models the Capacitor generic remote GET proxy: it returns the
# bytes but drops Content-Type, which is the regression this route avoids.
bundle_test = ast.parse((ROOT / "test-bundle.py").read_text())
INIT = next(
    ast.literal_eval(node.value)
    for node in bundle_test.body
    if isinstance(node, ast.Assign)
    and any(isinstance(target, ast.Name) and target.id == "INIT" for target in node.targets)
)
assert "let data={};" in INIT, "test-bundle INIT mock changed; update this test's extension point"
INIT = INIT.replace(
    "let data={};",
    "if(url.pathname==='/api/student-profile/photo')return window.__genericPhotoProxy(url.href,init);let data={};",
    1,
)
INIT = INIT.replace(
    "else if(url.pathname.startsWith('/api/likee'))",
    "else if(url.pathname==='/api/student-profile')data={profile:{firstName:'Test',middleName:'Middle',lastName:'Student',studentId:'TEST-102',department:'Computing',nickName:'Tester',username:'test_native',bio:''}};else if(url.pathname.startsWith('/api/likee'))",
    1,
)
assert "window.__testSession || {authenticated:false,googleConfigured:true,faydaConfigured:false}" in INIT
AUTH_INIT = INIT.replace(
    "window.__testSession || {authenticated:false,googleConfigured:true,faydaConfigured:false}",
    "window.__testSession || {authenticated:true,authProvider:'google',googleConfigured:true,faydaConfigured:false,googleProfile:{email:'photo-regression@example.invalid',name:'Photo Regression'}}",
    1,
)
INIT += r'''
window.__genericPhotoProxyCalls=[];
window.__genericPhotoProxy=async(url,init={})=>{
  window.__genericPhotoProxyCalls.push({url:String(url),method:(init.method||'GET').toUpperCase()});
  return new Response(new Uint8Array(window.__genericPhotoBytes||[71,69,78,69,82,73,67]),{status:200});
};
window.__genericPhotoBytes=[71,69,78,69,82,73,67];
'''

class QuietHandler(SimpleHTTPRequestHandler):
    def log_message(self, _format, *_args):
        pass


def serve_www():
    handler = lambda *args, **kwargs: QuietHandler(*args, directory=str(WWW), **kwargs)
    server = ThreadingHTTPServer(("0.0.0.0", PORT), handler)
    server.daemon_threads = True
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    return server


# Local native media-proxy stand-in. It preserves Content-Type exactly as the
# Android StemmaBackendClient should; all response bodies are deterministic.
local_requests: list[dict] = []
response_plan: list[dict] = []
plan_lock = threading.Lock()
FIXTURES = {
    "image/png": bytes([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A, 0x01]),
    "image/jpeg": bytes([0xFF, 0xD8, 0xFF, 0xE0, 0x10, 0x20, 0xFF, 0xD9]),
    "image/webp": b"RIFF\x04\x00\x00\x00WEBP",
}


def set_plan(*entries: dict):
    with plan_lock:
        response_plan.clear()
        response_plan.extend(entries)


def route_photo(route):
    request = route.request
    local_requests.append({
        "url": request.url,
        "method": request.method,
        "headers": request.headers,
    })
    with plan_lock:
        entry = response_plan.pop(0) if response_plan else {"status": 404, "body": b""}
    headers = dict(entry.get("headers", {}))
    mime = entry.get("mime")
    if mime:
        headers["Content-Type"] = mime
    route.fulfill(status=entry.get("status", 200), headers=headers, body=entry.get("body", b""))


def assert_local_request(request: dict):
    assert request["url"].startswith(BASE_URL + "/api/student-profile/photo"), request
    assert request["method"] == "GET", request


def main():
    if not WWW.is_dir() or not (WWW / "index.html").is_file():
        raise RuntimeError(f"Bundled www shell is missing: {WWW}")
    server = serve_www()
    results = {}
    errors = []
    try:
        with sync_playwright() as p:
            browser = p.chromium.launch(
                executable_path=os.environ.get("CHROMIUM_PATH", "/usr/bin/chromium"),
                headless=True,
                args=["--no-sandbox"],
            )
            try:
                # The regular shell starts as a guest so the GET behavior can be
                # tested without profile setup side effects.
                context = browser.new_context(viewport={"width": 390, "height": 844})
                context.add_init_script(INIT)
                page = context.new_page()
                page.on("pageerror", lambda error: errors.append(str(error)))
                page.route("**/api/student-profile/photo", route_photo)
                response = page.goto(BASE_URL + "/", wait_until="networkidle")
                assert response and response.ok, "bundled app shell did not load"
                page.wait_for_function("typeof window.AuthenticatedProfilePhotoStore === 'function'")

                mime_checks = {}
                for mime, body in FIXTURES.items():
                    set_plan({"status": 200, "mime": mime, "body": body})
                    value = page.evaluate("""async()=>{
                      const blob=await new window.AuthenticatedProfilePhotoStore().get();
                      return {type:blob.type,bytes:Array.from(new Uint8Array(await blob.arrayBuffer()))};
                    }""")
                    assert value == {"type": mime, "bytes": list(body)}, (mime, value)
                    mime_checks[mime] = True
                assert len(local_requests) == 3, local_requests
                for request in local_requests:
                    assert_local_request(request)
                results["pngJpegWebpBytesAndMime"] = mime_checks
                local_requests.clear()

                # Fetch with a URL object and a Request object must take the same
                # same-origin localhost proxy route, not the remote generic proxy.
                set_plan(
                    {"status": 200, "mime": "image/png", "body": FIXTURES["image/png"]},
                    {"status": 200, "mime": "image/webp", "body": FIXTURES["image/webp"]},
                )
                input_results = page.evaluate("""async()=>{
                  const endpoint='https://stemma.wasmer.app/api/student-profile/photo';
                  const byUrl=await fetch(new URL(endpoint),{headers:{Accept:'image/png','X-Test-Input':'URL'}});
                  const urlType=byUrl.headers.get('content-type');
                  const urlBytes=Array.from(new Uint8Array(await byUrl.arrayBuffer()));
                  const request=new Request(endpoint,{headers:{Accept:'image/webp','X-Test-Input':'Request'}});
                  const byRequest=await fetch(request);
                  return {urlStatus:byUrl.status,urlType,urlBytes,requestStatus:byRequest.status,
                    requestType:byRequest.headers.get('content-type'),
                    requestBytes:Array.from(new Uint8Array(await byRequest.arrayBuffer()))};
                }""")
                assert input_results["urlStatus"] == input_results["requestStatus"] == 200, input_results
                assert input_results["urlType"] == "image/png" and input_results["urlBytes"] == list(FIXTURES["image/png"]), input_results
                assert input_results["requestType"] == "image/webp" and input_results["requestBytes"] == list(FIXTURES["image/webp"]), input_results
                assert len(local_requests) == 2, local_requests
                for request in local_requests:
                    assert_local_request(request)
                assert [item["headers"].get("x-test-input") for item in local_requests] == ["URL", "Request"], local_requests
                generic_mime = page.evaluate("""async()=>{
                  const response=await window.__genericPhotoProxy('https://stemma.wasmer.app/api/student-profile/photo');
                  return response.headers.get('content-type');
                }""")
                assert generic_mime is None, generic_mime
                page.evaluate("window.__genericPhotoProxyCalls=[]")
                assert page.evaluate("window.__genericPhotoProxyCalls.length") == 0, "photo GET used generic remote Capacitor proxy"
                results["urlAndRequestInputsUseLocalMimePreservingRoute"] = True
                results["genericRemoteProxyDropsContentType"] = generic_mime is None
                local_requests.clear()

                # A missing remote photo is an ordinary absence, not an error.
                set_plan({"status": 404, "body": b""})
                absent = page.evaluate("""async()=>{
                  const value=await new window.AuthenticatedProfilePhotoStore().get();
                  return value===null;
                }""")
                assert absent is True and len(local_requests) == 1, (absent, local_requests)
                assert_local_request(local_requests[0])
                results["404ReturnsAbsent"] = True
                local_requests.clear()

                # Auth failures and server errors are surfaced, never translated
                # into a local-device fallback by the remote store.
                set_plan({"status": 401, "body": b"unauthorized"})
                unauthorized = page.evaluate("""async()=>{
                  try { await new window.AuthenticatedProfilePhotoStore().get(); return null; }
                  catch(error) { return {name:error.name,status:error.status,message:error.message}; }
                }""")
                assert unauthorized and unauthorized["status"] == 401, unauthorized
                assert "Sign in again" in unauthorized["message"], unauthorized
                assert len(local_requests) == 1 and not page.evaluate("window.__genericPhotoProxyCalls.length"), local_requests
                assert_local_request(local_requests[0])
                results["401SurfacesAuthErrorWithoutRemoteFallback"] = True
                local_requests.clear()

                set_plan({"status": 503, "body": b"unavailable"})
                server_error = page.evaluate("""async()=>{
                  try { await new window.AuthenticatedProfilePhotoStore().get(); return null; }
                  catch(error) { return {name:error.name,status:error.status,message:error.message}; }
                }""")
                assert server_error and server_error["status"] == 503, server_error
                assert len(local_requests) == 1, local_requests
                assert_local_request(local_requests[0])
                results["5xxSurfacesErrorWithoutWrites"] = True
                local_requests.clear()

                set_plan(
                    {"status": 503, "body": b"temporary"},
                    {"status": 200, "mime": "image/jpeg", "body": FIXTURES["image/jpeg"]},
                )
                retry_result = page.evaluate("""async()=>{
                  const store=new window.AuthenticatedProfilePhotoStore();
                  let first;
                  try { await store.get(); } catch(error) { first=error.status; }
                  const blob=await store.get();
                  return {first,type:blob.type,bytes:Array.from(new Uint8Array(await blob.arrayBuffer()))};
                }""")
                assert retry_result == {"first": 503, "type": "image/jpeg", "bytes": list(FIXTURES["image/jpeg"])}, retry_result
                assert len(local_requests) == 2, local_requests
                for request in local_requests:
                    assert_local_request(request)
                results["retryAfter5xxSucceeds"] = True
                local_requests.clear()

                aborted = page.evaluate("""async()=>{
                  const controller=new AbortController();
                  const request=new Request('https://stemma.wasmer.app/api/student-profile/photo',{signal:controller.signal});
                  controller.abort();
                  try { await fetch(request); return null; }
                  catch(error) { return {name:error.name}; }
                }""")
                assert aborted == {"name": "AbortError"}, aborted
                assert not local_requests, local_requests
                results["abortedRequestRejectsWithoutProxyCall"] = True
                assert page.evaluate("window.__genericPhotoProxyCalls.length") == 0
                context.close()

                # Exercise the bundled profile UI's real error path. On either
                # 401 or 5xx it must not consult IndexedDB for an older local
                # copy, write a local copy, or issue any save/import mutation.
                integration = {}
                for status in (401, 503):
                    auth_context = browser.new_context(viewport={"width": 390, "height": 844})
                    auth_context.add_init_script(AUTH_INIT)
                    auth_page = auth_context.new_page()
                    auth_page.on("pageerror", lambda error: errors.append(str(error)))
                    set_plan({"status": status, "body": b"failure"})
                    auth_page.route("**/api/student-profile/photo", route_photo)
                    auth_page.goto(BASE_URL + "/", wait_until="networkidle")
                    auth_page.wait_for_timeout(250)
                    outcome = auth_page.evaluate("""()=>({
                      previewHidden:document.getElementById('student-photo-preview')?.hidden===true,
                      previewSrc:document.getElementById('student-photo-preview')?.getAttribute('src'),
                      fileWrites:window.__calls.filter(c=>c.name==='Filesystem'&&c.method==='writeFile').length,
                      nativeMutations:window.__calls.filter(c=>c.name==='StemmaTransport'&&c.method==='request'&&['POST','PUT','PATCH','DELETE'].includes(String(c.options?.method||'').toUpperCase())).length,
                      genericPhotoProxyCalls:(window.__genericPhotoProxyCalls||[]).length,
                      photoStatus:document.getElementById('student-photo-status')?.textContent||''
                    })""")
                    assert any(req["url"].startswith(BASE_URL + "/api/student-profile/photo") for req in local_requests), (status, local_requests)
                    assert outcome["genericPhotoProxyCalls"] == 0, outcome
                    assert outcome["fileWrites"] == 0 and outcome["nativeMutations"] == 0, outcome
                    assert outcome["previewHidden"] and not outcome["previewSrc"], outcome
                    integration[str(status)] = {
                        "noLocalFallbackPhotoDisplayed": True,
                        "noFileOrNativeMutation": True,
                        "noGenericRemotePhotoProxy": True,
                    }
                    auth_context.close()
                results["profileErrorPathNeverImportsLocalPhoto"] = integration

                assert not errors, errors
                results["pageErrors"] = errors
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
