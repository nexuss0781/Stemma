package app.stemma.mobile;

import android.net.Uri;
import android.webkit.CookieManager;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebView;
import com.getcapacitor.Bridge;
import com.getcapacitor.BridgeWebViewClient;
import java.io.ByteArrayInputStream;
import java.io.FilterInputStream;
import java.io.IOException;
import java.io.InputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.util.HashMap;
import java.util.List;
import java.util.Map;

/** Streams authenticated backend resources without moving large media over the JS bridge. */
public final class StemmaBackendClient extends BridgeWebViewClient {
    static final String ORIGIN = "https://stemma.wasmer.app";
    public StemmaBackendClient(Bridge bridge) { super(bridge); }
    @Override public WebResourceResponse shouldInterceptRequest(WebView view, WebResourceRequest request) {
        Uri uri=request.getUrl();
        if ("https".equals(uri.getScheme()) && "localhost".equals(uri.getHost()) && uri.getPath()!=null && uri.getPath().startsWith("/api/") && "GET".equals(request.getMethod())) {
            return proxy(request);
        }
        return super.shouldInterceptRequest(view,request);
    }
    private WebResourceResponse proxy(WebResourceRequest request) {
        HttpURLConnection conn=null;
        try {
            Uri uri=request.getUrl();
            URL url=new URL(ORIGIN+uri.getEncodedPath()+(uri.getEncodedQuery()==null?"":"?"+uri.getEncodedQuery()));
            conn=(HttpURLConnection)url.openConnection();
            conn.setConnectTimeout(15000); conn.setReadTimeout(45000); conn.setInstanceFollowRedirects(false);
            conn.setRequestProperty("Origin",ORIGIN);
            String cookies=CookieManager.getInstance().getCookie(ORIGIN);
            if(cookies!=null) conn.setRequestProperty("Cookie",cookies);
            for(String name:new String[]{"Range","If-None-Match","If-Modified-Since","Accept"}) {
                String value=request.getRequestHeaders().get(name);
                if(value!=null) conn.setRequestProperty(name,value);
            }
            int status=conn.getResponseCode();
            if(status>=300 && status<400) { conn.disconnect(); return failure(502,"Backend redirects are not permitted."); }
            CookieManager cookieManager=CookieManager.getInstance();
            boolean cookieUpdated=false;
            for(Map.Entry<String,List<String>> entry:conn.getHeaderFields().entrySet()) {
                if(entry.getKey()!=null && entry.getKey().equalsIgnoreCase("Set-Cookie")) {
                    for(String cookie:entry.getValue()) { cookieManager.setCookie(ORIGIN,cookie); cookieUpdated=true; }
                }
            }
            if(cookieUpdated) cookieManager.flush();
            String contentType=conn.getContentType(); if(contentType==null)contentType="application/octet-stream";
            String mime=contentType.split(";")[0];
            Map<String,String> headers=new HashMap<>();
            for(String name:new String[]{"Content-Length","Content-Range","Accept-Ranges","ETag","Last-Modified","Content-Disposition"}) { String value=conn.getHeaderField(name); if(value!=null)headers.put(name,value); }
            headers.put("Cache-Control","private, no-store"); headers.put("X-Content-Type-Options","nosniff");
            final HttpURLConnection owned=conn;
            InputStream stream=status>=400?conn.getErrorStream():conn.getInputStream();
            if(stream==null)stream=new ByteArrayInputStream(new byte[0]);
            InputStream body=new FilterInputStream(stream) { @Override public void close() throws IOException { try{super.close();}finally{owned.disconnect();} } };
            String reason=conn.getResponseMessage(); if(reason==null || reason.trim().isEmpty())reason="Response";
            return new WebResourceResponse(mime,"UTF-8",status,reason,headers,body);
        } catch(Exception error) { if(conn!=null)conn.disconnect(); return failure(503,"Connection unavailable."); }
    }
    private WebResourceResponse failure(int status,String message) {
        Map<String,String> headers=new HashMap<>();headers.put("Cache-Control","no-store");
        return new WebResourceResponse("text/plain","UTF-8",status,"Unavailable",headers,new ByteArrayInputStream(message.getBytes(java.nio.charset.StandardCharsets.UTF_8)));
    }
}
