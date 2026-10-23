package app.stemma.mobile;

import android.Manifest;
import android.app.Activity;
import android.content.ContentResolver;
import android.content.ContentUris;
import android.content.Context;
import android.content.Intent;
import android.content.ActivityNotFoundException;
import android.content.pm.PackageManager;
import android.database.Cursor;
import android.graphics.Bitmap;
import android.net.Uri;
import android.os.Build;
import android.os.Environment;
import android.provider.Settings;
import android.os.StatFs;
import android.provider.MediaStore;
import android.util.Size;

import androidx.annotation.NonNull;
import androidx.annotation.Nullable;
import androidx.core.content.ContextCompat;
import androidx.core.content.FileProvider;

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
import java.io.FileInputStream;
import java.io.IOException;
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
import java.util.LinkedHashMap;
import java.util.UUID;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

/**
 * Stemma's native media bridge. MediaStore handles the gallery; direct files are
 * accepted only under canonical, permission-authorized shared-storage roots.
 */
@CapacitorPlugin(
    name = "StemmaMedia",
    permissions = {
        @Permission(alias = "legacyMedia", strings = {"android.permission.READ_EXTERNAL_STORAGE"}),
        @Permission(alias = "mediaImages", strings = {"android.permission.READ_MEDIA_IMAGES"}),
        @Permission(alias = "mediaVideos", strings = {"android.permission.READ_MEDIA_VIDEO"}),
        @Permission(alias = "selectedMedia", strings = {"android.permission.READ_MEDIA_VISUAL_USER_SELECTED"}),
        @Permission(alias = "cameraPermission", strings = {"android.permission.CAMERA"})
    }
)
public class StemmaMedia extends Plugin {
    private static final int MAX_PAGE = 80;
    private static final int MAX_OFFSET = 100000;
    private static final long MAX_COPY_BYTES = 256L * 1024L * 1024L;
    // A bounded durable working set: keep imports useful across restarts without
    // allowing this private cache to consume the device's remaining storage.
    private static final long CACHE_BUDGET_BYTES = 2L * 1024L * 1024L * 1024L;
    private static final long DISK_RESERVE_BYTES = 128L * 1024L * 1024L;
    private static final long ACTIVE_COPY_MILLIS = 7L * 24L * 60L * 60L * 1000L;
    private static final int CACHE_MAX_FILES = 2048;
    private static final String PREFS = "stemma_media_recent_v1";
    private static final String RECENT_DOCS = "recent_documents";
    private final ExecutorService worker = Executors.newSingleThreadExecutor();
    @Nullable private File pendingCameraFile;

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

    /** Legacy compatibility endpoint: the native bridge intentionally has no OS document picker. */
    @PluginMethod
    public void selectFile(PluginCall call) {
        call.reject("System file picker is not supported; use permission-first storage browsing", "UNSUPPORTED");
    }

    @PluginMethod
    public void getAccess(PluginCall call) {
        call.resolve(accessStatus());
    }

    @PluginMethod
    public void requestFileAccess(PluginCall call) {
        if (hasFileAccess()) { call.resolve(accessStatus()); return; }
        if (Build.VERSION.SDK_INT >= 30) {
            try {
                Intent intent = new Intent(Settings.ACTION_MANAGE_APP_ALL_FILES_ACCESS_PERMISSION,
                    Uri.parse("package:" + getContext().getPackageName()));
                startActivityForResult(call, intent, "fileSettingsReturned");
            } catch (ActivityNotFoundException missingAppSettings) {
                try {
                    startActivityForResult(call, new Intent(Settings.ACTION_MANAGE_ALL_FILES_ACCESS_PERMISSION), "fileSettingsReturned");
                } catch (Exception e) {
                    call.reject("Storage access settings are unavailable", "FILE_ACCESS_UNAVAILABLE", e);
                }
            }
        } else if (Build.VERSION.SDK_INT >= 23) {
            requestPermissionForAliases(new String[] {"legacyMedia"}, call, "filePermissionResult");
        } else {
            call.resolve(accessStatus());
        }
    }

    @PermissionCallback
    public void filePermissionResult(PluginCall call) {
        if (call != null) call.resolve(accessStatus());
    }

