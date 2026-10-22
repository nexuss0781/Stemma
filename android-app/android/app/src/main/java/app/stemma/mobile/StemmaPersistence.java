package app.stemma.mobile;

import android.net.Uri;
import android.os.Looper;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.atomic.AtomicReference;
import android.util.AtomicFile;
import android.webkit.CookieManager;
import androidx.work.BackoffPolicy;
import androidx.work.Constraints;
import androidx.work.Data;
import androidx.work.ExistingPeriodicWorkPolicy;
import androidx.work.NetworkType;
import androidx.work.PeriodicWorkRequest;
import androidx.work.WorkManager;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.Executors;
import java.util.concurrent.ScheduledExecutorService;
import org.json.JSONObject;

/** Private, crash-safe persistence for the Stemma web runtime. */
@CapacitorPlugin(name = "StemmaPersistence")
public final class StemmaPersistence extends Plugin {
    private static final int MAX_VALUE_BYTES = 64 * 1024 * 1024;
    private static final String KEY_PATTERN = "[A-Za-z0-9][A-Za-z0-9._:-]{0,159}";
    static final String SESSION_PREFS = "stemma_session_renewal_v1";
    static final String SESSION_ENABLED = "enabled";
    static final String SESSION_GENERATION = "generation";
    static final String SESSION_WORK_NAME = "stemma-session-renewal-v1";
    static final String SESSION_GENERATION_INPUT = "generation";
    static final Object SESSION_STATE_LOCK = new Object();

    // One worker serializes file operations and cookie flushes without blocking the UI.
    private final ScheduledExecutorService executor = Executors.newSingleThreadScheduledExecutor();

    @PluginMethod
    public void load(PluginCall call) {
        if (!requireLocalOrigin(call)) return;
        final String key;
        try {
            key = requireKey(call);
        } catch (IOException error) {
            call.reject(error.getMessage());
            return;
        }
        executor.execute(() -> {
            try {
                AtomicFile file = atomicFile(key);
                if (!file.getBaseFile().exists() && !new File(file.getBaseFile().getPath() + ".bak").exists()) {
                    JSObject result = new JSObject();
                    result.put("value", JSONObject.NULL);
                    call.resolve(result);
                    return;
                }
                try (FileInputStream input = file.openRead()) {
                    if (file.getBaseFile().length() > MAX_VALUE_BYTES) throw new IOException("Stored value exceeds the size limit.");
                    ByteArrayOutputStream output = new ByteArrayOutputStream();
                    byte[] buffer = new byte[16 * 1024];
                    int count;
                    while ((count = input.read(buffer)) != -1) {
                        if (output.size() + count > MAX_VALUE_BYTES) throw new IOException("Stored value exceeds the size limit.");
                        output.write(buffer, 0, count);
                    }
                    JSObject result = new JSObject();
                    result.put("value", new String(output.toByteArray(), StandardCharsets.UTF_8));
                    call.resolve(result);
                }
            } catch (Exception error) {
                call.reject("Could not load the saved value.", error);
            }
        });
    }

    @PluginMethod
    public void save(PluginCall call) {
        if (!requireLocalOrigin(call)) return;
        final String key = requireKeyOrReject(call);
        if (key == null) return;
        final String value = call.getString("value");
        if (value == null) {
            call.reject("A string value is required.");
            return;
        }
        final byte[] bytes = value.getBytes(StandardCharsets.UTF_8);
        if (bytes.length > MAX_VALUE_BYTES) {
            call.reject("Value exceeds the 64 MiB limit.");
            return;
        }
        executor.execute(() -> {
            AtomicFile file = null;
            FileOutputStream output = null;
            try {
                file = atomicFile(key);
                long reserveBytes = 64L * 1024 * 1024;
                if (file.getBaseFile().getParentFile().getUsableSpace() < bytes.length + reserveBytes) {
                    throw new IOException("Insufficient free space; at least 64 MiB is reserved.");
                }
                output = file.startWrite();
                output.write(bytes);
                file.finishWrite(output); // flushes/syncs before atomically committing
                call.resolve();
            } catch (Exception error) {
                if (file != null && output != null) file.failWrite(output);
                call.reject("Could not save the value.", error);
            }
        });
    }

    @PluginMethod
    public void remove(PluginCall call) {
        if (!requireLocalOrigin(call)) return;
        final String key = requireKeyOrReject(call);
        if (key == null) return;
        executor.execute(() -> {
            try {
                atomicFile(key).delete();
                call.resolve();
            } catch (Exception error) {
                call.reject("Could not remove the saved value.", error);
            }
        });
    }

