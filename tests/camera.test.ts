import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildCameraConstraints,
  checkCameraEnvironmentSupport,
  classifyCameraError,
  formatCameraError,
  openCameraStreamWithFallback,
  stopMediaStream,
} from '../lib/cameraUtils.ts';

test('1. Camera environment checks enforce HTTPS/localhost and mediaDevices support', () => {
  assert.deepEqual(
    checkCameraEnvironmentSupport({
      isSecureContext: false,
      hostname: 'example.com',
      mediaDevices: {getUserMedia: async () => ({}) as MediaStream},
    }),
    {supported: false, errorCode: 'insecure_context'}
  );

  assert.deepEqual(
    checkCameraEnvironmentSupport({
      isSecureContext: false,
      hostname: 'localhost',
      mediaDevices: {getUserMedia: async () => ({}) as MediaStream},
    }),
    {supported: true}
  );

  assert.deepEqual(
    checkCameraEnvironmentSupport({
      isSecureContext: true,
      hostname: 'rakshak.app',
      mediaDevices: null,
    }),
    {supported: false, errorCode: 'unsupported'}
  );
});

test('2. Rear camera default and front/rear switching constraints + Overconstrained fallback', async () => {
  const rear = buildCameraConstraints('environment', false);
  assert.deepEqual((rear.video as MediaTrackConstraints).facingMode, {
    ideal: 'environment',
  });
  assert.equal(rear.audio, false);

  const frontExact = buildCameraConstraints('user', true);
  assert.deepEqual((frontExact.video as MediaTrackConstraints).facingMode, {
    exact: 'user',
  });

  const seenConstraints: MediaStreamConstraints[] = [];
  const fakeStream = {
    getTracks: () => [{stop: () => {}}],
    getVideoTracks: () => [{stop: () => {}, getSettings: () => ({facingMode: 'user'})}],
  } as unknown as MediaStream;

  const result = await openCameraStreamWithFallback('environment', {
    preferExact: true,
    mediaDevices: {
      getUserMedia: async (constraints) => {
        seenConstraints.push(constraints);
        // Simulate desktop/single-camera OverconstrainedError on environment constraints
        if (
          typeof constraints.video === 'object' &&
          constraints.video?.facingMode
        ) {
          throw {name: 'OverconstrainedError'};
        }
        return fakeStream;
      },
      enumerateDevices: async () =>
        [
          {kind: 'videoinput'} as MediaDeviceInfo,
          {kind: 'videoinput'} as MediaDeviceInfo,
        ],
    },
  });

  assert.equal(seenConstraints.length, 3);
  assert.deepEqual(seenConstraints[2], {video: true, audio: false});
  assert.equal(result.stream, fakeStream);
  assert.equal(result.hasMultipleVideoInputs, true);
});

test('3. Closing or switching stops all media tracks and clears video srcObject', () => {
  let stoppedCount = 0;
  const fakeVideo = {srcObject: {} as MediaProvider | null};
  const fakeStream = {
    getTracks: () => [
      {stop: () => { stoppedCount += 1; }},
      {stop: () => { stoppedCount += 1; }},
    ],
  };

  stopMediaStream(fakeStream, fakeVideo);
  assert.equal(stoppedCount, 2);
  assert.equal(fakeVideo.srcObject, null);
});

test('4. Permission denied, no-camera, and camera-in-use errors are handled distinctly', () => {
  assert.equal(classifyCameraError({name: 'NotAllowedError'}), 'not_allowed');
  assert.equal(classifyCameraError({name: 'NotFoundError'}), 'not_found');
  assert.equal(classifyCameraError({name: 'NotReadableError'}), 'in_use');
  assert.equal(classifyCameraError({name: 'SecurityError'}), 'insecure_context');

  assert.ok(formatCameraError('not_allowed', 'hi').includes('अनुमति'));
  assert.ok(formatCameraError('not_found', 'en').includes('No camera'));
  assert.ok(formatCameraError('in_use', 'en').includes('another app'));
});
