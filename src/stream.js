const Utils = require('./utils');
const Media = require('./media');

/** The interval between QR code local stream samples. */
const DEFAULT_LOCAL_INTERVAL = 300;
/** The interval between other image requests. */
const DEFAULT_REMOTE_INTERVAL = 1500;
/** The minimum interval between image requests. */
const MIN_REMOTE_INTERVAL = 500;
/** Optimal settings for digimarc and discover.js */
const OPTIMAL_DIGIMARC_IMAGE_CONVERSION = {
  exportFormat: 'image/jpeg',
  greyscale: false,
  resizeTo: 1080,
  exportQuality: 0.85,
  cropPercent: 0.1,
};

let video;
let stream;
let frameIntervalHandle;
let canvas;
let cropCanvas;
let requestPending = false;

/**
 * Get dimensions for a cropped canvas based on percentage reduced from the edge.
 * E.g: cropPercent = 0.1 means 10% cropped inwards.
 *
 * @param {number} cropPercent - Amount to crop, from 0.1 to 1.0.
 * @returns {object} { x, y, width, height } of the cropped canvas.
 */
const getCropDimensions = (cropPercent = 0) => {
  if (typeof cropPercent !== 'number' || cropPercent < 0 || cropPercent > 0.9) {
    throw new Error('cropPercent option must be between 0 and 0.9');
  }

  let x = 0;
  let y = 0;
  let { width, height } = canvas;

  // No change requested
  if (cropPercent === 0) {
    return {
      x, y, width, height,
    };
  }

  // Crop to a central square
  const isPortrait = height > width;
  if (isPortrait) {
    y = (height - width) / 2;
    height = width;
  } else {
    x = (width - height) / 2;
    width = height;
  }

  const margin = isPortrait ? cropPercent * width : cropPercent * height;
  x += margin;
  y += margin;
  width -= margin;
  height -= margin;

  return {
    x: Math.round(x),
    y: Math.round(y),
    width: Math.round(width),
    height: Math.round(height),
  };
};

/**
 * Get the image data from the canvas, square cropping if required.
 *
 * @param {float} cropPercent - Amount to crop by to simulate zoom.
 * @returns {ImageData} Image data.
 */
const getCanvasImageData = (cropPercent) => {
  const {
    x, y, width, height,
  } = getCropDimensions(cropPercent);

  try {
    const ctx = canvas.getContext('2d');
    ctx.imageSmoothingEnabled = false;
    return ctx.getImageData(x, y, width, height);
  } catch (e) {
    console.log('Failed to getImageData - device may not be ready.');
  }

  return undefined;
};

/**
 * Draw a square cropped canvas image to the cropCanvas.
 *
 * @param {number} cropPercent - Percentage as a float to crop from all edges.
 */
const drawCropCanvasImage = (cropPercent) => {
  const {
    x, y, width, height,
  } = getCropDimensions(cropPercent);

  // Draw crop area onto cropCanvas for later toDataURL() usage
  cropCanvas.width = width;
  cropCanvas.height = height;
  const ctx = cropCanvas.getContext('2d');
  ctx.imageSmoothingEnabled = false;
  ctx.drawImage(canvas, x, y, width, height, 0, 0, width, height);
};

/**
 * Process a sample frame from the stream, and find any code present.
 * A callback is required since any promise per-frame won't necessarily resolve or reject.
 *
 * @param {object} opts - The scanning options.
 * @param {function} foundCb - Callback for if a code is found.
 * @param {object} [scope] - Application or Operator scope, if decoding with the API is to be used.
 */
const scanSample = (opts, foundCb, scope) => {
  if (requestPending) {
    console.log('API request pending, skipping this frame');
    return;
  }

  // Match canvas internal dimensions to that of the video
  canvas.width = video.videoWidth;
  canvas.height = video.videoHeight;

  // Draw visible image for the user experience
  const ctx = canvas.getContext('2d');
  ctx.imageSmoothingEnabled = false;
  ctx.drawImage(video, 0, 0);

  const {
    filter: { method, type },
    downloadFrames = false,
    useDiscover = false,
    onDiscoverResult,
    imageConversion = {},
  } = opts;
  const { cropPercent } = imageConversion;
  const { width, height } = canvas;

  // Client-side QR code scan
  if (method === '2d' && type === 'qr_code') {
    const imgData = getCanvasImageData();
    if (!imgData) return;

    // Scan image data with jsQR
    const result = window.jsQR(imgData.data, width, height);
    if (result) foundCb(result.data);
    return;
  }

  // If Application scope not specified, can't identify the code via the API.
  if (!scope) return;

  // Client-side digimarc pre-scan watermark detection
  if (method === 'digimarc' && useDiscover) {
    const imgData = getCanvasImageData(cropPercent);
    if (!imgData) return;

    const { result } = Discover.detectWatermark(imgData.width, imgData.height, imgData.data);
    console.log(`discover.js detected: ${result.ready_for_read}`);

    // Notify application if it wants
    if (onDiscoverResult) {
      // Pass true if this frame detected a watermark, and whatever discover.js provides
      onDiscoverResult(result.ready_for_read, result);
    }

    // If nothing was found in this frame, don't send to the API (save data)
    if (!result.ready_for_read) return;
  }

  // Also crop here for dataURL data, same as in getCanvasImageData above.
  if (cropPercent) drawCropCanvasImage(cropPercent);

  // Create the correct format in case downloadFrames is enabled
  const { exportFormat, exportQuality } = imageConversion;
  const dataUrl = cropPercent
    ? cropCanvas.toDataURL(exportFormat, exportQuality)
    : canvas.toDataURL(exportFormat, exportQuality);

  // If required, prompt and wait for downloading the frame file
  if (downloadFrames) {
    const anchor = document.createElement('a');
    anchor.download = 'frame.jpeg';
    anchor.href = dataUrl;
    anchor.click();
  }

  // Else, send image data to ID Rec API - whatever filter is requested is passed through.
  requestPending = true;
  scope
    .scan(dataUrl, opts)
    .then((res) => {
      requestPending = false;

      // Only stop scanning if a resource is found
      if (res.length) foundCb(res);
    })
    .catch((err) => {
      requestPending = false;

      // Handle 'not found' for empty images based on API response
      if (err.errors && err.errors[0].includes('lacking sufficient detail')) return;

      throw err;
    });
};

