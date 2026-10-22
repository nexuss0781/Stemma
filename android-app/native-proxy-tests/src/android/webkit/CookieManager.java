package android.webkit;

import java.util.HashMap;
import java.util.Map;

public final class CookieManager {
    private static final CookieManager INSTANCE = new CookieManager();
    private final Map<String,String> cookies = new HashMap<>();
    public static CookieManager getInstance() { return INSTANCE; }
    public String getCookie(String url) { return cookies.get(url); }
    public void setCookie(String url, String value) { cookies.put(url, value); }
    public void flush() { }
}