    @ActivityCallback
    public void fileSettingsReturned(PluginCall call, ActivityResult result) {
        // Settings result codes do not indicate a grant; always re-check system state.
        if (call != null) call.resolve(accessStatus());
    }

    @PluginMethod
    public void listFiles(PluginCall call) {
        if (!hasFileAccess()) { call.reject("File access has not been granted", "PERMISSION_DENIED"); return; }
        final int limit = safeLimit(call);
        final int offset = safeOffset(call);
        final String requested = call.getString("path");
        worker.execute(() -> {
            try {
                List<FileRoot> roots = storageRoots();
                if (roots.isEmpty()) throw new IOException("No shared storage roots are available");
                File directory = requested == null || requested.trim().isEmpty() ? roots.get(0).path : resolveStoragePath(requested, roots);
                if (!directory.isDirectory() || !directory.canRead()) throw new IOException("Directory is not readable");
                File[] children = directory.listFiles();
                if (children == null) throw new IOException("Could not list directory");
                Comparator<File> orderFiles = (a, b) -> {
                    if (a.isDirectory() != b.isDirectory()) return a.isDirectory() ? -1 : 1;
                    int order = a.getName().compareToIgnoreCase(b.getName());
                    return order != 0 ? order : a.getName().compareTo(b.getName());
                };
                // Keep only the requested page plus one look-ahead item while scanning.
                int window = offset + limit + 1;
                java.util.PriorityQueue<File> pageCandidates = new java.util.PriorityQueue<>(Math.max(1, window), orderFiles.reversed());
                int visibleCount = 0;
                for (File child : children) {
                    try {
                        File canonical = child.getCanonicalFile();
                        if (!isWithinRoots(canonical, roots) || isProtectedStoragePath(canonical, roots)) continue;
                        if (!canonical.isDirectory() && !canonical.isFile()) continue;
                        visibleCount++;
                        if (pageCandidates.size() < window) pageCandidates.add(canonical);
                        else if (orderFiles.compare(canonical, pageCandidates.peek()) < 0) {
                            pageCandidates.poll();
                            pageCandidates.add(canonical);
                        }
                    } catch (IOException ignored) { /* broken links are omitted */ }
                }
                List<File> safe = new ArrayList<>(pageCandidates);
                Collections.sort(safe, orderFiles);
                JSArray items = new JSArray();
                int from = Math.min(offset, safe.size());
                int to = Math.min(safe.size(), from + limit);
                for (int i = from; i < to; i++) items.put(storageItem(safe.get(i)));
                JSArray rootJson = new JSArray();
                for (FileRoot root : roots) rootJson.put(new JSObject().put("name", root.name).put("path", root.path.getCanonicalPath()).put("source", "storage"));
                File parent = directory.getParentFile();
                String parentPath = parent != null && isWithinRoots(parent.getCanonicalFile(), roots) && !isProtectedStoragePath(parent, roots)
                    ? parent.getCanonicalPath() : null;
                call.resolve(new JSObject().put("items", items).put("path", directory.getCanonicalPath())
                    .put("parentPath", parentPath).put("roots", rootJson).put("hasMore", visibleCount > offset + limit));
            } catch (Exception e) {
                call.reject("Could not list storage directory", "STORAGE_LIST_FAILED", e);
            }
        });
    }

    @PluginMethod
    public void readStorageFile(PluginCall call) {
        final String requested = call.getString("path");
        if (requested == null || requested.trim().isEmpty()) { call.reject("path is required", "INVALID_ARGUMENT"); return; }
        if (!hasFileAccess()) { call.reject("File access has not been granted", "PERMISSION_DENIED"); return; }
        worker.execute(() -> {
            File destination = null;
            try {
                List<FileRoot> roots = storageRoots();
                File source = resolveStoragePath(requested, roots);
                if (!source.isFile() || !source.canRead() || isProtectedStoragePath(source, roots)) throw new IOException("File is unavailable");
                if (source.length() > MAX_COPY_BYTES) throw new IOException("File exceeds 256 MiB limit");
                File dir = mediaCacheDir();
                String suffix = safeExtension(source.getName());
                destination = new File(dir, "copy_" + UUID.randomUUID().toString().replace("-", "") + suffix);
                copyFileUnchanged(source, destination);
                String mime = mimeForName(source.getName());
                JSObject result = fileMetadata(destination, source.getName(), mime);
                result.put("source", "storage");
                result.put("dateAdded", source.lastModified() / 1000L);
                call.resolve(result);
            } catch (Exception e) {
                if (destination != null) //noinspection ResultOfMethodCallIgnored
                    destination.delete();
                call.reject("Could not copy storage file", "STORAGE_READ_FAILED", e);
            }
        });
    }

