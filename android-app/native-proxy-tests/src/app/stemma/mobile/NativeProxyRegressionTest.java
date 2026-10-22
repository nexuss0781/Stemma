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
import java.net.HttpURLConnection;
import java.net.URL;
import java.net.URLConnection;
import java.net.URLStreamHandler;
import java.util.Collections;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

public final class NativeProxyRegressionTest {
    private static final String ORIGIN = "https://stemma.wasmer.app";
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
        verifyErrorStatus(client, 401, "Unauthorized");
        verifyErrorStatus(client, 404, "Not Found");
        verifyRedirectBlocked(client);
        verifyDelegation(client, "https://example.com/api/student-profile/photo", "GET");
        verifyDelegation(client, "https://localhost/api/student-profile/photo", "POST");
        System.out.println("PASS: native proxy JVM regression harness (8 scenarios)");
    }

    private static void verifyImage(StemmaBackendClient client, String expectedMime, String responseType) throws Exception {
        nextResponse = new ResponseSpec(200, "OK", responseType, IMAGE_BYTES);
        WebResourceResponse response = intercept(client, "https://localhost/api/student-profile/photo", "GET");
        check(response != null, "image response is proxied");
        check(response.statusCode == 200, "image status preserved");
        check(expectedMime.equals(response.mimeType), "MIME type should be " + expectedMime + ", got " + response.mimeType);
        check(responseType.equals(response.responseHeaders.get("Content-Type")), "explicit Content-Type header is preserved: " + responseType);
        check("private, no-store".equals(response.responseHeaders.get("Cache-Control")), "no-store header present");
        check("nosniff".equals(response.responseHeaders.get("X-Content-Type-Options")), "nosniff header present");
        check("session=expected; theme=dark".equals(lastConnection.requestProperties.get("Cookie")), "Cookie header comes from CookieManager at the configured origin");
        check(ArraysEqual(IMAGE_BYTES, readAll(response.data)), "binary image bytes, including high-bit bytes, are exact");
        check(!lastConnection.disconnected, "connection remains open until response stream closes");
        response.data.close();
        check(lastConnection.disconnected, "connection disconnects when response stream closes");
    }

    private static void verifyErrorStatus(StemmaBackendClient client, int status, String reason) throws Exception {
        byte[] body = new byte[] {(byte)0x89, 0x00, (byte)status};
        nextResponse = new ResponseSpec(status, reason, "image/jpeg", body);
        WebResourceResponse response = intercept(client, "https://localhost/api/student-profile/photo", "GET");
        check(response.statusCode == status, "HTTP error status " + status + " is preserved");
        check(reason.equals(response.reasonPhrase), "HTTP reason phrase " + reason + " is preserved");
        check(ArraysEqual(body, readAll(response.data)), "HTTP " + status + " body comes from error stream");
        response.data.close();
        check(lastConnection.disconnected, "HTTP " + status + " connection disconnects on close");
    }

    private static void verifyRedirectBlocked(StemmaBackendClient client) throws Exception {
        nextResponse = new ResponseSpec(302, "Found", "text/html", new byte[] {1});
        WebResourceResponse response = intercept(client, "https://localhost/api/student-profile/photo", "GET");
        check(response.statusCode == 502, "redirect is translated to 502");
        check(lastConnection.disconnected, "redirect connection disconnects immediately");
        check(!lastConnection.redirectsEnabled, "automatic redirect following is disabled");
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
        final int status; final String reason, contentType; final byte[] body;
        ResponseSpec(int status, String reason, String contentType, byte[] body) {
            this.status=status; this.reason=reason; this.contentType=contentType; this.body=body;
        }
    }
    private static final class MockHttpsConnection extends HttpURLConnection {
        final ResponseSpec response;
        final Map<String,String> requestProperties = new LinkedHashMap<>();
        boolean disconnected;
        boolean redirectsEnabled = true;
        MockHttpsConnection(URL url, ResponseSpec response) { super(url); this.response=response; }
        @Override public void connect() { connected=true; }
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
        @Override public String getHeaderField(String name) { return null; }
        @Override public Map<String,List<String>> getHeaderFields() { return Collections.emptyMap(); }
        @Override public InputStream getInputStream() { return new ByteArrayInputStream(response.body); }
        @Override public InputStream getErrorStream() { return new ByteArrayInputStream(response.body); }
    }
}
