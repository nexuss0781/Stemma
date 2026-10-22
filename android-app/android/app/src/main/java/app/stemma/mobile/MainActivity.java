package app.stemma.mobile;

import android.os.Bundle;
import android.webkit.CookieManager;
import android.webkit.WebSettings;
import androidx.core.splashscreen.SplashScreen;
import com.getcapacitor.BridgeActivity;
import java.util.concurrent.Executors;
import java.util.concurrent.ScheduledExecutorService;
import java.util.concurrent.ScheduledFuture;
import java.util.concurrent.TimeUnit;

public class MainActivity extends BridgeActivity {
    private final ScheduledExecutorService cookieFlushWorker = Executors.newSingleThreadScheduledExecutor(runnable -> {
        Thread thread = new Thread(runnable, "stemma-cookie-flush");
        thread.setDaemon(true);
        return thread;
    });
    private ScheduledFuture<?> periodicCookieFlush;

    @Override
    public void onCreate(Bundle savedInstanceState) {
        SplashScreen.installSplashScreen(this);
        registerPlugin(StemmaMedia.class);
        registerPlugin(StemmaTransport.class);
        registerPlugin(StemmaPersistence.class);
        super.onCreate(savedInstanceState);
        if (getBridge() != null) {
            WebSettings settings = getBridge().getWebView().getSettings();
            settings.setDomStorageEnabled(true);
            settings.setCacheMode(WebSettings.LOAD_DEFAULT);
            getBridge().setWebViewClient(new StemmaBackendClient(getBridge()));
        }
    }

    @Override
    public void onResume() {
        super.onResume();
        if (periodicCookieFlush == null || periodicCookieFlush.isCancelled()) {
            periodicCookieFlush = cookieFlushWorker.scheduleWithFixedDelay(
                this::flushCookiesSafely, 30, 30, TimeUnit.SECONDS);
        }
    }

    @Override
    public void onPause() {
        stopPeriodicCookieFlush();
        enqueueCookieFlush();
        super.onPause();
    }

    @Override
    public void onStop() {
        enqueueCookieFlush();
        super.onStop();
    }

    @Override
    public void onDestroy() {
        stopPeriodicCookieFlush();
        enqueueCookieFlush();
        cookieFlushWorker.shutdown();
        super.onDestroy();
    }

    private void stopPeriodicCookieFlush() {
        if (periodicCookieFlush != null) {
            periodicCookieFlush.cancel(false);
            periodicCookieFlush = null;
        }
    }

    private void enqueueCookieFlush() {
        try {
            cookieFlushWorker.execute(this::flushCookiesSafely);
        } catch (java.util.concurrent.RejectedExecutionException ignored) {
            // The worker has already completed activity teardown.
        }
    }

    private void flushCookiesSafely() {
        try {
            CookieManager.getInstance().flush();
        } catch (RuntimeException ignored) {
            // Lifecycle flushing is best-effort and must never block or crash the UI.
        }
    }
}
