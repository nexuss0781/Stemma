package app.stemma.mobile;

import static org.junit.Assert.*;

import android.graphics.Bitmap;
import android.graphics.BitmapFactory;
import androidx.test.core.app.ActivityScenario;
import androidx.test.ext.junit.runners.AndroidJUnit4;
import androidx.test.platform.app.InstrumentationRegistry;
import com.getcapacitor.JSObject;
import com.getcapacitor.PluginCall;
import java.io.File;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.lang.reflect.Field;
import java.lang.reflect.InvocationTargetException;
import java.lang.reflect.Method;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicReference;
import org.junit.Test;
import org.junit.runner.RunWith;

/** Real framework-decoder and MediaExtractor coverage for native private media preparation helpers. */
@RunWith(AndroidJUnit4.class)
public final class MediaPreparationTest {
    private static final String ASSET_PREFIX = "media-";

    private static File copyAsset(String assetName) throws IOException {
        File file = new File(InstrumentationRegistry.getInstrumentation().getTargetContext().getCacheDir(),
                ASSET_PREFIX + assetName);
        try (InputStream in = InstrumentationRegistry.getInstrumentation().getContext().getAssets().open(ASSET_PREFIX + assetName);
             FileOutputStream out = new FileOutputStream(file)) {
            byte[] buffer = new byte[8192];
            int count;
            while ((count = in.read(buffer)) != -1) out.write(buffer, 0, count);
        }
        return file;
    }

    private static Object invokePrivate(Object target, String methodName, Class<?>[] parameterTypes, Object... args) throws Exception {
        Method method = target.getClass().getDeclaredMethod(methodName, parameterTypes);
        method.setAccessible(true);
        try {
            return method.invoke(target, args);
        } catch (InvocationTargetException wrapped) {
            Throwable cause = wrapped.getCause();
            if (cause instanceof Exception) throw (Exception) cause;
            if (cause instanceof Error) throw (Error) cause;
            throw wrapped;
        }
    }

    private static long videoDurationMs(Object trackInfo) throws Exception {
        Field field = trackInfo.getClass().getDeclaredField("durationMs");
        field.setAccessible(true);
        return field.getLong(trackInfo);
    }

    private static boolean hasAudio(Object trackInfo) throws Exception {
        Field field = trackInfo.getClass().getDeclaredField("hasAudio");
        field.setAccessible(true);
        return field.getBoolean(trackInfo);
    }

    @Test public void bmpAndAvifAreDecodedAndNormalizedToRealJpegs() throws Exception {
        StemmaMedia media = new StemmaMedia();
        for (String inputName : new String[] {"bmp.bmp", "avif.avif"}) {
            File input = copyAsset(inputName);
            File output = File.createTempFile("stemma-normalized-", ".jpg",
                    InstrumentationRegistry.getInstrumentation().getTargetContext().getCacheDir());
            try {
                invokePrivate(media, "normalizeImageToJpeg", new Class<?>[] {File.class, File.class}, input, output);
                assertTrue(inputName + " produced non-empty output", output.length() > 0L);
                byte[] signature = new byte[3];
                try (InputStream stream = new java.io.FileInputStream(output)) {
                    assertEquals(3, stream.read(signature));
                }
                assertArrayEquals("output has JPEG SOI marker", new byte[] {(byte) 0xff, (byte) 0xd8, (byte) 0xff}, signature);
                Bitmap decoded = BitmapFactory.decodeFile(output.getAbsolutePath());
                assertNotNull(inputName + " normalized JPEG decodes on device", decoded);
                try {
                    assertEquals(48, decoded.getWidth());
                    assertEquals(32, decoded.getHeight());
                } finally { decoded.recycle(); }
            } finally { input.delete(); output.delete(); }
        }
    }

    @Test public void exifRotationIsAppliedAndInvalidImageFails() throws Exception {
        StemmaMedia media = new StemmaMedia();
        File input = copyAsset("exif-rotate.jpg");
        File output = File.createTempFile("stemma-rotated-", ".jpg",
                InstrumentationRegistry.getInstrumentation().getTargetContext().getCacheDir());
        try {
            invokePrivate(media, "normalizeImageToJpeg", new Class<?>[] {File.class, File.class}, input, output);
            Bitmap decoded = BitmapFactory.decodeFile(output.getAbsolutePath());
            assertNotNull(decoded);
            try {
                assertEquals("EXIF orientation 6 rotates a 48x32 source clockwise", 32, decoded.getWidth());
                assertEquals(48, decoded.getHeight());
            } finally { decoded.recycle(); }

            File invalid = copyAsset("invalid.img");
            try {
                try {
                    invokePrivate(media, "normalizeImageToJpeg", new Class<?>[] {File.class, File.class}, invalid, output);
                    fail("invalid bytes must not be accepted as an image");
                } catch (IOException expected) {
                    assertTrue(expected.getMessage(), expected.getMessage().contains("cannot be decoded"));
                }
            } finally { invalid.delete(); }
        } finally { input.delete(); output.delete(); }
    }

