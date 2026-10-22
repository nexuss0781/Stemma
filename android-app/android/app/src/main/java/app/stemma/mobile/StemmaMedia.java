package app.stemma.mobile;

import android.Manifest;
import android.app.Activity;
import android.content.ContentResolver;
import android.content.ContentUris;
import android.content.Context;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.database.Cursor;
import android.graphics.Bitmap;
import android.graphics.BitmapFactory;
import android.graphics.ImageDecoder;
import android.net.Uri;
import android.os.Build;
import android.os.StatFs;
import android.provider.MediaStore;
import android.util.Size;

import androidx.annotation.NonNull;
import androidx.annotation.Nullable;
import androidx.core.content.ContextCompat;

import com.getcapacitor.Bridge;
import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.PermissionState;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.ActivityCallback;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.getcapacitor.annotation.Permission;
import com.getcapacitor.annotation.PermissionCallback;
import androidx.activity.result.ActivityResult;

import java.io.File;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.io.OutputStream;
import java.util.ArrayList;
import java.util.Collections;
import java.util.Comparator;
import java.util.Date;
import java.util.HashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.UUID;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

/**
 * Stemma's scoped media bridge. MediaStore and SAF are the only shared-storage
 * entry points; this plugin never reads a caller-supplied filesystem path.
 */
@CapacitorPlugin(
    name = "StemmaMedia",
    permissions = {
        @Permission(alias = "legacyMedia", strings = {"android.permission.READ_EXTERNAL_STORAGE"}),
        @Permission(alias = "mediaImages", strings = {"android.permission.READ_MEDIA_IMAGES"}),
        @Permission(alias = "mediaVideos", strings = {"android.permission.READ_MEDIA_VIDEO"}),
        @Permission(alias = "selectedMedia", strings = {"android.permission.READ_MEDIA_VISUAL_USER_SELECTED"})
    }
)
public class StemmaMedia extends Plugin {
    private static final int MAX_PAGE = 80;
    private static final int MAX_OFFSET = 100000;
    private static final long MAX_COPY_BYTES = 256L * 1024L * 1024L;
    private static final int MAX_DECODE_DIMENSION = 4096;
    // A bounded durable working set: keep imports useful across restarts without
    // allowing this private cache to consume the device's remaining storage.
    private static final long CACHE_BUDGET_BYTES = 2L * 1024L * 1024L * 1024L;
    private static final long DISK_RESERVE_BYTES = 128L * 1024L * 1024L;
    private static final long NORMALIZED_OUTPUT_RESERVE_BYTES = 64L * 1024L * 1024L;
    private static final long ACTIVE_COPY_MILLIS = 7L * 24L * 60L * 60L * 1000L;
    private static final int CACHE_MAX_FILES = 2048;
    private static final String PREFS = "stemma_media_recent_v1";
    private static final String RECENT_DOCS = "recent_documents";
    private final ExecutorService worker = Executors.newSingleThreadExecutor();

    private static final String[] BASE_COLUMNS = new String[] {
        MediaStore.MediaColumns._ID,
        MediaStore.MediaColumns.DISPLAY_NAME,
        MediaStore.MediaColumns.MIME_TYPE,
        MediaStore.MediaColumns.SIZE,
        MediaStore.MediaColumns.DATE_ADDED,
        MediaStore.Images.ImageColumns.BUCKET_ID,
        MediaStore.Images.ImageColumns.BUCKET_DISPLAY_NAME
    };

    @PluginMethod
    public void requestAccess(PluginCall call) {
        if (Build.VERSION.SDK_INT >= 34) {
            requestPermissionForAliases(new String[] {"mediaImages", "mediaVideos", "selectedMedia"}, call, "permissionResult");
        } else if (Build.VERSION.SDK_INT >= 33) {
            requestPermissionForAliases(new String[] {"mediaImages", "mediaVideos"}, call, "permissionResult");
        } else {
            requestPermissionForAliases(new String[] {"legacyMedia"}, call, "permissionResult");
        }
    }

    @PermissionCallback
    public void permissionResult(PluginCall call) {
        call.resolve(accessStatus());
    }

    @PluginMethod
    public void listAlbums(PluginCall call) {
        if (!hasMediaAccess()) {
            JSObject result = accessStatus();
            result.put("albums", new JSArray());
            call.resolve(result);
            return;
        }
        final String requestedType = normalizedMediaType(call.getString("mediaType", "images"));
        worker.execute(() -> {
            try {
                Map<String, Album> albums = new HashMap<>();
                if (("images".equals(requestedType) || "all".equals(requestedType)) && canReadImages()) {
                    queryAlbums(MediaStore.Images.Media.EXTERNAL_CONTENT_URI, albums);
                }
                if (("video".equals(requestedType) || "all".equals(requestedType)) && canReadVideos()) {
                    queryAlbums(MediaStore.Video.Media.EXTERNAL_CONTENT_URI, albums);
                }
                List<Album> values = new ArrayList<>(albums.values());
                Collections.sort(values, (a, b) -> {
                    int nameOrder = a.name.compareToIgnoreCase(b.name);
                    return nameOrder != 0 ? nameOrder : a.id.compareTo(b.id);
                });
                JSArray json = new JSArray();
                for (Album album : values) {
                    JSObject item = new JSObject();
                    item.put("id", album.id);
                    item.put("name", album.name);
                    item.put("count", album.count);
                    json.put(item);
                }
                JSObject result = accessStatus();
                result.put("albums", json);
                call.resolve(result);
            } catch (Exception e) {
                call.reject("Could not list media albums", "MEDIA_QUERY_FAILED", e);
            }
        });
    }

