package app.stemma.mobile;

import android.net.Uri;
import android.webkit.CookieManager;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebView;
import com.getcapacitor.Bridge;
import com.getcapacitor.BridgeWebViewClient;
import java.io.ByteArrayInputStream;
import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.nio.file.Files;
import java.nio.file.Paths;
import java.net.ConnectException;
import java.net.HttpURLConnection;
import java.net.URL;
import java.net.URLConnection;
import java.net.URLStreamHandler;
import java.net.UnknownHostException;
import java.util.Collections;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import javax.net.ssl.SSLException;

public final class NativeProxyRegressionTest {
    private static final String ORIGIN = "https://stemma.wasmer.app";
    private static final String PHOTO = "https://localhost/api/student-profile/photo";
    private static final byte[] IMAGE_BYTES = new byte[] {0x00, 0x01, 0x7f, (byte)0x80, (byte)0xfe, (byte)0xff};
    private static MockHttpsConnection lastConnection;
    private static ResponseSpec nextResponse;

    public static void main(String[] args) throws Exception {
        URL.setURLStreamHandlerFactory(protocol -> "https".equals(protocol) ? new URLStreamHandler() {
            @Override protected URLConnection openConnection(URL url) {
                lastConnection = new MockHttpsConnection(url, nextResponse);
                return lastConnection;
            }
        } : null);

        CookieManager.getInstance().setCookie(ORIGIN, "session=expected; theme=dark");
        StemmaBackendClient client = new StemmaBackendClient(new Bridge());
        verifyImage(client, "image/png", "image/png");
        verifyImage(client, "image/jpeg", "image/jpeg; charset=binary");
        verifyImage(client, "image/webp", "image/webp");
        verifyExactSizeWebpAndMixedCaseHeaders(client);
        verifyInvalidLengthStillUsesBufferedBody(client);
        verifyOversizedPhotoRejected(client);
        verifyMissingUpstreamMime(client);
        verifyOctetStreamDiagnostic(client);
        verifyUnexpectedImageMime(client);
        verifyDuplicateMimeDiagnostic(client);
        verifyMimeParameterPrivacy(client);
        verifyInvalidMimeDiagnostics(client);
        verifyMissingLengthDiagnostic(client);
        verifyInvalidLengthDiagnostics(client);
        verifyErrorStatus(client, 401, "Unauthorized");
        verifyErrorStatus(client, 503, "Service Unavailable");
        verifyRedirectBlocked(client);
        verifyInjectedFailure(client, new IOException("private request URL and cookie must not leak"), "connection");
        verifyInjectedFailure(client, new SSLException("private TLS details must not leak"), "tls");
        verifyInjectedFailure(client, new UnknownHostException("private hostname must not leak"), "dns");
        verifyNonPhotoHasNoDiagnostics(client);
        verifyDelegation(client, "https://example.com/api/student-profile/photo", "GET");
        verifyDelegation(client, PHOTO, "POST");
        check("session=expected; theme=dark".equals(CookieManager.getInstance().getCookie(ORIGIN)), "proxy leaves CookieManager state unchanged");
        System.out.println("PASS: native proxy JVM regression harness (28 scenarios)");
    }

    private static void verifyImage(StemmaBackendClient client, String expectedMime, String responseType) throws Exception {
        nextResponse = new ResponseSpec(200, "OK", responseType, IMAGE_BYTES);
        WebResourceResponse response = intercept(client, PHOTO + "?private_query=do-not-echo", "GET");
        check(response != null, "image response is proxied");
        check(response.statusCode == 200, "image status preserved");
        check(expectedMime.equals(response.mimeType), "MIME type should be " + expectedMime + ", got " + response.mimeType);
        checkNoGeneratedSizeHeaders(response);
        check(expectedMime.equals(response.responseHeaders.get("X-Stemma-Photo-Content-Type")), "normalized original MIME diagnostic");
        check("private, no-store".equals(response.responseHeaders.get("Cache-Control")), "no-store header present");
        check("nosniff".equals(response.responseHeaders.get("X-Content-Type-Options")), "nosniff header present");
        verifyDiagnostic(response, "200", "none", "headers");
        checkNoSensitiveData(response.responseHeaders);
        check("session=expected; theme=dark".equals(lastConnection.requestProperties.get("Cookie")), "Cookie header comes from CookieManager at the configured origin");
        check(response.data.available() == IMAGE_BYTES.length, "buffered image available() is the exact body byte count");
        check(ArraysEqual(IMAGE_BYTES, readAll(response.data)), "binary image bytes, including high-bit bytes, are exact");
        check(response.encoding == null, "binary photo response has no forced character encoding");
        check(lastConnection.disconnected, "upstream connection closes before the response is handed to WebView");
        response.data.close();
        check(lastConnection.disconnected, "connection disconnects when response stream closes");
    }