    @PluginMethod
    public void capturePhoto(PluginCall call) {
        if (!granted(Manifest.permission.CAMERA)) {
            requestPermissionForAliases(new String[] {"cameraPermission"}, call, "cameraPermissionResult");
            return;
        }
        launchCamera(call);
    }

    @PermissionCallback
    public void cameraPermissionResult(PluginCall call) {
        if (call == null) return;
        if (granted(Manifest.permission.CAMERA)) launchCamera(call);
        else call.reject("Camera permission was not granted", "PERMISSION_DENIED");
    }

    private void launchCamera(PluginCall call) {
        try {
            Intent intent = new Intent(android.provider.MediaStore.ACTION_IMAGE_CAPTURE);
            if (intent.resolveActivity(getContext().getPackageManager()) == null) throw new ActivityNotFoundException("No camera app is available");
            File dir = mediaCacheDir();
            trimCache(dir, 0L);
            File output = new File(dir, "copy_" + UUID.randomUUID().toString().replace("-", "") + ".jpg");
            pendingCameraFile = output;
            Uri outputUri = FileProvider.getUriForFile(getContext(), getContext().getPackageName() + ".fileprovider", output);
            intent.putExtra(android.provider.MediaStore.EXTRA_OUTPUT, outputUri);
            intent.addFlags(Intent.FLAG_GRANT_WRITE_URI_PERMISSION | Intent.FLAG_GRANT_READ_URI_PERMISSION);
            startActivityForResult(call, intent, "cameraCaptureReturned");
        } catch (Exception e) {
            pendingCameraFile = null;
            call.reject("Could not open the camera", "CAMERA_UNAVAILABLE", e);
        }
    }