    @PluginMethod
    public void listMedia(PluginCall call) {
        final int limit = safeLimit(call);
        final int offset = safeOffset(call);
        final String requestedType = normalizedMediaType(call.getString("mediaType", "images"));
        final String albumId = validOptionalId(call.getString("albumId"));
        if (call.getString("albumId") != null && albumId == null) {
            call.reject("albumId must be a numeric MediaStore album id", "INVALID_ARGUMENT");
            return;
        }
        if (!hasMediaAccess()) {
            JSObject result = accessStatus();
            result.put("items", new JSArray());
            result.put("limit", limit);
            result.put("offset", offset);
            result.put("hasMore", false);
            call.resolve(result);
            return;
        }
        final int maxRows = offset + limit + 1;
        worker.execute(() -> {
            try {
                List<JSObject> found = new ArrayList<>();
                if (("images".equals(requestedType) || "all".equals(requestedType)) && canReadImages()) {
                    queryMediaItems(MediaStore.Images.Media.EXTERNAL_CONTENT_URI, false, albumId, found, maxRows);
                }
                if (("video".equals(requestedType) || "all".equals(requestedType)) && canReadVideos()) {
                    queryMediaItems(MediaStore.Video.Media.EXTERNAL_CONTENT_URI, true, albumId, found, maxRows);
                }
                Collections.sort(found, (a, b) -> {
                    long aDate = a.optLong("dateAdded", 0L);
                    long bDate = b.optLong("dateAdded", 0L);
                    int dateOrder = Long.compare(bDate, aDate);
                    return dateOrder != 0 ? dateOrder : b.optString("id").compareTo(a.optString("id"));
                });
                boolean hasMore = found.size() > offset + limit;
                JSArray items = new JSArray();
                int from = Math.min(offset, found.size());
                int to = Math.min(found.size(), offset + limit);
                for (int i = from; i < to; i++) items.put(found.get(i));
                JSObject result = accessStatus();
                result.put("items", items);
                result.put("limit", limit);
                result.put("offset", offset);
                result.put("hasMore", hasMore);
                call.resolve(result);
            } catch (Exception e) {
                call.reject("Could not list media", "MEDIA_QUERY_FAILED", e);
            }
        });
    }

    @PluginMethod
    public void thumbnail(PluginCall call) {
        Long id = parseId(call.getString("id"));
        if (id == null) {
            call.reject("id must be a positive numeric MediaStore id", "INVALID_ARGUMENT");
            return;
        }
        if (!hasMediaAccess()) {
            call.reject("Media access has not been granted", "PERMISSION_DENIED");
            return;
        }
        final boolean video = "video".equals(normalizedMediaType(call.getString("mediaType", "images")));
        worker.execute(() -> {
            Bitmap bitmap = null;
            try {
                File cache = mediaCacheDir();
                File output = new File(cache, "thumb_" + (video ? "v" : "i") + "_" + id + ".jpg");
                // Cached bytes never bypass current per-item / selected-photo access.
                Uri contentUri = findMediaUri(id, video, call.getString("mediaType", "images"));
                if (contentUri == null) throw new IllegalArgumentException("Media item is unavailable");
                // Reuse decoded thumbnails, while still validating the current grant.
                if (!output.isFile() || output.length() == 0L) {
                    trimCache(cache, 0L);
                    makeCacheRoom(cache, output, 2L * 1024L * 1024L);
                    if (Build.VERSION.SDK_INT >= 29) {
                        bitmap = getContext().getContentResolver().loadThumbnail(contentUri, new Size(640, 640), null);
                    } else {
                        long numericId = id;
                        bitmap = video
                            ? MediaStore.Video.Thumbnails.getThumbnail(getContext().getContentResolver(), numericId, MediaStore.Video.Thumbnails.MINI_KIND, null)
                            : MediaStore.Images.Thumbnails.getThumbnail(getContext().getContentResolver(), numericId, MediaStore.Images.Thumbnails.MINI_KIND, null);
                    }
                    if (bitmap == null) throw new IllegalStateException("No thumbnail is available");
                    try (FileOutputStream stream = new FileOutputStream(output)) {
                        bitmap.compress(Bitmap.CompressFormat.JPEG, 84, stream);
                    }
                }
                JSObject result = new JSObject();
                result.put("id", String.valueOf(id));
                output.setLastModified(System.currentTimeMillis());
                result.put("path", output.getAbsolutePath());
                result.put("webPath", localWebPath(output));
                result.put("mimeType", "image/jpeg");
                result.put("size", output.length());
                call.resolve(result);
            } catch (Exception e) {
                call.reject("Could not create media thumbnail", "THUMBNAIL_FAILED", e);
            } finally {
                if (bitmap != null && !bitmap.isRecycled()) bitmap.recycle();
            }
        });
    }