    private static void verifyExactSizeWebpAndMixedCaseHeaders(StemmaBackendClient client) throws Exception {
        byte[] webp = Files.readAllBytes(Paths.get("native-proxy-tests/fixtures/photo-15284.webp"));
        check(webp.length == 15284 && webp[0] == 'R' && webp[1] == 'I' && webp[2] == 'F' && webp[3] == 'F' &&
                webp[8] == 'W' && webp[9] == 'E' && webp[10] == 'B' && webp[11] == 'P', "fixture is a real 15,284-byte RIFF/WebP image");
        nextResponse = new ResponseSpec(206, "Partial Content", "image/webp", webp);
        nextResponse.headers.put("cOnTeNt-TyPe", java.util.Arrays.asList("image/webp", "IMAGE/WEBP"));
        nextResponse.headers.put("cOnTeNt-LeNgTh", java.util.Arrays.asList("15284", "015284"));
        nextResponse.headers.put("eTaG", Collections.singletonList("\"photo-v1\""));
        nextResponse.headers.put("cOnTeNt-RaNgE", Collections.singletonList("bytes 0-15283/30000"));
        WebResourceResponse response = intercept(client, PHOTO, "GET");
        check(response.statusCode == 206 && "Partial Content".equals(response.reasonPhrase), "partial response status and reason are preserved");
        check("image/webp".equals(response.mimeType), "identical duplicate mixed-case content types reduce to one canonical WebP MIME");
        check("image/webp, image/webp".equals(response.responseHeaders.get("X-Stemma-Photo-Content-Type")), "mixed-case duplicate MIME diagnostic preserves combined normalized values");
        check("2".equals(response.responseHeaders.get("X-Stemma-Photo-Content-Type-Values")), "mixed-case duplicate MIME header values are counted");
        check("15284".equals(response.responseHeaders.get("X-Stemma-Photo-Content-Length")), "identical duplicate content lengths normalize to one numeric value");
        check("2".equals(response.responseHeaders.get("X-Stemma-Photo-Content-Length-Values")), "mixed-case duplicate content length values are counted");
        check("\"photo-v1\"".equals(response.responseHeaders.get("ETag")), "ETag is preserved");
        check("bytes 0-15283/30000".equals(response.responseHeaders.get("Content-Range")), "Content-Range is preserved");
        checkNoGeneratedSizeHeaders(response);
        check(response.data.available() == 15284, "real WebP buffered available() is exactly 15,284 bytes");
        check(ArraysEqual(webp, readAll(response.data)), "real WebP bytes are byte-exact");
        check(lastConnection.disconnected, "mixed-header photo upstream closes before handoff");
        response.data.close();
    }

    private static void verifyInvalidLengthStillUsesBufferedBody(StemmaBackendClient client) throws Exception {
        nextResponse = new ResponseSpec(200, "OK", "image/png", IMAGE_BYTES, "999999");
        WebResourceResponse response = intercept(client, PHOTO, "GET");
        check("999999".equals(response.responseHeaders.get("X-Stemma-Photo-Content-Length")), "valid but mismatched upstream length remains diagnostic only");
        checkNoGeneratedSizeHeaders(response);
        check(response.data.available() == IMAGE_BYTES.length, "available() reflects buffered bytes, not upstream length");
        check(ArraysEqual(IMAGE_BYTES, readAll(response.data)), "mismatched upstream length does not alter body bytes");
        response.data.close();
    }

    private static void verifyOversizedPhotoRejected(StemmaBackendClient client) throws Exception {
        byte[] oversized = new byte[1024 * 1024 + 1];
        nextResponse = new ResponseSpec(200, "OK", "image/webp", oversized);
        WebResourceResponse response = intercept(client, PHOTO, "GET");
        check(response.statusCode == 413, "photo body one byte above 1 MiB is rejected with HTTP 413");
        verifyDiagnostic(response, "200", "body-size", "body");
        checkNoGeneratedSizeHeaders(response);
        check(lastConnection.disconnected, "oversized response closes upstream connection");
        check("Connection unavailable.".equals(new String(readAll(response.data), java.nio.charset.StandardCharsets.UTF_8)), "oversized response returns the safe native error body");
    }

