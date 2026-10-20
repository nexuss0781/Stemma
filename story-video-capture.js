(function (root) {
  'use strict';

  const audioByPlayer = new WeakMap();
  const MAX_SIDE = 1280;
  const AUDIO_ERROR = 'Audio capture is unavailable in this browser. Try another browser; the original video was not uploaded.';
  const VIDEO_ERROR = 'This browser could not capture the video. Try another browser; the original video was not uploaded.';

  function stopTracks(stream) {
    if (!stream || typeof stream.getTracks !== 'function') return;
    stream.getTracks().forEach(track => {
      try { track.stop(); } catch (_) { /* Best-effort teardown. */ }
    });
  }

  function audioContextFor(player) {
    let entry = audioByPlayer.get(player);
    if (entry) return entry;

    const AudioContext = root.AudioContext || root.webkitAudioContext;
    if (!AudioContext) throw new Error(AUDIO_ERROR);

    let context;
    try {
      context = new AudioContext();
      const source = context.createMediaElementSource(player);
      const destination = context.createMediaStreamDestination();
      source.connect(destination);
      source.connect(context.destination);
      entry = { context, source, destination, ready: null };
      audioByPlayer.set(player, entry);
      entry.ready = Promise.resolve().then(() => {
        if (context.state === 'closed') throw new Error(AUDIO_ERROR);
        return context.state === 'suspended' && typeof context.resume === 'function'
          ? context.resume()
          : undefined;
      }).catch(() => { throw new Error(AUDIO_ERROR); });
      return entry;
    } catch (_) {
      // Once createMediaElementSource succeeds, browsers do not allow creating a
      // second source for that element. Keep a cache entry for recoverable setup
      // failures when possible; otherwise report that audio could not be retained.
      if (context && !audioByPlayer.has(player)) {
        audioByPlayer.set(player, { context, source: null, destination: null, ready: Promise.reject(new Error(AUDIO_ERROR)) });
        audioByPlayer.get(player).ready.catch(() => {});
      }
      throw new Error(AUDIO_ERROR);
    }
  }

  async function addAudioTrack(player, stream) {
    const entry = audioContextFor(player);
    await entry.ready;
    const audioTrack = entry.destination?.stream?.getAudioTracks?.()[0];
    if (!audioTrack || typeof audioTrack.clone !== 'function' || typeof stream.addTrack !== 'function') {
      throw new Error(AUDIO_ERROR);
    }
    stream.addTrack(audioTrack.clone());
  }

  function dimensionsFor(player) {
    const width = Number(player.videoWidth || 0);
    const height = Number(player.videoHeight || 0);
    if (!(width > 0 && height > 0)) throw new Error('The video is not ready to capture yet. Try again after it has loaded.');
    const scale = Math.min(1, MAX_SIDE / Math.max(width, height));
    return { width: Math.max(1, Math.round(width * scale)), height: Math.max(1, Math.round(height * scale)) };
  }

  async function captureCanvas(player) {
    if (typeof root.document?.createElement !== 'function') throw new Error(VIDEO_ERROR);
    const raf = root.requestAnimationFrame;
    const cancelRaf = root.cancelAnimationFrame;
    if (typeof raf !== 'function' || typeof cancelRaf !== 'function') throw new Error(VIDEO_ERROR);

    const size = dimensionsFor(player);
    const canvas = root.document.createElement('canvas');
    canvas.width = size.width;
    canvas.height = size.height;
    const context = canvas.getContext?.('2d');
    if (!context || typeof context.drawImage !== 'function' || typeof canvas.captureStream !== 'function') {
      throw new Error(VIDEO_ERROR);
    }
    if (Number(player.readyState) < 2) {
      throw new Error('The video has no decoded frame to capture yet. Try again after it has loaded.');
    }

    let stream = null;
    let frame = 0;
    let closed = false;
    const draw = () => {
      if (closed) return;
      try {
        context.drawImage(player, 0, 0, size.width, size.height);
      } catch (_) {
        closed = true;
        if (frame) cancelRaf(frame);
        stopTracks(stream);
        return;
      }
      frame = raf(draw);
    };

    try {
      // Draw a decoded frame before captureStream so encoders do not begin with
      // a blank canvas frame. Local object-URL videos remain same-origin.
      context.drawImage(player, 0, 0, size.width, size.height);
      stream = canvas.captureStream(30);
      if (!stream || !stream.getVideoTracks?.().length) throw new Error(VIDEO_ERROR);
      await addAudioTrack(player, stream);
      frame = raf(draw);
    } catch (error) {
      closed = true;
      if (frame) cancelRaf(frame);
      stopTracks(stream);
      if (error?.message === AUDIO_ERROR || error?.message === VIDEO_ERROR || error?.message?.includes('decoded frame') || error?.message?.includes('not ready')) throw error;
      throw new Error(VIDEO_ERROR);
    }

    let cleaned = false;
    return {
      stream,
      cleanup() {
        if (cleaned) return;
        cleaned = true;
        closed = true;
        if (frame) cancelRaf(frame);
        stopTracks(stream);
      }
    };
  }

  async function capture(player) {
    if (!player || (typeof player !== 'object' && typeof player !== 'function')) {
      throw new TypeError('A video player element is required.');
    }

    const nativeCapture = player.captureStream || player.mozCaptureStream;
    if (typeof nativeCapture === 'function') {
      let nativeStream = null;
      try { nativeStream = nativeCapture.call(player); } catch (_) { /* Fall back to canvas. */ }
      const videoTracks = nativeStream?.getVideoTracks?.() || [];
      const audioTracks = nativeStream?.getAudioTracks?.() || [];
      const knownSourceAudio = player.audioTracks && Number(player.audioTracks.length) > 0;
      if (videoTracks.length && !(knownSourceAudio && !audioTracks.length)) {
        try {
          // Native capture usually includes media audio. When it does not, route
          // through Web Audio rather than silently producing a silent trim.
          if (!audioTracks.length) await addAudioTrack(player, nativeStream);
          let cleaned = false;
          return {
            stream: nativeStream,
            cleanup() {
              if (cleaned) return;
              cleaned = true;
              stopTracks(nativeStream);
            }
          };
        } catch (_) {
          // If native stream lacks required audio, retry through canvas below.
        }
      }
      stopTracks(nativeStream);
    }

    return captureCanvas(player);
  }

  function release(player) {
    const entry = player && audioByPlayer.get(player);
    if (!entry) return Promise.resolve();
    audioByPlayer.delete(player);
    try {
      return Promise.resolve(entry.context?.close?.()).catch(() => {});
    } catch (_) {
      return Promise.resolve();
    }
  }

  root.StemmaStoryVideoCapture = Object.freeze({ capture, release });
})(typeof window !== 'undefined' ? window : globalThis);