    @ActivityCallback
    public void cameraCaptureReturned(PluginCall call, ActivityResult result) {
        File image = pendingCameraFile;
        pendingCameraFile = null;
        if (call == null) return;
        if (result == null || result.getResultCode() != Activity.RESULT_OK || image == null || !image.isFile() || image.length() == 0L) {
            if (image != null) //noinspection ResultOfMethodCallIgnored
                image.delete();
            call.resolve(new JSObject().put("cancelled", true));
            return;
        }
        try {
            if (image.length() > MAX_COPY_BYTES) throw new IOException("Captured photo exceeds 256 MiB limit");
            makeCacheRoom(image.getParentFile(), image, 0L);
            image.setLastModified(System.currentTimeMillis());
            call.resolve(fileMetadata(image, image.getName(), "image/jpeg").put("source", "camera")
                .put("dateAdded", System.currentTimeMillis() / 1000L));
        } catch (Exception e) {
            //noinspection ResultOfMethodCallIgnored
            image.delete();
            call.reject("Captured photo exceeds the private media cache limits", "CAMERA_CAPTURE_FAILED", e);
        }
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
                File copied = copyUriToPrivateCacheUnchanged(uri, name);
                JSObject metadata = fileMetadata(copied, name, mime);
                metadata.put("mediaType", video ? "video" : "image");
                if (video) metadata.put("durationMs", queryVideoDuration(uri));
                call.resolve(metadata);
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
        StringBuilder selectionBuilder = new StringBuilder(MediaStore.MediaColumns.MIME_TYPE + " LIKE ?");
        if (albumId != null) selectionBuilder.append(" AND ").append(MediaStore.Images.ImageColumns.BUCKET_ID).append("=?");
        String[] args = albumId == null ? new String[] {video ? "video/%" : "image/%"} : new String[] {video ? "video/%" : "image/%", albumId};
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
                item.put("durationMs", longValue(cursor, MediaStore.Video.VideoColumns.DURATION));
                output.add(item);
            }
        } catch (SecurityException ignored) {
            // Preserve accessible results from the other collection if this collection is unavailable.
        }
    }

    private void queryRecentMediaFiles(List<JSObject> output, int maxRows) {
        String[] projection = {MediaStore.MediaColumns._ID, MediaStore.MediaColumns.DISPLAY_NAME,
            MediaStore.MediaColumns.MIME_TYPE, MediaStore.MediaColumns.SIZE, MediaStore.MediaColumns.DATE_ADDED,
            MediaStore.Files.FileColumns.MEDIA_TYPE, MediaStore.Video.VideoColumns.DURATION};
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
                if (kind == MediaStore.Files.FileColumns.MEDIA_TYPE_VIDEO) { item.put("duration", longValue(cursor, MediaStore.Video.VideoColumns.DURATION)); item.put("durationMs", longValue(cursor, MediaStore.Video.VideoColumns.DURATION)); }
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

    private boolean hasFileAccess() {
        if (Build.VERSION.SDK_INT >= 30) return Environment.isExternalStorageManager();
        if (Build.VERSION.SDK_INT >= 23) return granted(Manifest.permission.READ_EXTERNAL_STORAGE);
        return true;
    }

    private List<FileRoot> storageRoots() throws IOException {
        LinkedHashMap<String, FileRoot> roots = new LinkedHashMap<>();
        File primary = Environment.getExternalStorageDirectory().getCanonicalFile();
        roots.put(primary.getPath(), new FileRoot("Shared storage", primary));
        File[] volumeFiles = getContext().getExternalFilesDirs(null);
        if (volumeFiles != null) for (File filesDir : volumeFiles) {
            if (filesDir == null) continue;
            String path = filesDir.getCanonicalPath();
            String marker = File.separator + "Android" + File.separator + "data" + File.separator + getContext().getPackageName() + File.separator + "files";
            int markerIndex = path.lastIndexOf(marker);
            if (markerIndex <= 0) continue;
            File volume = new File(path.substring(0, markerIndex)).getCanonicalFile();
            if (!volume.equals(primary) && volume.isDirectory()) roots.put(volume.getPath(), new FileRoot("Removable storage", volume));
        }
        return new ArrayList<>(roots.values());
    }

    private File resolveStoragePath(String path, List<FileRoot> roots) throws IOException {
        File candidate = new File(path);
        if (!candidate.isAbsolute()) throw new IOException("Only absolute shared-storage paths are accepted");
        File canonical = candidate.getCanonicalFile();
        if (!isWithinRoots(canonical, roots) || isProtectedStoragePath(canonical, roots)) throw new IOException("Path is outside approved storage roots");
        return canonical;
    }

    private boolean isWithinRoots(File file, List<FileRoot> roots) {
        try {
            String value = file.getCanonicalPath();
            for (FileRoot root : roots) {
                String base = root.path.getCanonicalPath();
                if (value.equals(base) || value.startsWith(base + File.separator)) return true;
            }
        } catch (IOException ignored) { }
        return false;
    }

    private boolean isProtectedStoragePath(File file, List<FileRoot> roots) {
        try {
            String value = file.getCanonicalPath();
            for (FileRoot root : roots) {
                String base = root.path.getCanonicalPath();
                if (value.equals(base)) return false;
                if (value.startsWith(base + File.separator)) {
                    String relative = value.substring(base.length() + 1);
                    String first = relative.split(java.util.regex.Pattern.quote(File.separator), 2)[0];
                    return "Android".equalsIgnoreCase(first);
                }
            }
        } catch (IOException ignored) { }
        return true;
    }

    private JSObject storageItem(File file) {
        boolean directory = file.isDirectory();
        String mime = directory ? "inode/directory" : mimeForName(file.getName());
        return new JSObject().put("id", file.getAbsolutePath()).put("path", file.getAbsolutePath())
            .put("name", file.getName()).put("isDirectory", directory).put("size", directory ? 0L : file.length())
            .put("mimeType", mime).put("source", "storage").put("dateAdded", file.lastModified() / 1000L);
    }

    private String mimeForName(String name) {
        int dot = name.lastIndexOf('.');
        if (dot > 0 && dot < name.length() - 1) {
            String mime = android.webkit.MimeTypeMap.getSingleton().getMimeTypeFromExtension(name.substring(dot + 1).toLowerCase(Locale.ROOT));
            if (mime != null) return mime;
        }
        return "application/octet-stream";
    }

    private String safeExtension(String name) {
        int dot = name.lastIndexOf('.');
        if (dot >= 0 && dot < name.length() - 1) {
            String ext = name.substring(dot + 1);
            if (ext.matches("[A-Za-z0-9]{1,8}")) return "." + ext.toLowerCase(Locale.ROOT);
        }
        return ".bin";
    }

    private void copyFileUnchanged(File source, File destination) throws IOException {
        File dir = destination.getParentFile();
        trimCache(dir, 0L);
        long copied = 0L;
        try (InputStream input = new FileInputStream(source); OutputStream output = new FileOutputStream(destination)) {
            byte[] buffer = new byte[32 * 1024];
            int count;
            while ((count = input.read(buffer)) != -1) {
                copied += count;
                if (copied > MAX_COPY_BYTES) throw new IOException("File exceeds 256 MiB limit");
                makeCacheRoom(dir, destination, count);
                output.write(buffer, 0, count);
            }
            output.flush();
            destination.setLastModified(System.currentTimeMillis());
        } catch (Exception e) {
            //noinspection ResultOfMethodCallIgnored
            destination.delete();
            if (e instanceof IOException) throw (IOException)e;
            throw new IOException("Copy failed", e);
        }
    }

    private File copyUriToPrivateCacheUnchanged(Uri uri, @Nullable String originalName) throws Exception {
        File dir = mediaCacheDir();
        String suffix = originalName == null ? extensionForMime(getContext().getContentResolver().getType(uri)) : safeExtension(originalName);
        File destination = new File(dir, "copy_" + UUID.randomUUID().toString().replace("-", "") + suffix);
        trimCache(dir, 0L);
        long copied = 0L;
        try (InputStream input = getContext().getContentResolver().openInputStream(uri); OutputStream output = new FileOutputStream(destination)) {
            if (input == null) throw new IOException("Media item cannot be opened");
            byte[] buffer = new byte[32 * 1024];
            int count;
            while ((count = input.read(buffer)) != -1) {
                copied += count;
                if (copied > MAX_COPY_BYTES) throw new IOException("File exceeds 256 MiB limit");
                makeCacheRoom(dir, destination, count);
                output.write(buffer, 0, count);
            }
            output.flush();
            destination.setLastModified(System.currentTimeMillis());
            return destination;
        } catch (Exception e) {
            //noinspection ResultOfMethodCallIgnored
            destination.delete();
            throw e;
        }
    }

    private long queryVideoDuration(Uri uri) {
        try (Cursor cursor = getContext().getContentResolver().query(uri, new String[] {MediaStore.Video.VideoColumns.DURATION}, null, null, null)) {
            if (cursor != null && cursor.moveToFirst()) return longValue(cursor, MediaStore.Video.VideoColumns.DURATION);
        } catch (Exception ignored) { }
        return 0L;
    }

    private static final class FileRoot {
        final String name;
        final File path;
        FileRoot(String name, File path) { this.name = name; this.path = path; }
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
        result.put("mediaAccess", accessible);
        result.put("fileAccess", hasFileAccess());
        result.put("cameraPermission", granted(Manifest.permission.CAMERA));
        result.put("granted", accessible);
        result.put("fullAccess", full);
        result.put("partial", accessible && !full);
        result.put("permissions", new JSObject()
            .put("images", Build.VERSION.SDK_INT >= 33 ? image : legacy)
            .put("videos", Build.VERSION.SDK_INT >= 33 ? video : legacy)
            .put("selectedMedia", selected)
            .put("legacy", legacy)
            .put("camera", granted(Manifest.permission.CAMERA))
            .put("files", hasFileAccess()));
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
        return granted("android.permission.READ_MEDIA_VIDEO")
            || (Build.VERSION.SDK_INT >= 34 && granted("android.permission.READ_MEDIA_VISUAL_USER_SELECTED"));
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
        return value.startsWith("image/") || value.startsWith("video/");
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