    private static void checkNoGeneratedSizeHeaders(WebResourceResponse response) {
        check(!response.responseHeaders.containsKey("Content-Type"), "photo response does not duplicate the MIME-generated Content-Type header");
        check(!response.responseHeaders.containsKey("Content-Length"), "photo response does not duplicate available()-generated Content-Length");
    }

    private static void verifyMissingUpstreamMime(StemmaBackendClient client) throws Exception {
        nextResponse = new ResponseSpec(200, "OK", null, IMAGE_BYTES);
        WebResourceResponse response = intercept(client, PHOTO, "GET");
        checkNoGeneratedSizeHeaders(response);
        check("application/octet-stream".equals(response.mimeType), "existing MIME fallback is unchanged");
        check("missing".equals(response.responseHeaders.get("X-Stemma-Photo-Content-Type")), "missing original MIME is explicit");
        check("missing".equals(response.responseHeaders.get("X-Stemma-Photo-Content-Length")), "missing original length is explicit");
        response.data.close();
    }

    private static void verifyOctetStreamDiagnostic(StemmaBackendClient client) throws Exception {
        nextResponse = new ResponseSpec(200, "OK", "application/octet-stream", IMAGE_BYTES, "123456789012");
        WebResourceResponse response = intercept(client, PHOTO, "GET");
        check("application/octet-stream".equals(response.responseHeaders.get("X-Stemma-Photo-Content-Type")), "valid octet-stream is reported as received");
        check("123456789012".equals(response.responseHeaders.get("X-Stemma-Photo-Content-Length")), "12-digit content length is accepted");
        response.data.close();
    }

    private static void verifyUnexpectedImageMime(StemmaBackendClient client) throws Exception {
        nextResponse = new ResponseSpec(200, "OK", "image/jpg", IMAGE_BYTES);
        WebResourceResponse response = intercept(client, PHOTO, "GET");
        check("image/jpg".equals(response.responseHeaders.get("X-Stemma-Photo-Content-Type")), "unexpected image/jpg remains visible for diagnosis");
        response.data.close();
    }

    private static void verifyDuplicateMimeDiagnostic(StemmaBackendClient client) throws Exception {
        nextResponse = new ResponseSpec(200, "OK", "image/png, IMAGE/JPEG", IMAGE_BYTES);
        WebResourceResponse response = intercept(client, PHOTO, "GET");
        check("image/png, image/jpeg".equals(response.responseHeaders.get("X-Stemma-Photo-Content-Type")), "comma-separated duplicate MIME values normalize safely");
        check("application/octet-stream".equals(response.mimeType), "conflicting upstream MIME values use safe octet-stream response MIME");
        check("2".equals(response.responseHeaders.get("X-Stemma-Photo-Content-Type-Values")), "fallback combined MIME value reports both values");
        response.data.close();
    }

    private static void verifyMimeParameterPrivacy(StemmaBackendClient client) throws Exception {
        String original = "Image/PNG; boundary=private-token";
        nextResponse = new ResponseSpec(200, "OK", original, IMAGE_BYTES);
        WebResourceResponse response = intercept(client, PHOTO, "GET");
        checkNoGeneratedSizeHeaders(response);
        check("image/png".equals(response.responseHeaders.get("X-Stemma-Photo-Content-Type")), "diagnostic strips MIME parameters and lowercases essence");
        check(!response.responseHeaders.get("X-Stemma-Photo-Content-Type").contains("private-token"), "parameter values are not exposed");
        response.data.close();
    }

    private static void verifyInvalidMimeDiagnostics(StemmaBackendClient client) throws Exception {
        for(String invalid : new String[] {"image/" + "bad\u0001value", "https://example.invalid/photo", "image/png, image/jpeg, image/webp, image/gif, text/plain", "application/" + new String(new char[116]).replace((char)0,'a')}) {
            nextResponse = new ResponseSpec(200, "OK", invalid, IMAGE_BYTES);
            WebResourceResponse response = intercept(client, PHOTO, "GET");
            check("invalid".equals(response.responseHeaders.get("X-Stemma-Photo-Content-Type")), "invalid original MIME is explicit without exposing raw values");
            response.data.close();
        }
    }

    private static void verifyMissingLengthDiagnostic(StemmaBackendClient client) throws Exception {
        nextResponse = new ResponseSpec(200, "OK", "image/png", IMAGE_BYTES);
        WebResourceResponse response = intercept(client, PHOTO, "GET");
        check("missing".equals(response.responseHeaders.get("X-Stemma-Photo-Content-Length")), "absent upstream length is explicit");
        response.data.close();
    }

