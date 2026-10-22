package app.stemma.mobile;

import android.content.Context;
import android.content.SharedPreferences;
import android.webkit.CookieManager;
import androidx.annotation.NonNull;
import androidx.work.Worker;
import androidx.work.WorkerParameters;
import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.util.List;
import java.util.Map;
import org.json.JSONObject;

/** Periodically renews an existing authenticated session; it never signs in or creates credentials. */
public final class StemmaSessionWorker extends Worker {
    private static final int MAX_RESPONSE_BYTES = 256 * 1024;
    private static final int MAX_RETRY_ATTEMPTS = 5;
    private static final String SESSION_URL = StemmaBackendClient.ORIGIN + "/auth/session";

    public StemmaSessionWorker(@NonNull Context context, @NonNull WorkerParameters parameters) {
        super(context, parameters);
    }

    @NonNull
    @Override
    public Result doWork() {
        final long generation = getInputData().getLong(StemmaPersistence.SESSION_GENERATION_INPUT, -1L);
        if (!isCurrentSession(generation)) return Result.success();

        HttpURLConnection connection = null;
        try {
            CookieManager cookies = CookieManager.getInstance();
            String cookieHeader = cookies.getCookie(StemmaBackendClient.ORIGIN);
            if (cookieHeader == null || cookieHeader.trim().isEmpty()) {
                deactivateIfCurrent(generation);
                return Result.success();
            }
            if (!isCurrentSession(generation)) return Result.success();

            connection = (HttpURLConnection) new URL(SESSION_URL).openConnection();
            connection.setRequestMethod("GET");
            connection.setConnectTimeout(10_000);
            connection.setReadTimeout(15_000);
            connection.setInstanceFollowRedirects(false);
            connection.setRequestProperty("Origin", StemmaBackendClient.ORIGIN);
            connection.setRequestProperty("Accept", "application/json");
            connection.setRequestProperty("Cookie", cookieHeader);

            int status = connection.getResponseCode();
            if (status == HttpURLConnection.HTTP_UNAUTHORIZED || status == HttpURLConnection.HTTP_FORBIDDEN) {
                deactivateIfCurrent(generation);
                return Result.success();
            }
            if (status >= 500 && status <= 599) return retryOrFinish();
            if (status < 200 || status >= 300) return Result.success();

            String body;
            try (InputStream input = connection.getInputStream()) {
                body = readLimited(input);
            }
            final boolean authenticated;
            try {
                authenticated = new JSONObject(body).optBoolean("authenticated", false);
            } catch (Exception invalidJson) {
                deactivateIfCurrent(generation);
                return Result.success();
            }
            if (!authenticated) {
                deactivateIfCurrent(generation);
                return Result.success();
            }

            synchronized (StemmaPersistence.SESSION_STATE_LOCK) {
                if (!isCurrentSessionLocked(generation)) return Result.success();
                for (Map.Entry<String, List<String>> header : connection.getHeaderFields().entrySet()) {
                    if (header.getKey() != null && "Set-Cookie".equalsIgnoreCase(header.getKey()) && header.getValue() != null) {
                        for (String value : header.getValue()) cookies.setCookie(StemmaBackendClient.ORIGIN, value);
                    }
                }
                // Persist the server's exact Set-Cookie values; expiry and logout semantics remain server-controlled.
                cookies.flush();
            }
            return Result.success();
        } catch (IOException networkError) {
            return retryOrFinish();
        } catch (RuntimeException workerError) {
            return retryOrFinish();
        } finally {
            if (connection != null) connection.disconnect();
        }
    }

    private String readLimited(InputStream input) throws IOException {
        ByteArrayOutputStream output = new ByteArrayOutputStream();
        byte[] buffer = new byte[8192];
        int count;
        while ((count = input.read(buffer)) != -1) {
            if (output.size() + count > MAX_RESPONSE_BYTES) throw new IOException("Session response too large.");
            output.write(buffer, 0, count);
        }
        return new String(output.toByteArray(), StandardCharsets.UTF_8);
    }

    private Result retryOrFinish() {
        return getRunAttemptCount() < MAX_RETRY_ATTEMPTS ? Result.retry() : Result.success();
    }

    private boolean isCurrentSession(long generation) {
        synchronized (StemmaPersistence.SESSION_STATE_LOCK) {
            return isCurrentSessionLocked(generation);
        }
    }

    private boolean isCurrentSessionLocked(long generation) {
        if (generation < 0) return false;
        SharedPreferences preferences = getApplicationContext().getSharedPreferences(
            StemmaPersistence.SESSION_PREFS, Context.MODE_PRIVATE);
        return preferences.getBoolean(StemmaPersistence.SESSION_ENABLED, false)
            && preferences.getLong(StemmaPersistence.SESSION_GENERATION, -1L) == generation;
    }

    private void deactivateIfCurrent(long generation) {
        synchronized (StemmaPersistence.SESSION_STATE_LOCK) {
            if (!isCurrentSessionLocked(generation)) return;
            SharedPreferences preferences = getApplicationContext().getSharedPreferences(
                StemmaPersistence.SESSION_PREFS, Context.MODE_PRIVATE);
            preferences.edit()
                .putBoolean(StemmaPersistence.SESSION_ENABLED, false)
                .putLong(StemmaPersistence.SESSION_GENERATION, generation + 1L)
                .commit();
            androidx.work.WorkManager.getInstance(getApplicationContext())
                .cancelUniqueWork(StemmaPersistence.SESSION_WORK_NAME);
        }
    }
}
