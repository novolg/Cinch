const sharp = require('sharp');
const path = require('path');
const fs = require('fs').promises;

/**
 * Optimizes an image using sharp libvips algorithms
 * @param {Object} params
 * @param {string|Buffer} params.input - Path to source image file or image Buffer
 * @param {string} [params.outputPath] - Path to save the output file (optional)
 * @param {Object} [params.options] - Optimization settings
 * @returns {Promise<Object>} Statistics and output buffer/path details
 */
async function optimizeImage({ input, outputPath, options = {} }) {
  const startTime = Date.now();

  const {
    format = 'webp',             // 'avif' | 'webp' | 'jpeg' | 'png' | 'original'
    quality = 75,                // 1 - 100
    effort = 6,                  // 0 - 9 (compression effort/speed trade-off)
    maxWidth = null,             // Target max width
    maxHeight = null,            // Target max height
    fit = 'inside',              // 'inside' | 'cover' | 'contain' | 'fill'
    withoutEnlargement = true,   // Don't enlarge if image is smaller than dimensions
    stripMetadata = true,        // Strip EXIF/GPS/ICC metadata for smallest size
    lossless = false,            // Lossless compression where supported
    pngPalette = true,           // Enable palette quantization for PNGs (like pngquant)
    chromaSubsampling = '4:2:0', // '4:2:0' or '4:4:4'
    rotateAuto = true            // Auto-rotate according to EXIF before stripping metadata
  } = options;

  let imagePipeline = sharp(input);

  // Read metadata of original
  const metaOriginal = await imagePipeline.metadata();
  let originalSize = 0;

  if (typeof input === 'string') {
    const stat = await fs.stat(input);
    originalSize = stat.size;
  } else if (Buffer.isBuffer(input)) {
    originalSize = input.length;
  }

  // Auto-rotate if EXIF orientation tag exists
  if (rotateAuto) {
    imagePipeline = imagePipeline.rotate();
  }

  // Resize if dimensions specified
  if (maxWidth || maxHeight) {
    imagePipeline = imagePipeline.resize({
      width: maxWidth ? parseInt(maxWidth, 10) : undefined,
      height: maxHeight ? parseInt(maxHeight, 10) : undefined,
      fit: fit,
      kernel: sharp.kernel.lanczos3,
      withoutEnlargement: withoutEnlargement
    }).sharpen(); // Adds a mild unsharp mask to recover acutance lost during downscaling
  }

  // Preserve metadata if requested, otherwise sharp strips by default unless .withMetadata() is called
  if (!stripMetadata) {
    imagePipeline = imagePipeline.withMetadata();
  }

  // Determine target output format
  let targetFormat = format.toLowerCase();
  if (targetFormat === 'original') {
    targetFormat = metaOriginal.format || 'jpeg';
    if (targetFormat === 'heif') targetFormat = 'avif'; // standard conversion
  }

  // Configure codec options
  const targetQuality = Math.min(Math.max(parseInt(quality, 10) || 75, 1), 100);
  const targetEffort = Math.min(Math.max(parseInt(effort, 10) || 6, 0), 9);

  switch (targetFormat) {
    case 'avif':
      imagePipeline = imagePipeline.avif({
        quality: targetQuality,
        effort: targetEffort,
        chromaSubsampling: chromaSubsampling,
        lossless: Boolean(lossless)
      });
      break;

    case 'webp':
      imagePipeline = imagePipeline.webp({
        quality: targetQuality,
        effort: Math.min(targetEffort, 6), // webp effort max 6 in sharp
        smartSubsample: true,
        lossless: Boolean(lossless)
      });
      break;

    case 'jpeg':
    case 'jpg':
      imagePipeline = imagePipeline.jpeg({
        quality: targetQuality,
        mozjpeg: true, // Use MozJPEG engine for up to 15-20% better compression ratio
        progressive: true,
        chromaSubsampling: chromaSubsampling
      });
      targetFormat = 'jpeg';
      break;

    case 'png':
      imagePipeline = imagePipeline.png({
        quality: targetQuality,
        compressionLevel: 9,
        effort: targetEffort,
        palette: Boolean(pngPalette), // Enable 8-bit palette quantization
        progressive: true
      });
      break;

    case 'tiff':
      imagePipeline = imagePipeline.tiff({
        quality: targetQuality,
        compression: 'deflate'
      });
      break;

    default:
      // Default to webp if format unsupported
      imagePipeline = imagePipeline.webp({
        quality: targetQuality,
        effort: 5
      });
      targetFormat = 'webp';
      break;
  }

  // Output generation
  let outputBuffer;
  if (outputPath) {
    // Ensure output parent folder exists
    await fs.mkdir(path.dirname(outputPath), { recursive: true });
    await imagePipeline.toFile(outputPath);
    const outStat = await fs.stat(outputPath);
    outputBuffer = null;
    var newSize = outStat.size;
  } else {
    outputBuffer = await imagePipeline.toBuffer();
    var newSize = outputBuffer.length;
  }

  // Get resulting dimensions
  let newWidth = metaOriginal.width;
  let newHeight = metaOriginal.height;
  if (maxWidth || maxHeight) {
    // calculate resized dimensions
    const resMeta = await sharp(outputPath || outputBuffer).metadata();
    newWidth = resMeta.width;
    newHeight = resMeta.height;
  }

  const savedBytes = Math.max(0, originalSize - newSize);
  const savedPercent = originalSize > 0 ? ((savedBytes / originalSize) * 100).toFixed(1) : '0';
  const processingTimeMs = Date.now() - startTime;

  return {
    success: true,
    originalSize,
    newSize,
    savedBytes,
    savedPercent: parseFloat(savedPercent),
    originalWidth: metaOriginal.width,
    originalHeight: metaOriginal.height,
    originalFormat: metaOriginal.format,
    outputWidth: newWidth,
    outputHeight: newHeight,
    outputFormat: targetFormat,
    processingTimeMs,
    outputPath: outputPath || null,
    buffer: outputBuffer
  };
}

module.exports = {
  optimizeImage
};