    private static void verifyInvalidLengthDiagnostics(StemmaBackendClient client) throws Exception {
        for(String invalid : new String[] {"1234567890123", "12bytes", "12\u0001"}) {
            nextResponse = new ResponseSpec(200, "OK", "image/png", IMAGE_BYTES, invalid);
            WebResourceResponse response = intercept(client, PHOTO, "GET");
            check("invalid".equals(response.responseHeaders.get("X-Stemma-Photo-Content-Length")), "invalid length is explicit without exposing raw values");
            response.data.close();
        }
    }

    private static void verifyErrorStatus(StemmaBackendClient client, int status, String reason) throws Exception {
        byte[] body = new byte[] {(byte)0x89, 0x00, (byte)status};
        nextResponse = new ResponseSpec(status, reason, "image/jpeg", body);
        WebResourceResponse response = intercept(client, PHOTO, "GET");
        check(response.statusCode == status, "HTTP error status " + status + " is preserved");
        check(reason.equals(response.reasonPhrase), "HTTP reason phrase " + reason + " is preserved");
        verifyDiagnostic(response, Integer.toString(status), "none", "http");
        checkNoGeneratedSizeHeaders(response);
        check(response.data.available() == body.length, "HTTP " + status + " buffered error-body length is exact");
        check(ArraysEqual(body, readAll(response.data)), "HTTP " + status + " body comes from error stream");
        response.data.close();
        check(lastConnection.disconnected, "HTTP " + status + " connection disconnects on close");
    }

    private static void verifyRedirectBlocked(StemmaBackendClient client) {
        nextResponse = new ResponseSpec(302, "Found", "text/html", new byte[] {1});
        WebResourceResponse response = intercept(client, PHOTO, "GET");
        check(response.statusCode == 502, "redirect is translated to 502");
        verifyDiagnostic(response, "302", "redirect", "http");
        checkNoGeneratedSizeHeaders(response);
        check(lastConnection.disconnected, "redirect connection disconnects immediately");
        check(!lastConnection.redirectsEnabled, "automatic redirect following is disabled");
    }

    private static void verifyInjectedFailure(StemmaBackendClient client, IOException injected, String category) {
        nextResponse = new ResponseSpec(200, "OK", "image/png", IMAGE_BYTES, injected);
        WebResourceResponse response = intercept(client, PHOTO + "?secret=query-value", "GET");
        check(response.statusCode == 503, "connection failure remains HTTP 503");
        verifyDiagnostic(response, "-1", category, "connect");
        checkNoGeneratedSizeHeaders(response);
        checkNoSensitiveData(response.responseHeaders);
        check(lastConnection.disconnected, "connection failure disconnects immediately");
    }

    private static void verifyNonPhotoHasNoDiagnostics(StemmaBackendClient client) throws Exception {
        nextResponse = new ResponseSpec(200, "OK", "application/json", new byte[] {1});
        WebResourceResponse response = intercept(client, "https://localhost/api/other?secret=query", "GET");
        check(response.statusCode == 200, "other API route remains proxied");
        for(String name: new String[]{"X-Stemma-Photo-Route","X-Stemma-Photo-Status","X-Stemma-Photo-Error","X-Stemma-Photo-Phase",
                "X-Stemma-Photo-Content-Type","X-Stemma-Photo-Content-Length","X-Stemma-Photo-Content-Type-Values","X-Stemma-Photo-Content-Length-Values"})
            check(!response.responseHeaders.containsKey(name), "photo diagnostic is absent on non-photo route: " + name);
        response.data.close();
    }

    private static void verifyDiagnostic(WebResourceResponse response, String status, String error, String phase) {
        check("native-proxy".equals(response.responseHeaders.get("X-Stemma-Photo-Route")), "photo route diagnostic");
        check(status.equals(response.responseHeaders.get("X-Stemma-Photo-Status")), "backend status diagnostic, expected " + status);
        check(error.equals(response.responseHeaders.get("X-Stemma-Photo-Error")), "safe error category diagnostic, expected " + error);
        check(phase.equals(response.responseHeaders.get("X-Stemma-Photo-Phase")), "phase diagnostic, expected " + phase);
    }

