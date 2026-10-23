#!/usr/bin/env python3
"""Focused browser-level review test for the Android native picker bridge.

Run from any directory: python3 android-app/test-picker-review.py
Uses a synthetic StemmaNative.media bridge; no Android device or OS chooser is used.
"""
from pathlib import Path
from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parent.parent
PICKER = ROOT / "android-app" / "chat-attachments-ui.js"


def main():
    source = PICKER.read_text(encoding="utf-8")
    with sync_playwright() as p:
        browser = p.chromium.launch(
            executable_path="/opt/google/chrome/chrome",
            headless=True,
            args=["--no-sandbox", "--disable-dev-shm-usage"],
        )
        page = browser.new_page()
        page.set_content("<!doctype html><html><body><button id='open'>Open</button></body></html>")
        page.evaluate("""() => {
          let fileAccess = false;
          const root = '/shared';
          const tree = {
            [root]: [
              {id:'/shared/first.txt', path:'/shared/first.txt', name:'first.txt', size:5, mimeType:'text/plain'},
              {id:'/shared/folder', path:'/shared/folder', name:'folder', isDirectory:true, size:0, mimeType:'inode/directory'}
            ],
            ['/shared/folder']: [
              {id:'/shared/folder/second.pdf', path:'/shared/folder/second.pdf', name:'second.pdf', size:8, mimeType:'application/pdf'}
            ]
          };
          window.__bridgeCalls = {requestFileAccess:0, listFiles:[]};
          window.StemmaNative = {media: {
            getAccess: async () => ({status:'granted', mediaAccess:true, fileAccess}),
            requestAccess: async () => ({status:'granted', mediaAccess:true, fileAccess}),
            requestFileAccess: async () => {
              window.__bridgeCalls.requestFileAccess++;
              fileAccess = true;
              return {status:'granted', mediaAccess:true, fileAccess};
            },
            listAlbums: async () => ({albums:[]}),
            listMedia: async () => ({items:[], hasMore:false}),
            listFiles: async ({path, limit, offset}) => {
              const dir = path || root;
              window.__bridgeCalls.listFiles.push(dir);
              const all = tree[dir] || [];
              return {path:dir, parentPath:dir === root ? null : root, roots:[{name:'Shared storage',path:root}], items:all.slice(offset, offset+limit), hasMore:false};
            }
          }};
        }""")
        page.add_script_tag(content=source)
        page.evaluate("""() => {
          const button = document.querySelector('#open');
          window.StemmaChatAttachments.mount({querySelector: () => button}, {
            listen: (target, type, listener) => target.addEventListener(type, listener),
            ready: () => true,
            endpoint: () => '/attachments',
            signal: new AbortController().signal
          });
          button.click();
        }""")
        dialog = page.locator("dialog.native-picker")
        assert dialog.count() == 1, "picker should open with the synthetic native bridge"
        dialog.get_by_role("tab", name="Files").click()
        assert dialog.get_by_role("button", name="Grant Files access").is_visible(), "Files access must be requested only after an explicit tap"
        assert page.evaluate("window.__bridgeCalls.requestFileAccess") == 0, "opening Files must not trigger a permission/settings request"
        dialog.get_by_role("button", name="Grant Files access").click()
        first = dialog.locator(".native-file-row", has_text="first.txt")
        first.wait_for()
        first.click()
        assert dialog.locator("[data-count]").inner_text() == "1 selected"
        dialog.locator(".native-file-row", has_text="folder").click()
        dialog.locator(".native-file-row", has_text="second.pdf").wait_for()
        count_after_navigation = dialog.locator("[data-count]").inner_text()
        file_calls = page.evaluate("window.__bridgeCalls.listFiles")
        browser.close()
        assert count_after_navigation == "1 selected", (
            "selection should survive entering another directory; actual count was "
            f"{count_after_navigation!r} (native bridge calls: "
            f"{file_calls!r})"
        )


if __name__ == "__main__":
    main()
