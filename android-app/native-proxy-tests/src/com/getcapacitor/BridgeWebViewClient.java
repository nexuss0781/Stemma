package com.getcapacitor;

import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebView;

public class BridgeWebViewClient {
    public static int delegatedCalls;
    public BridgeWebViewClient(Bridge bridge) { }
    public WebResourceResponse shouldInterceptRequest(WebView view, WebResourceRequest request) {
        delegatedCalls++;
        return null;
    }
}
