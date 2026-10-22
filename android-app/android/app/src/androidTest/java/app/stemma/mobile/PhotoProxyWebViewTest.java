package app.stemma.mobile;

import static org.junit.Assert.*;

import android.webkit.WebView;
import androidx.test.core.app.ActivityScenario;
import androidx.test.ext.junit.runners.AndroidJUnit4;
import androidx.test.platform.app.InstrumentationRegistry;
import java.io.ByteArrayInputStream;
import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.util.Arrays;
import java.util.Collections;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicReference;
import org.json.JSONObject;
import org.json.JSONTokener;
import org.junit.BeforeClass;
import org.junit.Test;
import org.junit.runner.RunWith;

/**
 * Exercises Chromium's fetch-visible headers/body after the real StemmaBackendClient has
 * produced WebResourceResponses. An injected fake HttpURLConnection avoids network dependence.
 */
@RunWith(AndroidJUnit4.class)
public final class PhotoProxyWebViewTest {
    private static final String BASE_URL = "https://localhost/api/student-profile/photo?androidtest=";
    private static byte[] webpBytes;

    @BeforeClass public static void loadWebpFixture() throws Exception {
        InputStream fixture = InstrumentationRegistry.getInstrumentation().getContext()
                .getAssets().open("photo-15284.webp");
        try {
            ByteArrayOutputStream out = new ByteArrayOutputStream();
            byte[] buffer = new byte[4096];
            int count;
            while ((count = fixture.read(buffer)) != -1) out.write(buffer, 0, count);
            webpBytes = out.toByteArray();
        } finally { fixture.close(); }
        assertEquals("fixture is the exact upstream Content-Length", 15284, webpBytes.length);
    }

    @Test public void chromiumFetchSeesSingleHeadersAndValidatorAcceptsDecodable15284ByteWebp() throws Exception {
        ActivityScenario<MainActivity> scenario = launchWithFakeProxy();
        try {
            JSONObject result = fetchAndValidate(scenario, "normal");
            assertTrue("HTTP 200 photo response", result.getBoolean("ok"));
            assertEquals("image/webp", result.getString("ct"));
            assertEquals("15284", result.getString("cl"));
            assertEquals("native-proxy", result.getString("route"));
            assertEquals("image/webp", result.getString("mime"));
            assertEquals("15284", result.getString("length"));
            assertEquals("1", result.getString("mimeValues"));
            assertEquals("1", result.getString("lengthValues"));
            assertEquals(15284, result.getInt("n"));
            assertEquals("image/webp", result.getString("validatedType"));
            assertEquals(15284, result.getInt("validatedSize"));
            assertEquals(32, result.getInt("w"));
            assertEquals(24, result.getInt("h"));
        } finally { scenario.close(); }
    }

    @Test public void duplicateUpstreamHeadersRemainSingleAtFetchBoundary() throws Exception {
        ActivityScenario<MainActivity> scenario = launchWithFakeProxy();
        try {
            JSONObject result = fetchAndValidate(scenario, "duplicate");
            assertEquals("image/webp", result.getString("ct"));
            assertEquals("15284", result.getString("cl"));
            assertEquals("image/webp, image/webp", result.getString("mime"));
            assertEquals("2", result.getString("mimeValues"));
            assertEquals("2", result.getString("lengthValues"));
            assertEquals(15284, result.getInt("validatedSize"));
        } finally { scenario.close(); }
    }

    @Test public void malformedUpstreamLengthDoesNotCorruptWireLengthOrPhotoBytes() throws Exception {
        ActivityScenario<MainActivity> scenario = launchWithFakeProxy();
        try {
            JSONObject result = fetchAndValidate(scenario, "bad-length");
            assertTrue(result.toString(), result.getBoolean("ok"));
            assertEquals("15284", result.getString("cl"));
            assertEquals("invalid", result.getString("length"));
            assertEquals("2", result.getString("lengthValues"));
            assertEquals(15284, result.getInt("validatedSize"));
            assertEquals("image/webp", result.getString("validatedType"));
        } finally { scenario.close(); }
    }

    @Test public void htmlPhotoBodyIsRejectedByRuntimePhotoValidator() throws Exception {
        ActivityScenario<MainActivity> scenario = launchWithFakeProxy();
        try {
            JSONObject result = new JSONObject(evaluate(scenario,
                    "(async()=>{try{const r=await fetch(" + JSONObject.quote(BASE_URL + "html") + ");" +
                    "await window.StemmaAndroidPhotoResponse.read(r);return JSON.stringify({rejected:false});" +
                    "}catch(e){return JSON.stringify({rejected:true,name:e.name,category:e.photoCategory,phase:e.photoPhase})}})()"));
            assertTrue(result.toString(), result.getBoolean("rejected"));
            assertEquals("PhotoValidationError", result.getString("name"));
            assertEquals("non-image", result.getString("category"));
            assertEquals("signature-validation", result.getString("phase"));
        } finally { scenario.close(); }
    }

    private static ActivityScenario<MainActivity> launchWithFakeProxy() throws Exception {
        ActivityScenario<MainActivity> scenario = ActivityScenario.launch(MainActivity.class);
        long deadline = System.currentTimeMillis() + 90000;
        String ready = "false";
        while (System.currentTimeMillis() < deadline && !"true".equals(ready)) {
            ready = evaluate(scenario, "Boolean(window.StemmaNative && window.StemmaAndroidPhotoResponse)");
            if (!"true".equals(ready)) Thread.sleep(250);
        }
        assertEquals("production app and its real photo validator are loaded", "true", ready);
        scenario.onActivity(activity -> {
            activity.getBridge().getWebView().setWebViewClient(new StemmaBackendClient(
                    activity.getBridge(), url -> new FakePhotoConnection(url, responseFor(url))));
        });
        return scenario;
    }

