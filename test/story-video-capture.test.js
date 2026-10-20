import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const source = fs.readFileSync(path.join(here, '..', 'story-video-capture.js'), 'utf8');

function track(kind) {
  return {
    kind,
    stopped: false,
    clones: 0,
    stop() { this.stopped = true; },
    clone() { this.clones++; return track(kind); }
  };
}

function mediaStream(video = [], audio = []) {
  const tracks = [...video, ...audio];
  return {
    tracks,
    getTracks() { return tracks; },
    getVideoTracks() { return tracks.filter(item => item.kind === 'video'); },
    getAudioTracks() { return tracks.filter(item => item.kind === 'audio'); },
    addTrack(item) { tracks.push(item); }
  };
}

function harness({ audioContext = true, canvas = true } = {}) {
  const madeContexts = [];
  const rafCallbacks = new Map();
  let nextRaf = 1;
  const root = {
    requestAnimationFrame(callback) { const id = nextRaf++; rafCallbacks.set(id, callback); return id; },
    cancelAnimationFrame(id) { rafCallbacks.delete(id); }
  };
  if (audioContext) {
    root.AudioContext = class {
      constructor() {
        this.state = 'suspended';
        this.destination = { name: 'speaker' };
        this.closeCalls = 0;
        this.sourceConnections = [];
        this.audioTrack = track('audio');
        this.destinationStream = mediaStream([], [this.audioTrack]);
        madeContexts.push(this);
      }
      createMediaElementSource(player) {
        this.player = player;
        return { connect: target => this.sourceConnections.push(target) };
      }
      createMediaStreamDestination() { return { stream: this.destinationStream }; }
      resume() { this.state = 'running'; return Promise.resolve(); }
      close() { this.closeCalls++; this.state = 'closed'; return Promise.resolve(); }
    };
  }
  if (canvas) {
    root.document = {
      createElement(tag) {
        assert.equal(tag, 'canvas');
        const canvasElement = {
          width: 0,
          height: 0,
          draws: 0,
          getContext(type) {
            assert.equal(type, '2d');
            return { drawImage() { canvasElement.draws++; } };
          },
          captureStream(fps) {
            canvasElement.fps = fps;
            canvasElement.stream = mediaStream([track('video')]);
            return canvasElement.stream;
          }
        };
        root.lastCanvas = canvasElement;
        return canvasElement;
      }
    };
  }
  vm.runInNewContext(source, { window: root });
  return { api: root.StemmaStoryVideoCapture, root, madeContexts, rafCallbacks };
}

function player(extra = {}) {
  return { videoWidth: 1920, videoHeight: 1080, readyState: 2, ...extra };
}

test('prefers a native stream with video and audio and stops its tracks on cleanup', async () => {
  const { api, madeContexts } = harness();
  const video = track('video');
  const audio = track('audio');
  const native = mediaStream([video], [audio]);
  const element = player({ captureStream: () => native });

  const result = await api.capture(element);
  assert.equal(result.stream, native);
  assert.equal(madeContexts.length, 0);
  result.cleanup();
  result.cleanup();
  assert.equal(video.stopped, true);
  assert.equal(audio.stopped, true);
});

test('native video without audio adds cached audible Web Audio track across retries', async () => {
  const { api, madeContexts } = harness();
  const nativeStreams = [];
  const element = player({ captureStream: () => {
    const stream = mediaStream([track('video')]);
    nativeStreams.push(stream);
    return stream;
  } });

  const first = await api.capture(element);
  assert.equal(first.stream.getAudioTracks().length, 1);
  first.cleanup();
  const second = await api.capture(element);
  assert.equal(second.stream.getAudioTracks().length, 1);
  assert.equal(madeContexts.length, 1);
  assert.equal(madeContexts[0].state, 'running');
  assert.ok(madeContexts[0].sourceConnections.includes(madeContexts[0].destination));
  assert.equal(madeContexts[0].sourceConnections.length, 2);

  second.cleanup();
  await api.release(element);
  assert.equal(madeContexts[0].closeCalls, 1);
  assert.ok(nativeStreams.flatMap(stream => stream.tracks).every(item => item.stopped));
});

test('falls back to scaled canvas capture when native capture omits known source audio', async () => {
  const { api, root } = harness();
  const nativeVideo = track('video');
  const native = mediaStream([nativeVideo]);
  const element = player({
    audioTracks: { length: 1 },
    captureStream: () => native
  });

  const result = await api.capture(element);
  assert.notEqual(result.stream, native);
  assert.equal(nativeVideo.stopped, true);
  assert.equal(root.lastCanvas.width, 1280);
  assert.equal(root.lastCanvas.height, 720);
  assert.equal(root.lastCanvas.fps, 30);
  assert.ok(root.lastCanvas.draws >= 1);
  assert.equal(result.stream.getAudioTracks().length, 1);
  assert.equal(root.lastCanvas.stream.getVideoTracks().length, 1);
  result.cleanup();
  assert.ok(root.lastCanvas.stream.tracks.every(item => item.stopped));
  assert.equal(root.StemmaStoryVideoCapture, api);
});

test('uses mozCaptureStream when standard captureStream is unavailable', async () => {
  const { api } = harness();
  const native = mediaStream([track('video')], [track('audio')]);
  const element = player({ mozCaptureStream: () => native });
  const result = await api.capture(element);
  assert.equal(result.stream, native);
  result.cleanup();
});

test('reports a clear error instead of returning a silent canvas stream without AudioContext', async () => {
  const { api } = harness({ audioContext: false });
  const element = player();
  await assert.rejects(api.capture(element), /Audio capture is unavailable.*original video was not uploaded/);
});

test('reports a clear error when neither native capture nor canvas is available', async () => {
  const { api } = harness({ canvas: false });
  const element = player({ captureStream: () => { throw new Error('unsupported'); } });
  await assert.rejects(api.capture(element), /could not capture the video.*original video was not uploaded/);
});

test('rejects canvas capture before a decoded frame is available', async () => {
  const { api } = harness();
  await assert.rejects(api.capture(player({ readyState: 1 })), /no decoded frame to capture yet/);
});
