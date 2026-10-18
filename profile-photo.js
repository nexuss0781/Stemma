/* Browser-only, device-local profile-photo persistence. Keep this as a classic script. */
(function installDeviceProfilePhotoStore(global) {
  'use strict';

  const DEFAULT_DATABASE_NAME = 'stemma-device-profile-photos';
  const STORE_NAME = 'photos';
  const MAX_PHOTO_BYTES = 10 * 1024 * 1024;
  const MAX_IMAGE_SIDE = 768;
  const ALLOWED_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp']);

  function validateAccountKey(accountKey) {
    if (typeof accountKey !== 'string' || accountKey.trim().length === 0) {
      throw new TypeError('A nonblank account key is required for profile photos.');
    }
  }

  function validatePhotoBlob(blob) {
    const BlobConstructor = global.Blob;
    if (typeof BlobConstructor !== 'function' || !(blob instanceof BlobConstructor)) {
      throw new TypeError('A profile photo must be a Blob.');
    }
    const type = String(blob.type || '').toLowerCase();
    if (!ALLOWED_TYPES.has(type)) {
      throw new TypeError('Profile photos must be PNG, JPEG, or WebP images.');
    }
    if (blob.size <= 0) {
      throw new TypeError('A profile photo cannot be empty.');
    }
    if (blob.size > MAX_PHOTO_BYTES) {
      throw new RangeError('A profile photo must not exceed 10 MiB.');
    }
    return blob;
  }

  function errorFromRequest(request, fallback) {
    return request && request.error ? request.error : new Error(fallback);
  }

  class DeviceProfilePhotoStore {
    constructor(options = {}) {
      this.indexedDB = Object.prototype.hasOwnProperty.call(options, 'indexedDB')
        ? options.indexedDB
        : global.indexedDB;
      this.databaseName = options.databaseName || DEFAULT_DATABASE_NAME;
    }

    async get(accountKey) {
      validateAccountKey(accountKey);
      const blob = await this._run('readonly', (store, resolveRequest) => {
        const request = store.get(accountKey);
        request.onsuccess = () => resolveRequest(request.result === undefined ? null : request.result);
        request.onerror = () => resolveRequest(undefined, errorFromRequest(request, 'Could not read the profile photo.'));
      });
      if (blob === null) return null;
      return validatePhotoBlob(blob);
    }

    async put(accountKey, blob) {
      validateAccountKey(accountKey);
      validatePhotoBlob(blob);
      await this._run('readwrite', (store, resolveRequest) => {
        const request = store.put(blob, accountKey);
        request.onsuccess = () => resolveRequest(undefined);
        request.onerror = () => resolveRequest(undefined, errorFromRequest(request, 'Could not write the profile photo.'));
      });
    }

    async remove(accountKey) {
      validateAccountKey(accountKey);
      await this._run('readwrite', (store, resolveRequest) => {
        const request = store.delete(accountKey);
        request.onsuccess = () => resolveRequest(undefined);
        request.onerror = () => resolveRequest(undefined, errorFromRequest(request, 'Could not remove the profile photo.'));
      });
    }

    async _openDatabase() {
      if (!this.indexedDB || typeof this.indexedDB.open !== 'function') {
        throw new Error('IndexedDB is unavailable; profile photos cannot be stored on this device.');
      }

      return new Promise((resolve, reject) => {
        let settled = false;
        let openedDatabase = null;
        let request;
        const fail = error => {
          if (settled) return;
          settled = true;
          if (openedDatabase) openedDatabase.close();
          reject(error && typeof error.message === 'string'
            ? error
            : new Error('Could not open profile-photo storage.'));
        };

        try {
          request = this.indexedDB.open(this.databaseName, 1);
        } catch (error) {
          fail(error);
          return;
        }

        request.onupgradeneeded = () => {
          const database = request.result;
          if (!database.objectStoreNames.contains(STORE_NAME)) database.createObjectStore(STORE_NAME);
        };
        request.onsuccess = () => {
          openedDatabase = request.result;
          openedDatabase.onversionchange = () => openedDatabase.close();
          if (settled) {
            openedDatabase.close();
            return;
          }
          settled = true;
          resolve(openedDatabase);
        };
        request.onerror = () => fail(errorFromRequest(request, 'Could not open profile-photo storage.'));
        request.onblocked = () => fail(new Error('Opening profile-photo storage was blocked by another connection.'));
      });
    }

    async _run(mode, performRequest) {
      const database = await this._openDatabase();
      try {
        if (!database.objectStoreNames.contains(STORE_NAME)) {
          throw new Error('Profile-photo storage is missing its photos object store.');
        }

        return await new Promise((resolve, reject) => {
          let requestFinished = false;
          let requestValue;
          let requestError = null;
          let transactionFinished = false;
          let settled = false;
          let transaction;
          const finish = (error, value) => {
            if (settled) return;
            settled = true;
            if (error) reject(error);
            else resolve(value);
          };
          const resolveRequest = (value, error = null) => {
            requestFinished = true;
            requestValue = value;
            requestError = error;
            if (error) finish(error);
            else if (transactionFinished) finish(null, requestValue);
          };

          try {
            transaction = database.transaction(STORE_NAME, mode);
            transaction.oncomplete = () => {
              transactionFinished = true;
              if (requestError) finish(requestError);
              else if (requestFinished) finish(null, requestValue);
            };
            transaction.onerror = () => finish(transaction.error || new Error('Profile-photo storage transaction failed.'));
            transaction.onabort = () => finish(transaction.error || new Error('Profile-photo storage transaction was aborted.'));
            const store = transaction.objectStore(STORE_NAME);
            performRequest(store, resolveRequest);
          } catch (error) {
            finish(error);
          }
        });
      } finally {
        database.close();
      }
    }

    static async prepare(image) {
      if (!image || typeof image !== 'object') {
        throw new TypeError('An already-decoded image element is required.');
      }
      const sourceWidth = Number(image.naturalWidth);
      const sourceHeight = Number(image.naturalHeight);
      if (!Number.isFinite(sourceWidth) || !Number.isFinite(sourceHeight) || sourceWidth <= 0 || sourceHeight <= 0) {
        throw new TypeError('The selected image has no usable dimensions.');
      }

      const scale = Math.min(1, MAX_IMAGE_SIDE / Math.max(sourceWidth, sourceHeight));
      const width = Math.max(1, Math.round(sourceWidth * scale));
      const height = Math.max(1, Math.round(sourceHeight * scale));
      const documentObject = global.document;
      if (!documentObject || typeof documentObject.createElement !== 'function') {
        throw new Error('Canvas image preparation is unavailable in this browser.');
      }

      const canvas = documentObject.createElement('canvas');
      canvas.width = width;
      canvas.height = height;
      const context = canvas.getContext('2d');
      if (!context || typeof context.drawImage !== 'function') {
        throw new Error('Canvas image preparation is unavailable in this browser.');
      }
      context.drawImage(image, 0, 0, width, height);

      const encode = (type, quality) => new Promise((resolve, reject) => {
        try {
          canvas.toBlob(blob => {
            if (!blob) reject(new Error('The browser could not encode the selected image.'));
            else resolve(blob);
          }, type, quality);
        } catch (error) {
          reject(error);
        }
      });

      const webpBlob = await encode('image/webp', 0.88);
      let preparedBlob;
      if (String(webpBlob.type || '').toLowerCase() === 'image/webp') {
        preparedBlob = webpBlob;
      } else if (String(webpBlob.type || '').toLowerCase() === 'image/png') {
        // Canvas silently returned PNG: this is the browser's WebP fallback.
        preparedBlob = webpBlob;
      } else {
        preparedBlob = await encode('image/png');
        if (String(preparedBlob.type || '').toLowerCase() !== 'image/png') {
          throw new Error('The browser did not produce a supported profile-photo format.');
        }
      }
      return validatePhotoBlob(preparedBlob);
    }
  }

  global.DeviceProfilePhotoStore = DeviceProfilePhotoStore;
})(globalThis);