    @PluginMethod
    public void flushCookies(PluginCall call) {
        if (!requireLocalOrigin(call)) return;
        executor.execute(() -> {
            try {
                CookieManager.getInstance().flush();
                call.resolve();
            } catch (Exception error) {
                call.reject("Could not flush WebView cookies.", error);
            }
        });
    }

    @PluginMethod
    public void setSessionActive(PluginCall call) {
        if (!requireLocalOrigin(call)) return;
        Boolean active = call.getBoolean("active");
        if (active == null) {
            call.reject("A boolean active value is required.");
            return;
        }
        try {
            synchronized (SESSION_STATE_LOCK) {
                android.content.SharedPreferences preferences = getContext().getSharedPreferences(
                    SESSION_PREFS, android.content.Context.MODE_PRIVATE);
                boolean wasActive = preferences.getBoolean(SESSION_ENABLED, false);
                long generation = preferences.getLong(SESSION_GENERATION, 0L);
                if (wasActive != active) generation++;
                if (!preferences.edit().putBoolean(SESSION_ENABLED, active)
                    .putLong(SESSION_GENERATION, generation).commit()) {
                    throw new IOException("Could not save background session state.");
                }

                WorkManager workManager = WorkManager.getInstance(getContext());
                if (active) {
                    Constraints constraints = new Constraints.Builder()
                        .setRequiredNetworkType(NetworkType.CONNECTED)
                        .build();
                    Data input = new Data.Builder()
                        .putLong(SESSION_GENERATION_INPUT, generation)
                        .build();
                    PeriodicWorkRequest request = new PeriodicWorkRequest.Builder(
                        StemmaSessionWorker.class, 1, TimeUnit.HOURS)
                        .setConstraints(constraints)
                        .setInputData(input)
                        .setBackoffCriteria(BackoffPolicy.EXPONENTIAL, 10, TimeUnit.MINUTES)
                        .build();
                    workManager.enqueueUniquePeriodicWork(
                        SESSION_WORK_NAME, ExistingPeriodicWorkPolicy.KEEP, request);
                } else {
                    workManager.cancelUniqueWork(SESSION_WORK_NAME);
                }
            }
            call.resolve();
        } catch (Exception error) {
            call.reject("Could not update background session renewal.", error);
        }
    }

    @Override
    protected void handleOnDestroy() {
        executor.shutdown();
        super.handleOnDestroy();
    }

    private boolean requireLocalOrigin(PluginCall call) {
        try {
            AtomicReference<String> currentUrl = new AtomicReference<>("");
            if (Looper.myLooper() == Looper.getMainLooper()) {
                currentUrl.set(getBridge().getWebView().getUrl());
            } else {
                CountDownLatch checked = new CountDownLatch(1);
                getActivity().runOnUiThread(() -> {
                    try { currentUrl.set(getBridge().getWebView().getUrl()); }
                    finally { checked.countDown(); }
                });
                if (!checked.await(5, TimeUnit.SECONDS)) throw new IOException("App origin check timed out.");
            }
            Uri uri = Uri.parse(currentUrl.get() == null ? "" : currentUrl.get());
            if ("https".equals(uri.getScheme()) && "localhost".equals(uri.getHost()) && uri.getPort() == -1) return true;
        } catch (Exception ignored) {
            // Reject below if the bridge URL is absent or malformed.
        }
        call.reject("Persistence is available only to the local Stemma app.");
        return false;
    }

    private String requireKeyOrReject(PluginCall call) {
        try {
            return requireKey(call);
        } catch (IOException error) {
            call.reject(error.getMessage());
            return null;
        }
    }

    private String requireKey(PluginCall call) throws IOException {
        String key = call.getString("key");
        if (key == null || !key.matches(KEY_PATTERN)) throw new IOException("Invalid persistence key.");
        return key;
    }

    private AtomicFile atomicFile(String key) throws IOException {
        File directory = new File(getContext().getNoBackupFilesDir(), "stemma-persistence-v1");
        if (!directory.isDirectory() && !directory.mkdirs()) throw new IOException("Private storage is unavailable.");
        return new AtomicFile(new File(directory, sha256(key) + ".kv"));
    }

    private static String sha256(String value) throws IOException {
        try {
            byte[] digest = MessageDigest.getInstance("SHA-256").digest(value.getBytes(StandardCharsets.UTF_8));
            StringBuilder hex = new StringBuilder(digest.length * 2);
            for (byte item : digest) hex.append(String.format(java.util.Locale.ROOT, "%02x", item & 0xff));
            return hex.toString();
        } catch (Exception error) {
            throw new IOException("Could not derive a storage filename.", error);
        }
    }
}
