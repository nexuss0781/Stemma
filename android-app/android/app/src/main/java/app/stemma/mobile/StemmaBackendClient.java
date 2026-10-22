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
import java.net.ConnectException;
import java.net.HttpURLConnection;
import java.net.SocketTimeoutException;
import java.net.URL;
import java.net.UnknownHostException;
import java.net.ProtocolException;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import javax.net.ssl.SSLException;

/** Streams authenticated backend resources without moving large media over the JS bridge. */
public final class StemmaBackendClient extends BridgeWebViewClient {
    static final String ORIGIN = "https://stemma.wasmer.app";
    private static final String PHOTO_PATH = "/api/student-profile/photo";

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
        final Uri uri=request.getUrl();
        final boolean photo=PHOTO_PATH.equals(uri.getPath());
        String phase="connect";
        int backendStatus=-1;
        try {
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
            conn.connect();
            phase="headers";
            backendStatus=conn.getResponseCode();
            if(backendStatus>=300 && backendStatus<400) {
                conn.disconnect();
                return failure(502,"Backend redirects are not permitted.",photo,backendStatus,"redirect","http");
            }
            CookieManager cookieManager=CookieManager.getInstance();
            boolean cookieUpdated=false;
            for(Map.Entry<String,List<String>> entry:conn.getHeaderFields().entrySet()) {
                if(entry.getKey()!=null && entry.getKey().equalsIgnoreCase("Set-Cookie")) {
                    for(String cookie:entry.getValue()) { cookieManager.setCookie(ORIGIN,cookie); cookieUpdated=true; }
                }
            }
            if(cookieUpdated) cookieManager.flush();
            String upstreamContentType=conn.getContentType();
            String upstreamContentLength=conn.getHeaderField("Content-Length");
            String contentType=upstreamContentType; if(contentType==null)contentType="application/octet-stream";
            String mime=contentType.split(";")[0];
            Map<String,String> headers=new HashMap<>();
            // WebView's MIME argument alone is not a fetch-visible Content-Type
            // when an explicit response-header map is supplied. Photo validation
            // must see the account response's actual image MIME type.
            headers.put("Content-Type",contentType);
            for(String name:new String[]{"Content-Length","Content-Range","Accept-Ranges","ETag","Last-Modified","Content-Disposition"}) { String value=conn.getHeaderField(name); if(value!=null)headers.put(name,value); }
            headers.put("Cache-Control","private, no-store"); headers.put("X-Content-Type-Options","nosniff");
            if(photo) {
                addPhotoDiagnostics(headers,backendStatus,"none",backendStatus>=400?"http":"headers");
                String safeContentType=normalizePhotoContentType(upstreamContentType);
                String safeContentLength=normalizePhotoContentLength(upstreamContentLength);
                headers.put("X-Stemma-Photo-Content-Type",safeContentType);
                headers.put("X-Stemma-Photo-Content-Length",safeContentLength);
            }
            final HttpURLConnection owned=conn;
            phase="body";
            InputStream stream=backendStatus>=400?conn.getErrorStream():conn.getInputStream();
            if(stream==null)stream=new ByteArrayInputStream(new byte[0]);
            InputStream body=new FilterInputStream(stream) { @Override public void close() throws IOException { try{super.close();}finally{owned.disconnect();} } };
            String reason=conn.getResponseMessage(); if(reason==null || reason.trim().isEmpty())reason="Response";
            return new WebResourceResponse(mime,"UTF-8",backendStatus,reason,headers,body);
        } catch(Exception error) {
            if(conn!=null)conn.disconnect();
            String category=errorCategory(error,phase);
            return failure(503,"Connection unavailable.",photo,backendStatus,category,phase);
        }
    }

    private static String errorCategory(Exception error,String phase) {
        if(error instanceof UnknownHostException)return "dns";
        if(error instanceof SSLException)return "tls";
        if(error instanceof SocketTimeoutException)return "connect".equals(phase)?"connect-timeout":"read-timeout";
        if(error instanceof ConnectException)return "connection";
        if(error instanceof ProtocolException)return "protocol";
        if(error instanceof IOException)return "connection";
        return "unknown";
    }

    private WebResourceResponse failure(int status,String message,boolean photo,int backendStatus,String error,String phase) {
        Map<String,String> headers=new HashMap<>();headers.put("Cache-Control","no-store");
        if(photo) {
            headers.put("Content-Type","text/plain; charset=UTF-8");
            addPhotoDiagnostics(headers,backendStatus,error,phase);
        }
        return new WebResourceResponse("text/plain","UTF-8",status,"Unavailable",headers,new ByteArrayInputStream(message.getBytes(java.nio.charset.StandardCharsets.UTF_8)));
    }

    private static void addPhotoDiagnostics(Map<String,String> headers,int status,String error,String phase) {
        headers.put("X-Stemma-Photo-Route","native-proxy");
        headers.put("X-Stemma-Photo-Status",Integer.toString(status));
        headers.put("X-Stemma-Photo-Error",error);
        headers.put("X-Stemma-Photo-Phase",phase);
    }

    static String normalizePhotoContentType(String value) {
        if(value==null || value.trim().isEmpty())return "missing";
        if(value.length()>1024)return "invalid";
        for(int i=0;i<value.length();i++) {
            char c=value.charAt(i);
            if(c<0x20 || c==0x7f)return "invalid";
        }
        String[] values=value.split(",",-1);
        if(values.length>4)return "invalid";
        StringBuilder normalized=new StringBuilder();
        for(String item:values) {
            int parameter=item.indexOf(';');
            String essence=(parameter<0?item:item.substring(0,parameter)).trim();
            if(!essence.matches("[A-Za-z0-9!#$&^_.+\\-]+/[A-Za-z0-9!#$&^_.+\\-]+"))return "invalid";
            if(normalized.length()>0)normalized.append(", ");
            normalized.append(essence.toLowerCase(java.util.Locale.ROOT));
        }
        return normalized.length()<=127?normalized.toString():"invalid";
    }

    static String normalizePhotoContentLength(String value) {
        if(value==null || value.isEmpty())return "missing";
        for(int i=0;i<value.length();i++) {
            char c=value.charAt(i);
            if((c<0x20 && c!=' ' && c!='\t') || c==0x7f)return "invalid";
        }
        String digits=value.trim();
        return digits.matches("[0-9]{1,12}")?digits:"invalid";
    }
}