    private static FakeReply responseFor(URL url) throws IOException {
        String query = url.getQuery();
        if ("androidtest=html".equals(query)) {
            byte[] html = "<!doctype html><title>upstream error</title>".getBytes(java.nio.charset.StandardCharsets.UTF_8);
            return new FakeReply("text/html; charset=utf-8", Arrays.asList(Integer.toString(html.length), Integer.toString(html.length)), html);
        }
        if ("androidtest=bad-length".equals(query))
            return new FakeReply("image/webp", Arrays.asList("15284", "not-a-number"), webpBytes);
        if ("androidtest=normal".equals(query))
            return new FakeReply("image/webp", Collections.singletonList("15284"), webpBytes, false);
        if ("androidtest=duplicate".equals(query))
            return new FakeReply("image/webp", Arrays.asList("15284", "15284"), webpBytes);
        throw new IOException("Unexpected fake photo URL: " + url);
    }

    private static JSONObject fetchAndValidate(ActivityScenario<MainActivity> scenario, String mode) throws Exception {
        String script = "(async()=>{try{" +
                "const r=await fetch(" + JSONObject.quote(BASE_URL + mode) + ", {cache:'no-store'});" +
                "const ct=r.headers.get('content-type'), cl=r.headers.get('content-length');" +
                "const route=r.headers.get('x-stemma-photo-route'), mime=r.headers.get('x-stemma-photo-content-type');" +
                "const length=r.headers.get('x-stemma-photo-content-length');" +
                "const mimeValues=r.headers.get('x-stemma-photo-content-type-values'), lengthValues=r.headers.get('x-stemma-photo-content-length-values');" +
                "const blob=await window.StemmaAndroidPhotoResponse.read(r);" +
                "const image=await createImageBitmap(blob);const result={ok:r.ok,ct,cl,route,mime,length,mimeValues,lengthValues," +
                "n:blob.size,validatedSize:blob.size,validatedType:blob.type,w:image.width,h:image.height};image.close();" +
                "return JSON.stringify(result);" +
                "}catch(e){return JSON.stringify({error:String(e),category:e.photoCategory,phase:e.photoPhase})}})()";
        JSONObject result = new JSONObject(evaluate(scenario, script));
        assertNull("fetch/photo validation succeeds: " + result, result.optString("error", null));
        return result;
    }

    private static String evaluate(ActivityScenario<MainActivity> scenario, String javascript) throws Exception {
        String setup = "window.__photoProxyTestDone=false;window.__photoProxyTestResult=null;" +
                "Promise.resolve(" + javascript + ").then(v=>{window.__photoProxyTestResult=String(v);window.__photoProxyTestDone=true}," +
                "e=>{window.__photoProxyTestResult='ERROR:'+String(e);window.__photoProxyTestDone=true});true";
        scenario.onActivity(activity -> {
            activity.getBridge().getWebView().evaluateJavascript(setup, null);
        });
        long deadline = System.currentTimeMillis() + 45000;
        while (System.currentTimeMillis() < deadline) {
            AtomicReference<String> value = new AtomicReference<>();
            CountDownLatch done = new CountDownLatch(1);
            scenario.onActivity(activity -> activity.getBridge().getWebView().evaluateJavascript(
                    "window.__photoProxyTestDone ? JSON.stringify(window.__photoProxyTestResult) : null",
                    result -> { value.set(result); done.countDown(); }));
            assertTrue("WebView result poll completed", done.await(5, TimeUnit.SECONDS));
            Object parsed = new JSONTokener(value.get()).nextValue();
            if (parsed instanceof String) {
                String result = (String) parsed;
                if (result.startsWith("ERROR:")) fail("WebView JavaScript rejected: " + result);
                return result;
            }
            Thread.sleep(100);
        }
        fail("WebView JavaScript Promise did not settle within 45 seconds");
        return null;
    }

    private static final class FakeReply {
        final String contentType;
        final List<String> lengths;
        final byte[] body;
        final boolean duplicateMime;
        FakeReply(String type, List<String> lengthValues, byte[] bytes) { this(type,lengthValues,bytes,true); }
        FakeReply(String type, List<String> lengthValues, byte[] bytes, boolean duplicate) {
            contentType = type; lengths = lengthValues; body = bytes.clone(); duplicateMime=duplicate;
        }
    }

    /** Fake upstream deliberately exposes duplicate raw header values, as HTTP stacks can. */
    private static final class FakePhotoConnection extends HttpURLConnection {
        private final FakeReply reply;
        private final Map<String, List<String>> headers = new LinkedHashMap<>();
        FakePhotoConnection(URL url, FakeReply response) {
            super(url);
            reply = response;
            headers.put(null, Collections.singletonList("HTTP/1.1 200 OK"));
            headers.put("Content-Type", reply.duplicateMime ? Arrays.asList(reply.contentType, reply.contentType) : Collections.singletonList(reply.contentType));
            headers.put("Content-Length", reply.lengths);
        }
        @Override public void connect() { connected = true; }
        @Override public void disconnect() { connected = false; }
        @Override public boolean usingProxy() { return false; }
        @Override public int getResponseCode() { return 200; }
        @Override public String getResponseMessage() { return "OK"; }
        @Override public String getContentType() { return reply.contentType; }
        @Override public String getHeaderField(String name) {
            if ("Content-Type".equalsIgnoreCase(name)) return reply.contentType;
            if ("Content-Length".equalsIgnoreCase(name)) return reply.lengths.get(0);
            return null;
        }
        @Override public Map<String, List<String>> getHeaderFields() { return headers; }
        @Override public InputStream getInputStream() { return new ByteArrayInputStream(reply.body); }
    }
}
