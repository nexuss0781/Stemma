package android.net;

import java.net.URI;
import java.net.URISyntaxException;

public final class Uri {
    private final URI value;
    private Uri(URI value) { this.value = value; }
    public static Uri parse(String text) {
        try { return new Uri(new URI(text)); }
        catch (URISyntaxException e) { throw new IllegalArgumentException(e); }
    }
    public String getScheme() { return value.getScheme(); }
    public String getHost() { return value.getHost(); }
    public String getPath() { return value.getPath(); }
    public String getEncodedPath() { return value.getRawPath(); }
    public String getEncodedQuery() { return value.getRawQuery(); }
    @Override public String toString() { return value.toString(); }
}
