from __future__ import annotations

"""Browser regression tests for photo-response.js.

Run with ``python3 test-photo-response.py`` from any directory. The test creates
real Pillow-generated images in memory, injects the new standalone module into
Chromium, and writes a safe, compact JSON summary to ../stemma-delivery/.
"""

import base64
import io
import json
import os
import re
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

from PIL import Image
from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parent
REPO = ROOT.parent
LEGACY_MODULE = REPO / "profile-photo.js"
MODULE_CANDIDATES = (ROOT / "photo-response.js", REPO / "photo-response.js")
RESULT_PATH = Path(os.environ.get("STEMMA_PHOTO_RESPONSE_RESULTS", f"/workspace/stemma-delivery/Stemma-{json.loads((ROOT / 'package.json').read_text())['version']}-response-tests.json"))
PORT = int(os.environ.get("PHOTO_RESPONSE_TEST_PORT", "8979"))
BASE_URL = f"http://127.0.0.1:{PORT}"
MAX_BYTES = 1024 * 1024
SAFE_KEYS = {
    "phase", "responseMime", "declaredByteLength", "byteLength", "magicType",
    "normalizedMime", "decode",
}


class QuietHandler(BaseHTTPRequestHandler):
    def do_GET(self):
        body = b"<!doctype html><meta charset=utf-8><title>photo response tests</title>"
        self.send_response(200)
        self.send_header("Content-Type", "text/html; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, _fmt, *_args):
        pass


def serve():
    server = ThreadingHTTPServer(("0.0.0.0", PORT), QuietHandler)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    return server


def image_bytes(fmt: str, size=(31, 23), color=(31, 121, 201, 255)) -> bytes:
    image = Image.new("RGBA", size, color)
    out = io.BytesIO()
    if fmt == "JPEG":
        image.convert("RGB").save(out, format=fmt, quality=87, optimize=True)
    elif fmt == "WEBP":
        image.save(out, format=fmt, quality=87, method=4)
    else:
        image.save(out, format=fmt, optimize=True)
    return out.getvalue()


def b64(data: bytes) -> str:
    return base64.b64encode(data).decode("ascii")


def load_module_text() -> tuple[Path, str]:
    module = next((path for path in MODULE_CANDIDATES if path.is_file()), None)
    if module is None:
        raise FileNotFoundError(
            "photo-response.js is not available yet; checked "
            + ", ".join(map(str, MODULE_CANDIDATES))
        )
    source = module.read_text(encoding="utf-8")
    if "installPhotoResponseValidation" not in source:
        raise AssertionError(f"No installPhotoResponseValidation export found in {module}")
    # This is a standalone module, not a browser bundle. Strip only the named
    # ESM export keyword so the function can be called against this test window.
    source, replacements = re.subn(
        r"\bexport\s+(?=(?:async\s+)?function\s+installPhotoResponseValidation\b)",
        "",
        source,
        count=1,
    )
    if replacements != 1:
        raise AssertionError("Expected `export function installPhotoResponseValidation(...)`")
    source += "\n;installPhotoResponseValidation(window);\n"
    return module, source


def assert_safe_observations(observations):
    assert isinstance(observations, list), observations
    for item in observations:
        assert isinstance(item, dict), item
        assert set(item).issubset(SAFE_KEYS), item
        assert "phase" in item, item
        assert isinstance(item.get("byteLength", 0), (int, float)), item
        assert isinstance(item.get("decode", {"ok": False}), dict), item
        assert set(item.get("decode", {})).issubset({"ok", "width", "height"}), item
        # Ensure the event payload cannot leak buffers, byte arrays or image data.
        dumped = json.dumps(item, sort_keys=True)
        assert "data:image" not in dumped and "Uint8Array" not in dumped, dumped


def main():
    module_path, module_source = load_module_text()
    png = image_bytes("PNG")
    jpeg = image_bytes("JPEG")
    webp = image_bytes("WEBP")
    gif = image_bytes("GIF")
    png_wide = image_bytes("PNG", size=(8193, 1), color=(1, 2, 3, 255))
    png_pixels = image_bytes("PNG", size=(4097, 4097), color=(1, 2, 3, 255))
    html = b"<!doctype html><html><body>not an image</body></html>"
    corrupt_png = png[:33]  # valid dimensions/IHDR, missing image data: real decoder rejection

    server = serve()
    results = {
        "module": str(module_path),
        "browser": "Chromium",
        "fixtureBytes": {"png": len(png), "jpeg": len(jpeg), "webp": len(webp), "gif": len(gif)},
        "checks": {},
    }
    try:
        with sync_playwright() as p:
            browser = p.chromium.launch(
                executable_path=os.environ.get("CHROMIUM_PATH", "/usr/bin/chromium"),
                headless=True,
                args=["--no-sandbox"],
            )
            try:
                page = browser.new_page()
                errors = []
                page.on("pageerror", lambda error: errors.append(str(error)))
                response = page.goto(BASE_URL + "/", wait_until="load")
                assert response and response.ok
                page.add_script_tag(content=module_source)
                assert page.evaluate("typeof window.StemmaAndroidPhotoResponse?.read === 'function'")

                def read_case(name, body, mime=None, declared=..., expected_category=None,
                              expected_type=None, expected_magic=None):
                    opts = {
                        "name": name,
                        "body": b64(body),
                        "mime": mime,
                        "declared": None if declared is ... else declared,
                        "hasDeclared": declared is not ...,
                        "expectedCategory": expected_category,
                    }
                    value = page.evaluate("""async o => {
                      const raw=Uint8Array.from(atob(o.body), c=>c.charCodeAt(0));
                      const headers={};
                      if(o.mime!==null) headers['Content-Type']=o.mime;
                      if(o.hasDeclared) headers['Content-Length']=String(o.declared);
                      const response=new Response(raw,{status:200,headers});
                      const observations=[];
                      try {
                        const blob=await window.StemmaAndroidPhotoResponse.read(response,{observe:m=>observations.push(m)});
                        return {ok:true,type:blob.type,size:blob.size,bytes:Array.from(new Uint8Array(await blob.arrayBuffer())),observations};
                      } catch(error) {
                        return {ok:false,category:error.photoCategory||null,phase:error.photoPhase||null,observations};
                      }
                    }""", opts)
                    assert_safe_observations(value["observations"])
                    if expected_category:
                        assert not value["ok"] and value["category"] == expected_category, (name, value)
                        return value
                    assert value["ok"], (name, value)
                    assert value["type"] == expected_type, (name, value)
                    assert value["bytes"] == list(body), name
                    assert any(o.get("magicType") == expected_magic for o in value["observations"]), (name, value)
                    assert any(o.get("decode", {}).get("ok") is True for o in value["observations"]), (name, value)
                    return value

                # Real decoded fixtures must be accepted by byte signature rather
                # than being rejected because of absent, generic or odd headers.
                successes = []
                for label, data, true_type, magic, variants in (
                    ("png", png, "image/png", "PNG", [None, "application/octet-stream", "image/jpg", "image/gif", "image/bmp", "not a mime"]),
                    ("jpeg", jpeg, "image/jpeg", "JPEG", [None, "application/octet-stream", "image/jpg", "image/png"]),
                    ("webp", webp, "image/webp", "WebP", [None, "application/octet-stream", "image/jpg", "image/png"]),
                ):
                    for variant in variants:
                        read_case(f"{label}-header-{variant or 'missing'}", data, variant,
                                  expected_type=true_type, expected_magic=magic)
                        successes.append({"fixture": label, "header": variant})
                results["checks"]["realPngJpegWebpAcceptedAcrossMissingGenericAndSpoofedHeaders"] = successes

                gif_result = read_case("gif", gif, "image/gif", expected_category="mime")
                assert any(x.get("magicType") == "GIF" for x in gif_result["observations"]), gif_result
                results["checks"]["gifSignatureRecognizedButUnsupported"] = True

                for label, data, mime in (
                    ("html-supported-png-header", html, "image/png"),
                    ("html-generic-header", html, "application/octet-stream"),
                    ("html-missing-header", html, None),
                    ("html-invalid-image-header", html, "image/jpg"),
                ):
                    read_case(label, data, mime, expected_category="non-image")
                results["checks"]["htmlAndNoSignatureRejectAsNonImage"] = True

                read_case("signature-valid-truncated-png", corrupt_png, "image/png",
                          expected_category="corrupt-image")
                results["checks"]["signatureValidTruncatedImageRejectsAsCorrupt"] = True

                read_case("empty", b"", "image/png", expected_category="empty-body")
                results["checks"]["emptyBody"] = True

                length_cases = {}
                for label, value in (("zero", "0"), ("negative", "-1"), ("non-numeric", "nope"),
                                     ("oversized", str(MAX_BYTES + 1)), ("decimal", "2.5")):
                    r = read_case("declared-" + label, png, "image/png", declared=value,
                                  expected_category="content-length")
                    length_cases[label] = {"category": r["category"], "phase": r["phase"]}
                # Missing and valid-but-misleading declared lengths are allowed;
                # length need not equal delivered (decoded) bytes.
                read_case("declared-missing", png, "image/png", expected_type="image/png", expected_magic="PNG")
                read_case("declared-misleading-under-limit", png, "image/png", declared=MAX_BYTES - 1,
                          expected_type="image/png", expected_magic="PNG")
                results["checks"]["declaredLengthRules"] = {"invalid": length_cases, "missingAccepted": True, "misleadingLengthAccepted": True}

                # Exercise streaming byte limits and assert that excessive streams
                # are cancelled rather than buffered without bound. Keep all data
                # inside the page; only metadata leaves the validator.
                stream_result = page.evaluate("""async o => {
                  const head=Uint8Array.from(atob(o.png),c=>c.charCodeAt(0));
                  let delivered=0,cancelled=false,pulls=0;
                  const stream=new ReadableStream({
                    pull(controller){
                      pulls++;
                      if(delivered===0){controller.enqueue(head);delivered+=head.length;return;}
                      if(delivered>o.limit){controller.close();return;}
                      const chunk=new Uint8Array(65536);chunk.fill(7);
                      controller.enqueue(chunk);delivered+=chunk.length;
                    },
                    cancel(){cancelled=true;}
                  });
                  const response=new Response(stream,{headers:{'Content-Type':'image/png'}});
                  const observations=[];
                  try{await window.StemmaAndroidPhotoResponse.read(response,{observe:m=>observations.push(m)});return {ok:true,delivered,cancelled,pulls,observations};}
                  catch(e){return {ok:false,category:e.photoCategory||null,phase:e.photoPhase||null,delivered,cancelled,pulls,observations};}
                }""", {"png": b64(png), "limit": MAX_BYTES})
                assert_safe_observations(stream_result["observations"])
                assert stream_result["category"] == "body-size", stream_result
                assert stream_result["cancelled"], stream_result
                assert stream_result["delivered"] <= MAX_BYTES + 65536 + len(png), stream_result
                results["checks"]["streamingActualByteLimitCancelsBody"] = {
                    "category": stream_result["category"], "cancelled": stream_result["cancelled"],
                    "deliveredBeforeCancel": stream_result["delivered"],
                }

                # Abort a stalled response-body reader. No body bytes are logged.
                abort_body = page.evaluate("""async o=>{
                  const controller=new AbortController();let cancelled=false;
                  const stream=new ReadableStream({pull(){},cancel(){cancelled=true;}});
                  const response=new Response(stream,{headers:{'Content-Type':'image/png'}});
                  const observations=[];
                  const promise=window.StemmaAndroidPhotoResponse.read(response,{signal:controller.signal,observe:m=>observations.push(m)});
                  await new Promise(resolve=>setTimeout(resolve,20));controller.abort();
                  try{await promise;return {ok:true,cancelled,observations};}
                  catch(e){return {ok:false,category:e.photoCategory||null,phase:e.photoPhase||null,cancelled,observations};}
                }""")
                assert_safe_observations(abort_body["observations"])
                assert abort_body["category"] == "aborted", abort_body
                assert abort_body["phase"] == "body-read", abort_body
                results["checks"]["abortDuringBodyRead"] = {"category": abort_body["category"], "phase": abort_body["phase"]}

                # Abort during real image decode after decode phase is observable.
                abort_decode = page.evaluate("""async o=>{
                  const controller=new AbortController(),observations=[];
                  const raw=Uint8Array.from(atob(o.png),c=>c.charCodeAt(0));
                  const response=new Response(raw,{headers:{'Content-Type':'image/png'}});
                  const promise=window.StemmaAndroidPhotoResponse.read(response,{
                    signal:controller.signal,
                    observe:m=>{observations.push(m);if(m.phase==='image-decode')setTimeout(()=>controller.abort(),0);}
                  });
                  try{const blob=await promise;return {ok:true,type:blob.type,observations};}
                  catch(e){return {ok:false,category:e.photoCategory||null,phase:e.photoPhase||null,observations};}
                }""", {"png": b64(png)})
                assert_safe_observations(abort_decode["observations"])
                assert abort_decode["category"] == "aborted", abort_decode
                results["checks"]["abortDuringImageDecode"] = {"category": abort_decode["category"], "phase": abort_decode["phase"]}

                # Pixel caps: side limit and total-pixel limit are independent.
                page.evaluate("()=>{window.__nativeImage=window.Image;window.__limitDecodeAllocations=0;window.Image=function(...args){window.__limitDecodeAllocations++;return new window.__nativeImage(...args)}}")
                codec_caps={}
                for fmt,mime in [("PNG","image/png"),("JPEG","image/jpeg"),("WEBP","image/webp")]:
                    result=read_case("dimension-side-cap-"+fmt,image_bytes(fmt,size=(8193,1)),mime,expected_category="image-dimensions")
                    codec_caps[fmt]=result["category"]
                wide_result = read_case("dimension-side-cap", png_wide, "image/png",
                                        expected_category="image-dimensions")
                pixel_result = read_case("dimension-pixel-cap", png_pixels, "image/png",
                                         expected_category="image-dimensions")
                assert page.evaluate("window.__limitDecodeAllocations")==0,"dimension limits must reject before constructing Image"
                page.evaluate("()=>{window.Image=window.__nativeImage;}")
                results["checks"]["allCodecSideCapsBeforeDecoderAllocation"]=codec_caps
                results["checks"]["maximumSideAndPixelCaps"] = {
                    "side": {"category": wide_result["category"], "phase": wide_result["phase"]},
                    "pixels": {"category": pixel_result["category"], "phase": pixel_result["phase"]},
                    "fixtureDimensions": {"side": [8193, 1], "pixels": [4097, 4097]},
                }

                # Before/after: the deployed legacy store's strict content-type
                # branch rejects a real PNG when the proxy supplies only a
                # generic octet-stream header; the new byte-signature validator
                # accepts the same fixture.
                if not LEGACY_MODULE.is_file():
                    raise FileNotFoundError(f"Original deployed profile-photo.js missing: {LEGACY_MODULE}")
                legacy_source = LEGACY_MODULE.read_text(encoding="utf-8")
                page.add_script_tag(content=legacy_source)
                legacy = page.evaluate("""async o=>{
                  const png=Uint8Array.from(atob(o.png),c=>c.charCodeAt(0));
                  const store=new window.AuthenticatedProfilePhotoStore({fetch:async()=>new Response(png,{status:200,headers:{"Content-Type":"application/octet-stream"}})});
                  try{const blob=await store.get();return {ok:true,type:blob.type};}
                  catch(e){return {ok:false,message:String(e.message||e)};}
                }""", {"png": b64(png)})
                modern = read_case("before-after-octet-stream", png, "application/octet-stream",
                                   expected_type="image/png", expected_magic="PNG")
                assert legacy["ok"] is False and "unsupported image format" in legacy["message"], legacy
                assert modern["ok"] and modern["type"] == "image/png"
                results["checks"]["beforeAfterLegacyStrictHeaderVsNewMagicValidation"] = {
                    "legacy": "rejects real PNG because Content-Type is application/octet-stream",
                    "newApi": "accepts same real PNG with octet-stream header after signature and decode validation",
                }

                assert not errors, errors
                results["status"] = "passed"
            finally:
                browser.close()
    finally:
        server.shutdown()
        server.server_close()

    RESULT_PATH.parent.mkdir(parents=True, exist_ok=True)
    RESULT_PATH.write_text(json.dumps(results, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    print(json.dumps(results, indent=2, sort_keys=True))


if __name__ == "__main__":
    main()
