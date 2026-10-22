package app.stemma.mobile;

import android.webkit.CookieManager;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import java.io.*;
import java.net.*;
import java.nio.charset.StandardCharsets;
import java.util.*;
import java.util.concurrent.*;
import org.json.JSONObject;

@CapacitorPlugin(name="StemmaTransport")
public class StemmaTransport extends Plugin {
    private final ExecutorService executor=Executors.newFixedThreadPool(2);
    private final ConcurrentHashMap<String,HttpURLConnection> active=new ConcurrentHashMap<>();
    @PluginMethod public void clearPrivateCache(PluginCall call) {
        executor.execute(()->{
            try {
                deleteChildren(new File(getContext().getCacheDir(),"stemma-media"));
                deleteChildren(new File(getContext().getFilesDir(),"stemma-media"));
                getContext().getSharedPreferences("stemma_media_recent_v1",android.content.Context.MODE_PRIVATE)
                    .edit().remove("recent_documents").apply();
                call.resolve();
            } catch(Exception e) { call.reject("Could not clear private media files.",e); }
        });
    }
    private void deleteChildren(File dir) throws IOException {
        if(!dir.exists()) return;
        File[] files=dir.listFiles();
        if(files==null) throw new IOException("Could not list private media files.");
        for(File f:files) {
            if(f.isDirectory()) deleteChildren(f);
            if(!f.delete() && f.exists()) throw new IOException("Could not remove private media file.");
        }
    }
    @PluginMethod public void cancelUpload(PluginCall call) {String id=call.getString("requestId","");HttpURLConnection connection=active.remove(id);if(connection!=null)connection.disconnect();call.resolve();}
    @PluginMethod public void request(PluginCall call) {
        executor.execute(()->{
            HttpURLConnection connection=null;
            try {
                URL url=new URL(call.getString("url",""));String method=call.getString("method","POST");
                if(!"https".equals(url.getProtocol()) || !"stemma.wasmer.app".equals(url.getHost()) || url.getPort()!=-1 || !url.getPath().matches("/(api|auth)/.*") || !method.matches("POST|PUT|PATCH|DELETE"))throw new IOException("Invalid server request.");
                String body=call.getString("body","");byte[] bytes=body.getBytes(StandardCharsets.UTF_8);if(bytes.length>8*1024*1024)throw new IOException("Request too large.");
                connection=(HttpURLConnection)url.openConnection();connection.setConnectTimeout(15000);connection.setReadTimeout(60000);connection.setInstanceFollowRedirects(false);connection.setRequestMethod(method);
                connection.setRequestProperty("Origin",StemmaBackendClient.ORIGIN);connection.setRequestProperty("Accept","application/json");
                connection.setRequestProperty("Content-Type",call.getString("contentType","application/json"));
                String cookie=CookieManager.getInstance().getCookie(StemmaBackendClient.ORIGIN);if(cookie!=null)connection.setRequestProperty("Cookie",cookie);
                if(bytes.length>0){connection.setDoOutput(true);connection.setFixedLengthStreamingMode(bytes.length);try(OutputStream out=connection.getOutputStream()){out.write(bytes);}}
                int status=connection.getResponseCode();
                for(Map.Entry<String,java.util.List<String>> header:connection.getHeaderFields().entrySet())if(header.getKey()!=null && header.getKey().equalsIgnoreCase("Set-Cookie"))for(String value:header.getValue())CookieManager.getInstance().setCookie(StemmaBackendClient.ORIGIN,value);
                CookieManager.getInstance().flush();
                InputStream in=status>=400?connection.getErrorStream():connection.getInputStream();ByteArrayOutputStream output=new ByteArrayOutputStream();if(in!=null)try(InputStream stream=in){byte[] buffer=new byte[32768];int n;while((n=stream.read(buffer))!=-1){if(output.size()+n>16*1024*1024)throw new IOException("Server response too large.");output.write(buffer,0,n);}}
                JSObject result=new JSObject();result.put("status",status);result.put("body",output.toString("UTF-8"));result.put("contentType",connection.getContentType()==null?"application/json":connection.getContentType());call.resolve(result);
            }catch(Exception error){call.reject("Server connection unavailable.");}
            finally{if(connection!=null)connection.disconnect();}
        });
    }
    @PluginMethod public void openAttachment(PluginCall call) {
        executor.execute(()->{
            HttpURLConnection connection=null;
            try {
                String path=call.getString("path","");
                if(!path.matches("/api/pulse/attachments/[a-fA-F0-9-]{36}"))throw new IOException("Invalid attachment.");
                connection=(HttpURLConnection)new URL(StemmaBackendClient.ORIGIN+path).openConnection();
                connection.setConnectTimeout(15000);connection.setReadTimeout(45000);connection.setInstanceFollowRedirects(false);
                String cookie=CookieManager.getInstance().getCookie(StemmaBackendClient.ORIGIN);if(cookie!=null)connection.setRequestProperty("Cookie",cookie);
                if(connection.getResponseCode()!=200)throw new IOException("Attachment unavailable.");
                String mime=connection.getContentType();if(mime==null)mime="application/octet-stream";mime=mime.split(";")[0];
                String extension=android.webkit.MimeTypeMap.getSingleton().getExtensionFromMimeType(mime);if(extension==null)extension="bin";
                File directory=new File(getContext().getCacheDir(),"stemma-media");directory.mkdirs();
                File file=new File(directory,"attachment_"+UUID.randomUUID()+"."+extension);
                try(InputStream in=connection.getInputStream();OutputStream out=new FileOutputStream(file)) {byte[] buffer=new byte[32768];long total=0;int n;while((n=in.read(buffer))!=-1){total+=n;if(total>6L*1024*1024){file.delete();throw new IOException("Attachment too large.");}out.write(buffer,0,n);}}
                android.net.Uri uri=androidx.core.content.FileProvider.getUriForFile(getContext(),getContext().getPackageName()+".fileprovider",file);
                android.content.Intent intent=new android.content.Intent(android.content.Intent.ACTION_VIEW);intent.setDataAndType(uri,mime);intent.addFlags(android.content.Intent.FLAG_GRANT_READ_URI_PERMISSION);
                getActivity().runOnUiThread(()->{try{getActivity().startActivity(intent);call.resolve();}catch(Exception error){call.reject("No installed app can open this file type.");}});
            } catch(Exception error){call.reject("Could not open this attachment. Check your connection and sign-in.");}
            finally{if(connection!=null)connection.disconnect();}
        });
    }
    @PluginMethod public void upload(PluginCall call) {
        executor.execute(()->{
            String id=call.getString("requestId",""); HttpURLConnection connection=null;
            try {
                String value=call.getString("path","");
                File file=new File(value.startsWith("file:")?UriToPath(value):value).getCanonicalFile();
                String cache=getContext().getCacheDir().getCanonicalPath()+File.separator;
                String data=getContext().getFilesDir().getCanonicalPath()+File.separator;
                if(!file.getPath().startsWith(cache) && !file.getPath().startsWith(data))throw new IOException("Invalid private file.");
                if(!file.isFile() || file.length()>256L*1024*1024)throw new IOException("File unavailable or too large.");
                URL url=new URL(call.getString("url",""));
                if(!"https".equals(url.getProtocol()) || !"stemma.wasmer.app".equals(url.getHost()) || url.getPort()!=-1 || !url.getPath().startsWith("/api/"))throw new IOException("Invalid upload destination.");
                connection=(HttpURLConnection)url.openConnection();
                connection.setRequestMethod("POST");connection.setDoOutput(true);connection.setInstanceFollowRedirects(false);
                connection.setConnectTimeout(20000);connection.setReadTimeout(180000);connection.setFixedLengthStreamingMode(file.length());
                connection.setRequestProperty("Origin",StemmaBackendClient.ORIGIN);connection.setRequestProperty("Accept","application/json");
                String cookie=CookieManager.getInstance().getCookie(StemmaBackendClient.ORIGIN);if(cookie!=null)connection.setRequestProperty("Cookie",cookie);
                JSObject headers=call.getObject("headers",new JSObject());
                Iterator<String> keys=headers.keys();while(keys.hasNext()){String key=keys.next();if(key.equalsIgnoreCase("Content-Type") || key.equalsIgnoreCase("X-Likee-Caption") || key.startsWith("X-Stemma-")) connection.setRequestProperty(key,headers.getString(key));}
                active.put(id,connection);
                try(InputStream input=new FileInputStream(file);OutputStream out=connection.getOutputStream()) {
                    byte[] buffer=new byte[65536];long sent=0,last=0;int count;
                    while((count=input.read(buffer))!=-1){if(!active.containsKey(id))throw new IOException("Upload cancelled.");out.write(buffer,0,count);sent+=count;long now=System.currentTimeMillis();if(now-last>100 || sent==file.length()){JSObject event=new JSObject();event.put("requestId",id);event.put("loaded",sent);event.put("total",file.length());notifyListeners("uploadProgress",event);last=now;}}
                }
                int status=connection.getResponseCode();InputStream response=status>=400?connection.getErrorStream():connection.getInputStream();
                ByteArrayOutputStream bytes=new ByteArrayOutputStream();if(response!=null)try(InputStream in=response){byte[] b=new byte[8192];int n;while((n=in.read(b))!=-1){if(bytes.size()+n>1024*1024)throw new IOException("Unexpected response.");bytes.write(b,0,n);}}
                JSObject result=new JSObject();result.put("status",status);try{result.put("data",new JSONObject(bytes.toString(StandardCharsets.UTF_8.name())));}catch(Exception e){result.put("data",new JSObject());}call.resolve(result);
            } catch(Exception error){call.reject("Upload interrupted. Your original file is unchanged; check the destination before retrying.");}
            finally{active.remove(id);if(connection!=null)connection.disconnect();}
        });
    }
    private String UriToPath(String value) {return android.net.Uri.parse(value).getPath();}
    @Override protected void handleOnDestroy(){for(HttpURLConnection c:active.values())c.disconnect();active.clear();executor.shutdownNow();super.handleOnDestroy();}
}
