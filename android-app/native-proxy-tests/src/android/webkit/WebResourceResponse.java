package android.webkit;

import java.io.InputStream;
import java.util.Map;

public class WebResourceResponse {
    public final String mimeType, encoding, reasonPhrase;
    public final int statusCode;
    public final Map<String,String> responseHeaders;
    public final InputStream data;
    public WebResourceResponse(String mimeType, String encoding, int statusCode, String reasonPhrase,
            Map<String,String> responseHeaders, InputStream data) {
        this.mimeType=mimeType; this.encoding=encoding; this.statusCode=statusCode;
        this.reasonPhrase=reasonPhrase; this.responseHeaders=responseHeaders; this.data=data;
    }
}