    /** Open a system document picker; only the selected URI is copied into app-private durable storage. */
    @PluginMethod
    public void selectFile(PluginCall call) {
        Intent intent = new Intent(Intent.ACTION_OPEN_DOCUMENT);
        intent.addCategory(Intent.CATEGORY_OPENABLE);
        intent.setType("*/*");
        intent.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION);
        startActivityForResult(call, intent, "documentPicked");
    }

    @ActivityCallback
    public void documentPicked(PluginCall call, ActivityResult result) {
        if (call == null) return;
        if (result == null || result.getResultCode() != Activity.RESULT_OK || result.getData() == null || result.getData().getData() == null) {
            call.resolve(new JSObject().put("cancelled", true));
            return;
        }
        final Uri selected = result.getData().getData();
        worker.execute(() -> {
            try {
                String mime = getContext().getContentResolver().getType(selected);
                if (mime == null) mime = "application/octet-stream";
                File copied = copyUriToPrivateCache(selected, null);
                String name = queryDisplayName(selected);
                if (requiresJpegNormalization(mime)) { mime = "image/jpeg"; name = jpegName(name); }
                if (name == null || name.trim().isEmpty()) name = copied.getName();
                JSObject entry = fileMetadata(copied, name, mime);
                entry.put("source", "document");
                entry.put("dateAdded", System.currentTimeMillis() / 1000L);
                addRecentDocument(entry);
                call.resolve(entry);
            } catch (Exception e) {
                call.reject("Could not copy the selected document", "DOCUMENT_READ_FAILED", e);
            }
        });
    }

    /** Copy an authorized MediaStore item into app-private durable storage. Never accepts file paths. */
    @PluginMethod
    public void readFile(PluginCall call) {
        Long id = parseId(call.getString("id"));
        if (id == null) {
            call.reject("id must be a positive numeric MediaStore id", "INVALID_ARGUMENT");
            return;
        }
        if (!hasMediaAccess()) {
            call.reject("Media access has not been granted", "PERMISSION_DENIED");
            return;
        }
        final long mediaId = id;
        final String type = normalizedMediaType(call.getString("mediaType", "all"));
        worker.execute(() -> {
            try {
                Uri uri = findMediaUri(mediaId, false, type);
                boolean video = false;
                if (uri == null) {
                    uri = findMediaUri(mediaId, true, type);
                    video = uri != null;
                }
                if (uri == null) throw new IllegalArgumentException("Media item is unavailable");
                String mime = getContext().getContentResolver().getType(uri);
                if (!isSupportedMime(mime)) throw new IllegalArgumentException("Unsupported media type");
                String name = queryDisplayName(uri);
                File copied = copyUriToPrivateCache(uri, name);
                if (requiresJpegNormalization(mime)) { mime = "image/jpeg"; name = jpegName(name); }
                call.resolve(fileMetadata(copied, name, mime));
            } catch (Exception e) {
                call.reject("Could not copy media item", "MEDIA_READ_FAILED", e);
            }
        });
    }

    /** Accessible shared media plus files selected through this plugin's SAF picker. */
    @PluginMethod
    public void recentFiles(PluginCall call) {
        final int limit = safeLimit(call);
        final int offset = safeOffset(call);
        worker.execute(() -> {
            try {
                List<JSObject> all = new ArrayList<>();
                if (hasMediaAccess()) queryRecentMediaFiles(all, limit + offset);
                all.addAll(readRecentDocuments());
                Collections.sort(all, (a, b) -> Long.compare(b.optLong("dateAdded", 0L), a.optLong("dateAdded", 0L)));
                JSArray page = new JSArray();
                int from = Math.min(offset, all.size());
                int to = Math.min(all.size(), from + limit);
                for (int i = from; i < to; i++) page.put(all.get(i));
                JSObject result = accessStatus();
                result.put("items", page);
                result.put("limit", limit);
                result.put("offset", offset);
                result.put("total", all.size());
                call.resolve(result);
            } catch (Exception e) {
                call.reject("Could not list recent files", "MEDIA_QUERY_FAILED", e);
            }
        });
    }

    private void queryAlbums(Uri collection, Map<String, Album> albums) {
        String[] projection = {MediaStore.MediaColumns._ID, MediaStore.Images.ImageColumns.BUCKET_ID,
            MediaStore.Images.ImageColumns.BUCKET_DISPLAY_NAME, MediaStore.MediaColumns.MIME_TYPE};
        try (Cursor cursor = getContext().getContentResolver().query(collection, projection, null, null,
            MediaStore.MediaColumns.DATE_ADDED + " DESC")) {
            if (cursor == null) return;
            int bucketCol = cursor.getColumnIndex(MediaStore.Images.ImageColumns.BUCKET_ID);
            int nameCol = cursor.getColumnIndex(MediaStore.Images.ImageColumns.BUCKET_DISPLAY_NAME);
            int mimeCol = cursor.getColumnIndex(MediaStore.MediaColumns.MIME_TYPE);
            while (cursor.moveToNext()) {
                String mime = mimeCol >= 0 ? cursor.getString(mimeCol) : null;
                if (!isSupportedMime(mime)) continue;
                String id = bucketCol >= 0 ? cursor.getString(bucketCol) : null;
                if (id == null) continue;
                String name = nameCol >= 0 ? cursor.getString(nameCol) : null;
                if (name == null || name.trim().isEmpty()) name = "Unknown album";
                Album album = albums.get(id);
                if (album == null) albums.put(id, new Album(id, name));
                else album.count++;
            }
        } catch (SecurityException ignored) {
            // A grant may have been revoked or restricted between permission check and provider query.
        }
    }

    private void queryMediaItems(Uri collection, boolean video, @Nullable String albumId, List<JSObject> output, int maxRows) {
        String[] projection = video
            ? new String[] {MediaStore.MediaColumns._ID, MediaStore.MediaColumns.DISPLAY_NAME, MediaStore.MediaColumns.MIME_TYPE,
                MediaStore.MediaColumns.SIZE, MediaStore.MediaColumns.DATE_ADDED, MediaStore.Images.ImageColumns.BUCKET_ID,
                MediaStore.Images.ImageColumns.BUCKET_DISPLAY_NAME, MediaStore.Video.VideoColumns.DURATION}
            : BASE_COLUMNS;
        StringBuilder selectionBuilder = new StringBuilder(MediaStore.MediaColumns.MIME_TYPE + " IN (?,?,?,?,?,?,?,?,?,?,?)");
        if (albumId != null) selectionBuilder.append(" AND ").append(MediaStore.Images.ImageColumns.BUCKET_ID).append("=?");
        String[] mimeArgs = {"image/jpeg", "image/png", "image/webp", "image/gif", "image/heic", "image/heif",
            "image/avif", "image/bmp", "video/mp4", "video/webm", "video/quicktime"};
        String[] args = albumId == null ? mimeArgs : new String[] {mimeArgs[0], mimeArgs[1], mimeArgs[2], mimeArgs[3], mimeArgs[4],
            mimeArgs[5], mimeArgs[6], mimeArgs[7], mimeArgs[8], mimeArgs[9], mimeArgs[10], albumId};
        try (Cursor cursor = getContext().getContentResolver().query(collection, projection, selectionBuilder.toString(), args,
            MediaStore.MediaColumns.DATE_ADDED + " DESC")) {
            if (cursor == null) return;
            int rows = 0;
            while (rows < maxRows && cursor.moveToNext()) {
                rows++;
                String mime = value(cursor, MediaStore.MediaColumns.MIME_TYPE);
                if (!isSupportedMime(mime) || (video != mime.startsWith("video/"))) continue;
                JSObject item = new JSObject();
                String id = value(cursor, MediaStore.MediaColumns._ID);
                item.put("id", id);
                item.put("name", value(cursor, MediaStore.MediaColumns.DISPLAY_NAME));
                item.put("mimeType", mime);
                item.put("size", longValue(cursor, MediaStore.MediaColumns.SIZE));
                item.put("dateAdded", longValue(cursor, MediaStore.MediaColumns.DATE_ADDED));
                item.put("albumId", value(cursor, MediaStore.Images.ImageColumns.BUCKET_ID));
                item.put("albumName", value(cursor, MediaStore.Images.ImageColumns.BUCKET_DISPLAY_NAME));
                item.put("mediaType", video ? "video" : "image");
                item.put("source", "mediaStore");
                if (video) item.put("duration", longValue(cursor, MediaStore.Video.VideoColumns.DURATION));
                output.add(item);
            }
        } catch (SecurityException ignored) {
            // Preserve accessible results from the other collection if this collection is unavailable.
        }
    }

    private void queryRecentMediaFiles(List<JSObject> output, int maxRows) {
        String[] projection = {MediaStore.MediaColumns._ID, MediaStore.MediaColumns.DISPLAY_NAME,
            MediaStore.MediaColumns.MIME_TYPE, MediaStore.MediaColumns.SIZE, MediaStore.MediaColumns.DATE_ADDED,
            MediaStore.Files.FileColumns.MEDIA_TYPE};
        String selection = MediaStore.Files.FileColumns.MEDIA_TYPE + " IN (?,?)";
        String[] args = {String.valueOf(MediaStore.Files.FileColumns.MEDIA_TYPE_IMAGE), String.valueOf(MediaStore.Files.FileColumns.MEDIA_TYPE_VIDEO)};
        Uri files = MediaStore.Files.getContentUri("external");
        try (Cursor cursor = getContext().getContentResolver().query(files, projection, selection, args,
            MediaStore.MediaColumns.DATE_ADDED + " DESC")) {
            if (cursor == null) return;
            while (cursor.moveToNext() && output.size() < maxRows) {
                String mime = value(cursor, MediaStore.MediaColumns.MIME_TYPE);
                if (!isSupportedMime(mime)) continue;
                int kind = (int) longValue(cursor, MediaStore.Files.FileColumns.MEDIA_TYPE);
                JSObject item = new JSObject();
                item.put("id", value(cursor, MediaStore.MediaColumns._ID));
                item.put("name", value(cursor, MediaStore.MediaColumns.DISPLAY_NAME));
                item.put("mimeType", mime);
                item.put("size", longValue(cursor, MediaStore.MediaColumns.SIZE));
                item.put("dateAdded", longValue(cursor, MediaStore.MediaColumns.DATE_ADDED));
                item.put("mediaType", kind == MediaStore.Files.FileColumns.MEDIA_TYPE_VIDEO ? "video" : "image");
                item.put("source", "mediaStore");
                output.add(item);
            }
        } catch (SecurityException ignored) {
            // Return only what the current OS grant exposes.
        }
    }

    @Nullable
    private Uri findMediaUri(long id, boolean video, String requestedType) {
        ContentResolver resolver = getContext().getContentResolver();
        if ((video && !canReadVideos()) || (!video && !canReadImages())) return null;
        if ("video".equals(requestedType) && !video) return null;
        if ("images".equals(requestedType) && video) return null;
        Uri base = video ? MediaStore.Video.Media.EXTERNAL_CONTENT_URI : MediaStore.Images.Media.EXTERNAL_CONTENT_URI;
        Uri uri = ContentUris.withAppendedId(base, id);
        String[] projection = {MediaStore.MediaColumns._ID, MediaStore.MediaColumns.MIME_TYPE};
        try (Cursor cursor = resolver.query(uri, projection, null, null, null)) {
            if (cursor != null && cursor.moveToFirst() && isSupportedMime(value(cursor, MediaStore.MediaColumns.MIME_TYPE))) return uri;
        } catch (SecurityException ignored) {
            return null;
        }
        return null;
    }

    private File copyUriToPrivateCache(Uri uri, @Nullable String originalName) throws Exception {
        File dir = mediaCacheDir();
        trimCache(dir, 0L);
        String suffix = extensionForMime(getContext().getContentResolver().getType(uri));
        File destination = new File(dir, "copy_" + UUID.randomUUID().toString().replace("-", "") + suffix);
        long copied = 0L;
        try (InputStream input = getContext().getContentResolver().openInputStream(uri);
             OutputStream output = new FileOutputStream(destination)) {
            if (input == null) throw new IllegalStateException("The selected content cannot be opened");
            byte[] buffer = new byte[32 * 1024];
            int count;
            while ((count = input.read(buffer)) != -1) {
                copied += count;
                if (copied > MAX_COPY_BYTES) throw new IllegalArgumentException("File exceeds 256 MiB limit");
                makeCacheRoom(dir, destination, count);
                output.write(buffer, 0, count);
            }
            output.flush();
        } catch (Exception e) {
            // Ensure an over-limit or failed partial copy is never exposed.
            //noinspection ResultOfMethodCallIgnored
            destination.delete();
            throw e;
        }
        // Keep just-imported content stable for active previews/uploads and restarts;
        // eviction policy protects copy_ files for seven days.
        destination.setLastModified(System.currentTimeMillis());
        String sourceMime = getContext().getContentResolver().getType(uri);
        if (requiresJpegNormalization(sourceMime)) {
            File converted = new File(dir, "copy_" + UUID.randomUUID().toString().replace("-", "") + ".jpg");
            try {
                makeCacheRoom(dir, converted, NORMALIZED_OUTPUT_RESERVE_BYTES);
                normalizeImageToJpeg(destination, converted);
                makeCacheRoom(dir, converted, 0L);
                converted.setLastModified(System.currentTimeMillis());
                //noinspection ResultOfMethodCallIgnored
                destination.delete();
                return converted;
            } catch (Exception e) {
                //noinspection ResultOfMethodCallIgnored
                destination.delete();
                //noinspection ResultOfMethodCallIgnored
                converted.delete();
                throw e;
            }
        }
        return destination;
    }

    private void normalizeImageToJpeg(File source, File destination) throws Exception {
        Bitmap bitmap;
        if (Build.VERSION.SDK_INT >= 28) {
            ImageDecoder.Source decoderSource = ImageDecoder.createSource(source);
            bitmap = ImageDecoder.decodeBitmap(decoderSource, (decoder, info, src) -> {
                int width = info.getSize().getWidth();
                int height = info.getSize().getHeight();
                float scale = Math.min(1f, (float) MAX_DECODE_DIMENSION / Math.max(width, height));
                if (scale < 1f) decoder.setTargetSize(Math.max(1, Math.round(width * scale)), Math.max(1, Math.round(height * scale)));
                decoder.setAllocator(ImageDecoder.ALLOCATOR_SOFTWARE);
            });
        } else {
            BitmapFactory.Options bounds = new BitmapFactory.Options();
            bounds.inJustDecodeBounds = true;
            BitmapFactory.decodeFile(source.getAbsolutePath(), bounds);
            if (bounds.outWidth <= 0 || bounds.outHeight <= 0) throw new IllegalArgumentException("Android cannot decode this image format");
            int sample = 1;
            while (Math.max(bounds.outWidth / sample, bounds.outHeight / sample) > MAX_DECODE_DIMENSION) sample *= 2;
            BitmapFactory.Options options = new BitmapFactory.Options();
            options.inSampleSize = sample;
            bitmap = BitmapFactory.decodeFile(source.getAbsolutePath(), options);
        }
        if (bitmap == null) throw new IllegalArgumentException("Android cannot decode this image format");
        try (FileOutputStream stream = new FileOutputStream(destination)) {
            if (!bitmap.compress(Bitmap.CompressFormat.JPEG, 90, stream)) throw new IllegalStateException("JPEG encoding failed");
            stream.flush();
        } finally {
            if (!bitmap.isRecycled()) bitmap.recycle();
        }
    }

    private static boolean requiresJpegNormalization(@Nullable String mime) {
        if (mime == null || !mime.toLowerCase(Locale.ROOT).startsWith("image/")) return false;
        String type = mime.toLowerCase(Locale.ROOT);
        return !("image/jpeg".equals(type) || "image/png".equals(type) || "image/webp".equals(type) || "image/gif".equals(type));
    }

    private static String jpegName(@Nullable String name) {
        String value = name == null || name.trim().isEmpty() ? "image" : name;
        int dot = value.lastIndexOf('.');
        if (dot > 0) value = value.substring(0, dot);
        return value + ".jpg";
    }

    private JSObject fileMetadata(File file, @Nullable String name, String mime) {
        JSObject result = new JSObject();
        result.put("path", file.getAbsolutePath());
        result.put("webPath", localWebPath(file));
        result.put("name", name == null || name.trim().isEmpty() ? file.getName() : name);
        result.put("mimeType", mime == null ? "application/octet-stream" : mime);
        result.put("size", file.length());
        return result;
    }

    private String localWebPath(File file) {
        // Same path mapping used by Capacitor.convertFileSrc(), backed by its local server.
        return bridge.getLocalUrl() + Bridge.CAPACITOR_FILE_START + Uri.encode(file.getAbsolutePath(), "/");
    }

    private void addRecentDocument(JSObject entry) throws Exception {
        android.content.SharedPreferences prefs = getContext().getSharedPreferences(PREFS, Context.MODE_PRIVATE);
        JSArray docs = new JSArray(prefs.getString(RECENT_DOCS, "[]"));
        JSArray next = new JSArray();
        next.put(entry);
        for (int i = 0; i < docs.length() && next.length() < 20; i++) {
            JSObject old = JSObject.fromJSONObject(docs.getJSONObject(i));
            if (old != null && isDurableMediaPath(new File(old.optString("path")))) next.put(old);
        }
        prefs.edit().putString(RECENT_DOCS, next.toString()).apply();
    }

    private List<JSObject> readRecentDocuments() throws Exception {
        List<JSObject> result = new ArrayList<>();
        mediaCacheDir(); // Also lazily migrate legacy cache entries and their saved paths.
        android.content.SharedPreferences prefs = getContext().getSharedPreferences(PREFS, Context.MODE_PRIVATE);
        JSArray docs = new JSArray(prefs.getString(RECENT_DOCS, "[]"));
        for (int i = 0; i < docs.length(); i++) {
            JSObject item = JSObject.fromJSONObject(docs.getJSONObject(i));
            if (item == null) continue;
            File path = new File(item.optString("path"));
            // Only imported files under this app's durable media directory are returned.
            if (isDurableMediaPath(path)) result.add(item);
        }
        return result;
    }

    @Nullable
    private String queryDisplayName(Uri uri) {
        try (Cursor cursor = getContext().getContentResolver().query(uri,
            new String[] {MediaStore.MediaColumns.DISPLAY_NAME}, null, null, null)) {
            if (cursor != null && cursor.moveToFirst()) return value(cursor, MediaStore.MediaColumns.DISPLAY_NAME);
        } catch (Exception ignored) { }
        return null;
    }

    private File mediaCacheDir() {
        File dir = new File(getContext().getFilesDir(), "stemma-media");
        if (!dir.exists()) dir.mkdirs();
        migrateLegacyMediaFiles(dir);
        return dir;
    }

    /** Migrate only direct files emitted by the old plugin cache; never follow arbitrary paths. */
    private void migrateLegacyMediaFiles(File durableDirectory) {
        File legacyDirectory = new File(getContext().getCacheDir(), "stemma-media");
        File[] legacyFiles = legacyDirectory.listFiles();
        if (legacyFiles == null || !durableDirectory.isDirectory()) return;
        Map<String, String> migratedPaths = new HashMap<>();
        try {
            String legacyRoot = legacyDirectory.getCanonicalPath() + File.separator;
            String durableRoot = durableDirectory.getCanonicalPath() + File.separator;
            for (File source : legacyFiles) {
                if (!source.isFile() || !isKnownMediaCacheName(source.getName())
                    || !source.getCanonicalPath().startsWith(legacyRoot)) continue;
                File destination = new File(durableDirectory, source.getName());
                if (!destination.isFile() && !source.renameTo(destination)) {
                    try (InputStream input = new java.io.FileInputStream(source);
                         OutputStream output = new FileOutputStream(destination)) {
                        byte[] buffer = new byte[32 * 1024];
                        int count;
                        while ((count = input.read(buffer)) != -1) output.write(buffer, 0, count);
                        output.flush();
                    } catch (Exception copyFailure) {
                        // Keep the original intact; migration can retry on a later call.
                        //noinspection ResultOfMethodCallIgnored
                        destination.delete();
                        continue;
                    }
                    //noinspection ResultOfMethodCallIgnored
                    source.delete();
                } else if (destination.isFile()) {
                    //noinspection ResultOfMethodCallIgnored
                    source.delete();
                }
                if (destination.isFile() && destination.getCanonicalPath().startsWith(durableRoot)) {
                    migratedPaths.put(source.getAbsolutePath(), destination.getAbsolutePath());
                    migratedPaths.put(source.getCanonicalPath(), destination.getCanonicalPath());
                }
            }
        } catch (Exception ignored) {
            // A failed migration must not make current imports unusable.
        }
        if (!migratedPaths.isEmpty()) migrateRecentDocumentPaths(migratedPaths);
    }

    private boolean isKnownMediaCacheName(String name) {
        return name.matches("thumb_[iv]_[0-9]+\\.jpg")
            || name.matches("copy_[0-9a-fA-F]{32}\\.[A-Za-z0-9]{1,8}");
    }

    private void migrateRecentDocumentPaths(Map<String, String> migratedPaths) {
        try {
            android.content.SharedPreferences prefs = getContext().getSharedPreferences(PREFS, Context.MODE_PRIVATE);
            JSArray docs = new JSArray(prefs.getString(RECENT_DOCS, "[]"));
            JSArray updated = new JSArray();
            boolean changed = false;
            for (int i = 0; i < docs.length(); i++) {
                JSObject item = JSObject.fromJSONObject(docs.getJSONObject(i));
                if (item == null) continue;
                String path = item.optString("path");
                String replacement = migratedPaths.get(path);
                if (replacement != null) {
                    item.put("path", replacement);
                    changed = true;
                }
                updated.put(item);
            }
            if (changed) prefs.edit().putString(RECENT_DOCS, updated.toString()).apply();
        } catch (Exception ignored) { }
    }

    private boolean isDurableMediaPath(File file) {
        try {
            String root = new File(getContext().getFilesDir(), "stemma-media").getCanonicalPath() + File.separator;
            return file.isFile() && file.getCanonicalPath().startsWith(root);
        } catch (Exception ignored) {
            return false;
        }
    }

    private void trimCache(File directory, long additionalBytes) {
        File[] files = directory.listFiles();
        if (files == null) return;
        List<File> entries = new ArrayList<>();
        long total = 0L;
        for (File file : files) if (file.isFile()) { entries.add(file); total += file.length(); }
        Collections.sort(entries, Comparator.comparingLong(File::lastModified));
        int remaining = entries.size();
        long available = availableBytes(directory);
        for (File file : entries) {
            if (remaining <= CACHE_MAX_FILES && total + additionalBytes <= CACHE_BUDGET_BYTES
                && available >= DISK_RESERVE_BYTES + additionalBytes) break;
            if (!isEvictable(file, System.currentTimeMillis())) continue;
            long length = file.length();
            if (file.delete()) { total -= length; remaining--; available += length; }
        }
    }

    private void makeCacheRoom(File directory, File protectedFile, long additionalBytes) throws java.io.IOException {
        File[] files = directory.listFiles();
        if (files == null) throw new java.io.IOException("Private media storage is unavailable");
        List<File> entries = new ArrayList<>();
        long total = 0L;
        int count = 0;
        for (File file : files) {
            if (file.isFile()) {
                total += file.length();
                count++;
                if (!file.equals(protectedFile)) entries.add(file);
            }
        }
        Collections.sort(entries, Comparator.comparingLong(File::lastModified));
        long available = availableBytes(directory);
        for (File candidate : entries) {
            if (total + additionalBytes <= CACHE_BUDGET_BYTES && count <= CACHE_MAX_FILES
                && available >= DISK_RESERVE_BYTES + additionalBytes) return;
            if (!isEvictable(candidate, System.currentTimeMillis())) continue;
            long length = candidate.length();
            if (candidate.delete()) { total -= length; count--; available += length; }
        }
        if (total + additionalBytes > CACHE_BUDGET_BYTES || count > CACHE_MAX_FILES
            || available < DISK_RESERVE_BYTES + additionalBytes) {
            throw new java.io.IOException("Insufficient private storage; active imports are preserved");
        }
    }

    private long availableBytes(File directory) {
        try { return new StatFs(directory.getAbsolutePath()).getAvailableBytes(); }
        catch (Exception ignored) { return 0L; }
    }

    private boolean isEvictable(File file, long now) {
        return !file.getName().startsWith("copy_") || now - file.lastModified() >= ACTIVE_COPY_MILLIS;
    }

    private JSObject accessStatus() {
        boolean image = granted("android.permission.READ_MEDIA_IMAGES");
        boolean video = granted("android.permission.READ_MEDIA_VIDEO");
        boolean selected = Build.VERSION.SDK_INT >= 34 && granted("android.permission.READ_MEDIA_VISUAL_USER_SELECTED");
        boolean legacy = Build.VERSION.SDK_INT <= 32 && granted("android.permission.READ_EXTERNAL_STORAGE");
        boolean full = Build.VERSION.SDK_INT >= 33 ? image && video : legacy;
        boolean accessible = Build.VERSION.SDK_INT >= 33 ? image || video || selected : legacy;
        String status = full ? "granted" : (accessible ? "partial" : "denied");
        JSObject result = new JSObject();
        result.put("status", status);
        result.put("granted", accessible);
        result.put("fullAccess", full);
        result.put("partial", accessible && !full);
        result.put("permissions", new JSObject()
            .put("images", Build.VERSION.SDK_INT >= 33 ? image : legacy)
            .put("videos", Build.VERSION.SDK_INT >= 33 ? video : legacy)
            .put("selectedMedia", selected)
            .put("legacy", legacy));
        return result;
    }

    private boolean hasMediaAccess() { return canReadImages() || canReadVideos(); }

    private boolean canReadImages() {
        if (Build.VERSION.SDK_INT <= 32) return granted("android.permission.READ_EXTERNAL_STORAGE");
        return granted("android.permission.READ_MEDIA_IMAGES")
            || (Build.VERSION.SDK_INT >= 34 && granted("android.permission.READ_MEDIA_VISUAL_USER_SELECTED"));
    }

    private boolean canReadVideos() {
        if (Build.VERSION.SDK_INT <= 32) return granted("android.permission.READ_EXTERNAL_STORAGE");
        return granted("android.permission.READ_MEDIA_VIDEO");
    }

    private boolean granted(String permission) {
        if (Build.VERSION.SDK_INT < permissionApi(permission)) return false;
        return ContextCompat.checkSelfPermission(getContext(), permission) == PackageManager.PERMISSION_GRANTED;
    }

    private int permissionApi(String permission) {
        if (permission.endsWith("READ_MEDIA_IMAGES") || permission.endsWith("READ_MEDIA_VIDEO")) return 33;
        if (permission.endsWith("READ_MEDIA_VISUAL_USER_SELECTED")) return 34;
        return 1;
    }

    private int safeLimit(PluginCall call) {
        Integer value = call.getInt("limit", MAX_PAGE);
        return Math.max(1, Math.min(MAX_PAGE, value == null ? MAX_PAGE : value));
    }

    private int safeOffset(PluginCall call) {
        Integer value = call.getInt("offset", 0);
        return Math.max(0, Math.min(MAX_OFFSET, value == null ? 0 : value));
    }

    private String normalizedMediaType(@Nullable String value) {
        String type = value == null ? "images" : value.toLowerCase(Locale.ROOT);
        return "all".equals(type) || "video".equals(type) ? type : "images";
    }

    @Nullable
    private static String validOptionalId(@Nullable String value) {
        if (value == null || value.isEmpty() || !value.matches("-?[0-9]{1,19}")) return null;
        try {
            Long.parseLong(value); // Bucket IDs are signed hashes and may be negative or zero.
            return value;
        } catch (NumberFormatException ignored) {
            return null;
        }
    }

    @Nullable
    private static Long parseId(@Nullable String value) {
        if (value == null || !value.matches("[0-9]{1,19}")) return null;
        try { long id = Long.parseLong(value); return id > 0 ? id : null; }
        catch (NumberFormatException ignored) { return null; }
    }

    @Nullable
    private static String value(Cursor cursor, String column) {
        int index = cursor.getColumnIndex(column);
        return index < 0 || cursor.isNull(index) ? null : cursor.getString(index);
    }

    private static long longValue(Cursor cursor, String column) {
        int index = cursor.getColumnIndex(column);
        return index < 0 || cursor.isNull(index) ? 0L : cursor.getLong(index);
    }

    private boolean isSupportedMime(@Nullable String mime) {
        if (mime == null) return false;
        String value = mime.toLowerCase(Locale.ROOT);
        return "image/jpeg".equals(value) || "image/png".equals(value) || "image/webp".equals(value)
            || "image/gif".equals(value) || "image/heic".equals(value) || "image/heif".equals(value)
            || "image/avif".equals(value) || "image/bmp".equals(value)
            || "video/mp4".equals(value) || "video/webm".equals(value) || "video/quicktime".equals(value);
    }

    private String extensionForMime(@Nullable String mime) {
        if (mime == null) return ".bin";
        String extension = android.webkit.MimeTypeMap.getSingleton().getExtensionFromMimeType(mime);
        if (extension != null && extension.matches("[A-Za-z0-9]{1,8}")) return "." + extension;
        if (mime.startsWith("image/")) return ".img";
        if (mime.startsWith("video/")) return ".vid";
        return ".bin";
    }

    private static final class Album {
        final String id;
        final String name;
        int count = 1;
        Album(String id, String name) { this.id = id; this.name = name; }
    }
}
