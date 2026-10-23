#!/usr/bin/env python3
"""Source-level contract regression tests for the StemmaMedia native bridge."""
from pathlib import Path
import re
import xml.etree.ElementTree as ET

ROOT = Path(__file__).resolve().parents[2]
JAVA = (ROOT / "android-app/native-src/StemmaMedia.java").read_text()
MANIFEST = ET.parse(ROOT / "android-app/android/app/src/main/AndroidManifest.xml").getroot()
FILE_PATHS = ET.parse(ROOT / "android-app/android/app/src/main/res/xml/file_paths.xml").getroot()
ANDROID = "{http://schemas.android.com/apk/res/android}"


def method_body(name: str) -> str:
    match = re.search(r"public void " + re.escape(name) + r"\([^)]*\)\s*\{", JAVA)
    assert match, f"missing native API {name}"
    start = match.end()
    depth = 1
    for index in range(start, len(JAVA)):
        if JAVA[index] == "{":
            depth += 1
        elif JAVA[index] == "}":
            depth -= 1
            if depth == 0:
                return JAVA[start:index]
    raise AssertionError(f"unclosed method {name}")


def test_permission_first_storage_and_no_picker():
    assert "ACTION_OPEN_DOCUMENT" not in JAVA
    assert 'Settings.ACTION_MANAGE_APP_ALL_FILES_ACCESS_PERMISSION' in method_body("requestFileAccess")
    assert "Environment.isExternalStorageManager()" in JAVA
    assert "requestPermissionForAliases(new String[] {\"legacyMedia\"}" in method_body("requestFileAccess")
    assert 'call.reject("System file picker is not supported' in method_body("selectFile")
    assert all(method in JAVA for method in ("getAccess", "requestFileAccess", "listFiles", "readStorageFile"))


def test_file_listing_and_reads_are_confined_and_bounded():
    assert "safeLimit(call)" in method_body("listFiles")
    assert "pageCandidates" in method_body("listFiles")
    assert "isProtectedStoragePath" in method_body("listFiles")
    assert "getCanonicalFile()" in JAVA and "isWithinRoots" in JAVA
    assert '"Android".equalsIgnoreCase(first)' in JAVA
    assert "resolveStoragePath(requested, roots)" in method_body("readStorageFile")
    assert "MAX_COPY_BYTES" in JAVA and "copyFileUnchanged(source, destination)" in method_body("readStorageFile")
    assert "makeCacheRoom(dir, destination, count)" in JAVA
    assert "copyFileUnchanged(source, destination)" in method_body("readStorageFile")
    assert "normalizeImageToJpeg" not in JAVA


def test_camera_and_manifest_permissions():
    assert 'MediaStore.ACTION_IMAGE_CAPTURE' in JAVA
    assert 'MediaStore.EXTRA_OUTPUT' in JAVA
    assert 'getPackageName() + ".fileprovider"' in JAVA
    permissions = {p.get(ANDROID + "name") for p in MANIFEST.findall("uses-permission")}
    assert "android.permission.MANAGE_EXTERNAL_STORAGE" in permissions
    assert "android.permission.CAMERA" in permissions
    assert MANIFEST.find("application").get(ANDROID + "requestLegacyExternalStorage") == "true"
    assert any(path.tag.endswith("files-path") and path.get("path") == "stemma-media/" for path in FILE_PATHS)


def test_media_store_is_family_based_and_preserves_duration_metadata():
    assert 'return value.startsWith("image/") || value.startsWith("video/")' in JAVA
    assert 'MediaStore.MediaColumns.MIME_TYPE + " LIKE ?"' in JAVA
    assert "copyUriToPrivateCacheUnchanged(uri, name)" in method_body("readFile")
    assert "durationMs" in JAVA
    assert "ACTION_OPEN_DOCUMENT" not in JAVA


if __name__ == "__main__":
    tests = [test_permission_first_storage_and_no_picker, test_file_listing_and_reads_are_confined_and_bounded,
             test_camera_and_manifest_permissions, test_media_store_is_family_based_and_preserves_duration_metadata]
    for test in tests:
        test()
        print(f"PASS {test.__name__}")