    @Test public void nativeTrackValidationReadsMp4AndMkvAndRejectsOverLimitWithoutTrimming() throws Exception {
        StemmaMedia media = new StemmaMedia();
        File mp4 = copyAsset("audio.mp4");
        File mkv = copyAsset("audio.mkv");
        File tooLong = copyAsset("over-limit.mp4");
        try {
            Object mp4Info = invokePrivate(media, "validateVideoTracks", new Class<?>[] {File.class}, mp4);
            assertTrue("MP4 fixture has a readable 1-second video/audio duration", videoDurationMs(mp4Info) >= 900L && videoDurationMs(mp4Info) <= 1500L);
            assertTrue("MP4 fixture contains audio", hasAudio(mp4Info));

            Object mkvInfo = invokePrivate(media, "validateVideoTracks", new Class<?>[] {File.class}, mkv);
            assertTrue("MKV fixture has a readable 1-second video/audio duration", videoDurationMs(mkvInfo) >= 900L && videoDurationMs(mkvInfo) <= 1600L);
            assertTrue("MKV fixture contains audio", hasAudio(mkvInfo));

            try {
                invokePrivate(media, "validateVideoTracks", new Class<?>[] {File.class}, tooLong);
                fail("241-second input must be rejected, never silently trimmed");
            } catch (IOException expected) {
                assertTrue(expected.getMessage(), expected.getMessage().contains("no trimming was performed"));
                assertTrue("original over-limit fixture remains unchanged", tooLong.length() > 0L);
            }
        } finally { mp4.delete(); mkv.delete(); tooLong.delete(); }
    }

    @Test public void outputValidationRequiresAudioWhenInputHadAudio() throws Exception {
        StemmaMedia media = new StemmaMedia();
        File withAudio = copyAsset("audio.mp4");
        File silent = copyAsset("silent.mp4");
        try {
            invokePrivate(media, "validateOutputTrackDurations", new Class<?>[] {File.class, boolean.class}, withAudio, true);
            try {
                invokePrivate(media, "validateOutputTrackDurations", new Class<?>[] {File.class, boolean.class}, silent, true);
                fail("output lacking input audio must be rejected when audio is required");
            } catch (IOException expected) {
                assertTrue(expected.getMessage(), expected.getMessage().contains("did not retain the input audio track"));
            }
            invokePrivate(media, "validateOutputTrackDurations", new Class<?>[] {File.class, boolean.class}, silent, false);
        } finally { withAudio.delete(); silent.delete(); }
    }

    @Test public void attachedPluginCompletesRealAudioPreservingTransformerPreparation() throws Exception {
        ActivityScenario<MainActivity> scenario = ActivityScenario.launch(MainActivity.class);
        File copiedInput = copyAsset("audio.mp4");
        AtomicReference<StemmaMedia> pluginRef = new AtomicReference<>();
        try {
            long pluginDeadline = System.currentTimeMillis() + 60000L;
            while (System.currentTimeMillis() < pluginDeadline && pluginRef.get() == null) {
                scenario.onActivity(activity -> {
                    if (activity.getBridge() != null && activity.getBridge().getPlugin("StemmaMedia") != null) {
                        pluginRef.set((StemmaMedia) activity.getBridge().getPlugin("StemmaMedia").getInstance());
                    }
                });
                if (pluginRef.get() == null) Thread.sleep(250L);
            }
            final StemmaMedia media = pluginRef.get();
            assertNotNull("real registered StemmaMedia plugin is attached to the Activity bridge", media);

            CapturingPluginCall call = new CapturingPluginCall();
            assertTrue((Boolean) invokePrivate(media, "reservePreparation", new Class<?>[] {PluginCall.class}, call));
            invokePrivate(media, "prepareCopiedFile",
                    new Class<?>[] {PluginCall.class, File.class, String.class, String.class, String.class, String.class, long.class},
                    call, copiedInput, "instrumentation.mp4", "video/mp4", "likee", "androidTest", 0L);

            assertTrue("Transformer callback completed", call.done.await(120, TimeUnit.SECONDS));
            assertNull("Transformer pipeline resolves successfully: " + call.errorMessage, call.errorMessage);
            assertNotNull("resolved media metadata", call.result);
            assertEquals("video", call.result.getString("mediaType"));
            assertTrue("prepared output is an MP4", call.result.getString("path").endsWith(".mp4"));
            File output = new File(call.result.getString("path"));
            try {
                assertTrue("completed output exists and has bytes", output.isFile() && output.length() > 0L);
            } finally { output.delete(); }
        } finally {
            copiedInput.delete();
            scenario.close();
        }
    }

    private static final class CapturingPluginCall extends PluginCall {
        final CountDownLatch done = new CountDownLatch(1);
        volatile JSObject result;
        volatile String errorMessage;

        CapturingPluginCall() { super(null, "StemmaMedia", "android-test", "prepareCopiedFile", new JSObject()); }
        @Override public void resolve(JSObject data) { result = data; done.countDown(); }
        @Override public void resolve() { done.countDown(); }
        @Override public void reject(String message, String code, Exception exception, JSObject data) {
            errorMessage = message + " [" + code + "]";
            done.countDown();
        }
    }
}