    private static void checkNoSensitiveData(Map<String,String> headers) {
        String diagnostics = headers.get("X-Stemma-Photo-Route") + headers.get("X-Stemma-Photo-Status") +
                headers.get("X-Stemma-Photo-Error") + headers.get("X-Stemma-Photo-Phase");
        check(!diagnostics.contains("secret") && !diagnostics.contains("private") && !diagnostics.contains("session=") &&
                !diagnostics.contains("https://"), "diagnostics contain no query, URL, cookie, token or exception message");
    }

    private static void verifyDelegation(StemmaBackendClient client, String url, String method) {
        nextResponse = new ResponseSpec(200, "OK", "image/png", IMAGE_BYTES);
        int before = BridgeWebViewClient.delegatedCalls;
        WebResourceResponse response = intercept(client, url, method);
        check(response == null, "nonlocal/non-GET request is delegated without proxying");
        check(BridgeWebViewClient.delegatedCalls == before + 1, "super implementation receives delegated request");
        check(lastConnection == null, "delegated request does not open proxy connection");
    }

    private static WebResourceResponse intercept(StemmaBackendClient client, String url, String method) {
        lastConnection = null;
        return client.shouldInterceptRequest(new WebView(), new Request(url, method));
    }

    private static byte[] readAll(InputStream in) throws IOException {
        ByteArrayOutputStream out = new ByteArrayOutputStream();
        byte[] buffer = new byte[64];
        int n;
        while ((n = in.read(buffer)) != -1) out.write(buffer, 0, n);
        return out.toByteArray();
    }
    private static boolean ArraysEqual(byte[] a, byte[] b) {
        if (a.length != b.length) return false;
        for (int i=0; i<a.length; i++) if (a[i] != b[i]) return false;
        return true;
    }
    private static void check(boolean condition, String message) {
        if (!condition) throw new AssertionError(message);
    }

    private static final class Request implements WebResourceRequest {
        private final Uri url;
        private final String method;
        Request(String url, String method) { this.url=Uri.parse(url); this.method=method; }
        public Uri getUrl() { return url; }
        public String getMethod() { return method; }
        public Map<String,String> getRequestHeaders() { return Collections.emptyMap(); }
    }
    private static final class ResponseSpec {
        final int status; final String reason, contentType, contentLength; final byte[] body; final IOException connectFailure;
        final Map<String,List<String>> headers = new LinkedHashMap<>();
        ResponseSpec(int status, String reason, String contentType, byte[] body) { this(status,reason,contentType,body,null,null); }
        ResponseSpec(int status, String reason, String contentType, byte[] body, String contentLength) { this(status,reason,contentType,body,contentLength,null); }
        ResponseSpec(int status, String reason, String contentType, byte[] body, IOException connectFailure) {
            this(status,reason,contentType,body,null,connectFailure);
        }
        ResponseSpec(int status, String reason, String contentType, byte[] body, String contentLength, IOException connectFailure) {
            this.status=status; this.reason=reason; this.contentType=contentType; this.contentLength=contentLength; this.body=body; this.connectFailure=connectFailure;
        }
    }
    private static final class MockHttpsConnection extends HttpURLConnection {
        final ResponseSpec response;
        final Map<String,String> requestProperties = new LinkedHashMap<>();
        boolean disconnected;
        boolean redirectsEnabled = true;
        MockHttpsConnection(URL url, ResponseSpec response) { super(url); this.response=response; }
        @Override public void connect() throws IOException {
            if(response.connectFailure!=null) throw response.connectFailure;
            connected=true;
        }
        @Override public void disconnect() { disconnected=true; }
        @Override public boolean usingProxy() { return false; }
        @Override public void setInstanceFollowRedirects(boolean follow) {
            redirectsEnabled = follow;
            super.setInstanceFollowRedirects(follow);
        }
        @Override public void setRequestProperty(String key, String value) {
            requestProperties.put(key, value);
            super.setRequestProperty(key, value);
        }
        @Override public int getResponseCode() { return response.status; }
        @Override public String getResponseMessage() { return response.reason; }
        @Override public String getContentType() { return response.contentType; }
        @Override public String getHeaderField(String name) {
            for(Map.Entry<String,List<String>> entry:response.headers.entrySet())
                if(entry.getKey().equalsIgnoreCase(name) && !entry.getValue().isEmpty()) return entry.getValue().get(0);
            if("Content-Length".equalsIgnoreCase(name)) return response.contentLength;
            return null;
        }
        @Override public Map<String,List<String>> getHeaderFields() { return response.headers; }
        @Override public InputStream getInputStream() { return new ByteArrayInputStream(response.body); }
        @Override public InputStream getErrorStream() { return new ByteArrayInputStream(response.body); }
    }
}
