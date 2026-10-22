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
import java.util.ArrayList;
import java.util.Collections;
import java.util.List;
import java.util.Map;
import javax.net.ssl.SSLException;

/** Streams authenticated backend resources without moving large media over the JS bridge. */
public final class StemmaBackendClient extends BridgeWebViewClient {
    static final String ORIGIN = "https://stemma.wasmer.app";
    private static final String PHOTO_PATH = "/api/student-profile/photo";

    private static final int MAX_PHOTO_BYTES=1024*1024;
    interface ConnectionFactory { HttpURLConnection open(URL url) throws IOException; }
    private final ConnectionFactory connections;

    public StemmaBackendClient(Bridge bridge) { this(bridge,url -> (HttpURLConnection)url.openConnection()); }
    StemmaBackendClient(Bridge bridge,ConnectionFactory connections) { super(bridge);this.connections=connections; }

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
            conn=connections.open(url);
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
            Map<String,List<String>> upstreamFields=conn.getHeaderFields();
            if(upstreamFields==null)upstreamFields=Collections.emptyMap();
            for(Map.Entry<String,List<String>> entry:upstreamFields.entrySet()) {
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
            // Chromium creates Content-Type from mimeType and Content-Length from
            // InputStream.available(), THEN AddHeader() appends the header map.
            // Photo responses give those singleton headers exactly ONE owner.
            if(!photo)headers.put("Content-Type",contentType);
            for(String name:new String[]{"Content-Range","Accept-Ranges","ETag","Last-Modified","Content-Disposition"}) { String value=conn.getHeaderField(name); if(value!=null)headers.put(name,value); }
            if(!photo && upstreamContentLength!=null)headers.put("Content-Length",upstreamContentLength);
            headers.put("Cache-Control","private, no-store"); headers.put("X-Content-Type-Options","nosniff");
            if(photo) {
                List<String> typeValues=headerValues(upstreamFields,"Content-Type",upstreamContentType);
                List<String> lengthValues=headerValues(upstreamFields,"Content-Length",upstreamContentLength);
                String safeContentType=normalizePhotoContentType(joinBounded(typeValues));
                String safeContentLength=normalizePhotoContentLengths(lengthValues);
                mime=canonicalPhotoMime(safeContentType);
                addPhotoDiagnostics(headers,backendStatus,"none",backendStatus>=400?"http":"headers");
                headers.put("X-Stemma-Photo-Content-Type",safeContentType);
                headers.put("X-Stemma-Photo-Content-Length",safeContentLength);
                headers.put("X-Stemma-Photo-Content-Type-Values",Integer.toString(headerValueCount(typeValues)));
                headers.put("X-Stemma-Photo-Content-Length-Values",Integer.toString(headerValueCount(lengthValues)));
                phase="body";
                InputStream stream=backendStatus>=400?conn.getErrorStream():conn.getInputStream();
                byte[] bytes;
                try(InputStream input=stream) { bytes=readBoundedPhoto(input); }
                String reason=conn.getResponseMessage(); if(reason==null || reason.trim().isEmpty())reason="Response";
                conn.disconnect();
                // A network stream's available() is NOT its total length. A bounded
                // in-memory stream makes Chromium's generated length byte-exact.
                // No photo bytes are persisted, cached, logged or sent over JS IPC.
                return new WebResourceResponse(mime,null,backendStatus,reason,headers,new ByteArrayInputStream(bytes));
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
            return failure(error instanceof PhotoBodyTooLarge?413:503,"Connection unavailable.",photo,backendStatus,category,phase);
        }
    }

    private static String errorCategory(Exception error,String phase) {
        if(error instanceof PhotoBodyTooLarge)return "body-size";
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

    private static final class PhotoBodyTooLarge extends IOException { }

    private static byte[] readBoundedPhoto(InputStream input) throws IOException {
        if(input==null)return new byte[0];
        ByteArrayOutputStream output=new ByteArrayOutputStream(16384);
        byte[] chunk=new byte[8192];int noProgress=0;
        while(true) {
            int count=input.read(chunk,0,Math.min(chunk.length,MAX_PHOTO_BYTES+1-output.size()));
            if(count<0)break;
            if(count==0){if(++noProgress>16)throw new IOException("Photo stream made no progress.");continue;}
            noProgress=0;
            if(output.size()+count>MAX_PHOTO_BYTES)throw new PhotoBodyTooLarge();
            output.write(chunk,0,count);
        }
        return output.toByteArray();
    }

    private static List<String> headerValues(Map<String,List<String>> fields,String name,String fallback) {
        List<String> values=new ArrayList<>();
        for(Map.Entry<String,List<String>> entry:fields.entrySet()) {
            if(entry.getKey()!=null && entry.getKey().equalsIgnoreCase(name) && entry.getValue()!=null)
                for(String value:entry.getValue()){if(values.size()>=32)return values;values.add(value==null?"":value);}
        }
        if(values.isEmpty() && fallback!=null)values.add(fallback);
        return values;
    }

    private static String joinBounded(List<String> values) {
        if(values.isEmpty())return null;
        StringBuilder joined=new StringBuilder();
        for(String value:values){if(value.length()>1024 || joined.length()+value.length()>1024)return "invalid";if(joined.length()>0)joined.append(", ");joined.append(value);}
        return joined.toString();
    }

    private static int headerValueCount(List<String> values) {
        int count=0;
        for(String value:values){if(value.length()>1024)return 32;count+=value.split(",",-1).length;if(count>=32)return 32;}
        return count;
    }

    private static String canonicalPhotoMime(String normalized) {
        if("missing".equals(normalized) || "invalid".equals(normalized))return "application/octet-stream";
        String[] values=normalized.split(", ");
        for(String value:values)if(!values[0].equals(value))return "application/octet-stream";
        return values[0];
    }

    private static String normalizePhotoContentLengths(List<String> values) {
        if(values.isEmpty())return "missing";
        String canonical=null;
        for(String value:values) {
            if(value.length()>1024)return "invalid";
            for(String part:value.split(",",-1)) {
                String normalized=normalizePhotoContentLength(part);
                if("missing".equals(normalized) || "invalid".equals(normalized))return "invalid";
                String numeric=Long.toString(Long.parseLong(normalized));
                if(canonical!=null && !canonical.equals(numeric))return "invalid";
                canonical=numeric;
            }
        }
        return canonical==null?"missing":canonical;
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