/**
 * Stop the video stream
 */
const stop = () => {
  if (!frameIntervalHandle) return;

  clearInterval(frameIntervalHandle);
  frameIntervalHandle = null;

  stream.getVideoTracks()[0].stop();
  stream = null;
  video.parentElement.removeChild(video);
};

/**
 * Consume a getUserMedia() video stream and resolves once recognition is completed.
 *
 * @param {Object} opts - The scanning options.
 * @param {Object} [scope] - Application or Operator scope, if decoding with the API is to be used.
 * @returns {Promise} A Promise that resolves once recognition is completed.
 */
const findBarcodeInStream = (opts, scope) => {
  video = document.getElementById(Utils.VIDEO_ELEMENT_ID);
  video.srcObject = stream;
  video.play();

  const {
    filter: {
      method,
      type,
    },
    autoStop = true,
    useDiscover = false,
    imageConversion,
  } = opts;
  const usingLocalDiscover = method === 'digimarc' && useDiscover;
  const localScan = method === '2d' && type === 'qr_code';

  // Local QR codes scans are fast, so can be frequent. With discover.js, it's high-res and slow.
  const interval = opts.interval || localScan ? DEFAULT_LOCAL_INTERVAL : DEFAULT_REMOTE_INTERVAL;

  // Autopilot best digimarc imageConversion settings
  if (usingLocalDiscover && !imageConversion) {
    console.log(`Selecting optimal digimarc conversion: ${JSON.stringify(OPTIMAL_DIGIMARC_IMAGE_CONVERSION)}`);
    opts.imageConversion = OPTIMAL_DIGIMARC_IMAGE_CONVERSION;
  } else {
    // Use provided conversion options, or prep the default in case needed in scanSample()
    opts.imageConversion = imageConversion || Media.DEFAULT_OPTIONS.imageConversion;
  }

  // If not a local QR scan, or using discover.js and no Scope is available
  if ((!localScan && !scope) || (useDiscover && !scope)) {
    throw new Error('Non-local code scanning requires specifying an Application or Operator scope for API access');
  }

  canvas = document.createElement('canvas');
  cropCanvas = document.createElement('canvas');
  return new Promise((resolve, reject) => {
    /**
     * Check a single frame, resolving if something is scanned.
     */
    const checkFrame = () => {
      try {
        // Scan each sample for a barcode
        scanSample(opts, (scanValue) => {
          // Unless specified otherwise, by default close the stream and remove the video
          if (autoStop) stop();

          resolve(scanValue);
        }, scope);
      } catch (e) {
        reject(e);
      }
    };

    frameIntervalHandle = setInterval(
      checkFrame,
      localScan ? interval : Math.max(MIN_REMOTE_INTERVAL, interval),
    );
  });
};

/**
 * Use webRTC to open the camera, scan for a code, and resolve the value.
 *
 * @param {Object} opts - The scanning options.
 * @param {Object} [scope] - Application or Operator scope, if decoding with the API is to be used.
 * @returns {Promise} Promise resolving the stream opened.
 */
const scanCode = (opts, scope) => {
  if (!window.jsQR) {
    throw new Error('jsQR (https://github.com/cozmo/jsQR) not found. You must include it in a <script> tag.');
  }
  if (!document.getElementById(opts.containerId)) {
    throw new Error('Please specify \'containerId\' where the video element can be added as a child');
  }

  return navigator.mediaDevices.enumerateDevices()
    .then((devices) => devices.filter((device) => device.kind === 'videoinput'))
    .then((devices) => {
      const constraints = {
        video: {
          facingMode: 'environment',
          deviceId: devices.length > 0 ? devices[devices.length - 1].deviceId : undefined,
          width: { ideal: 1920 },
          height: { ideal: 1080 },
        },
      };

      return navigator
        .mediaDevices
        .getUserMedia(constraints);
    })
    .then((newStream) => {
      stream = newStream;
      Utils.insertVideoElement(opts.containerId);

      return findBarcodeInStream(opts, scope);
    });
};

/**
 * Enable/disable the torch, if supported by the browser/device.
 * The video stream must be started before using this method.
 *
 * @param {boolean} enabled - true if the torch should be switched on.
 */
const setTorchEnabled = (enabled) => {
  if (!stream) throw new Error('Stream not ready, torch cannot be enabled');

  const track = stream.getVideoTracks()[0];
  const capabilities = track.getCapabilities();
  if (!capabilities.torch) throw new Error('Device does not support the torch capability');

  track
    .applyConstraints({
      advanced: [{ torch: enabled }],
    })
    .catch((e) => console.log(e));
};

if (typeof module !== 'undefined') {
  module.exports = {
    scanCode,
    stop,
    setTorchEnabled,
  };
}
