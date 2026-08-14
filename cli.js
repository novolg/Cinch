#!/usr/bin/env node

const { Command } = require('commander');
const path = require('path');
const fs = require('fs');
const fsPromises = fs.promises;
const picocolors = require('picocolors');
const cliProgress = require('cli-progress');
const { optimizeImage } = require('./optimizer');

const program = new Command();

program
  .name('cinch')
  .description('Cinch — high-performance batch image compression & resizing for macOS using AVIF/WebP/MozJPEG codecs')
  .version('1.0.0')
  .argument('<inputs...>', 'Input file(s) or directory path(s)')
  .option('-o, --output <dir>', 'Output directory (default: ./optimized_output)', './optimized_output')
  .option('-f, --format <type>', 'Output format: avif, webp, jpeg, png, original', 'webp')
  .option('-q, --quality <number>', 'Quality percentage (1-100)', '80')
  .option('-e, --effort <number>', 'Codec compression effort (0-9)', '6')
  .option('-w, --max-width <pixels>', 'Max width limit for resizing')
  .option('-h, --max-height <pixels>', 'Max height limit for resizing')
  .option('--keep-exif', 'Keep EXIF & ICC metadata instead of stripping', false)
  .option('--lossless', 'Use lossless compression mode', false)
  .option('-r, --recursive', 'Process directory recursively', true);

program.parse(process.argv);

const options = program.opts();
const inputArgs = program.args;

const SUPPORTED_EXT = new Set(['.jpg', '.jpeg', '.png', '.webp', '.avif', '.heic', '.heif', '.tiff', '.tif', '.gif']);

async function getFiles(inputPath, recursive = true) {
  let fileList = [];
  const stat = await fsPromises.stat(inputPath);

  if (stat.isFile()) {
    const ext = path.extname(inputPath).toLowerCase();
    if (SUPPORTED_EXT.has(ext)) {
      fileList.push(inputPath);
    }
  } else if (stat.isDirectory()) {
    const entries = await fsPromises.readdir(inputPath, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(inputPath, entry.name);
      if (entry.isDirectory() && recursive) {
        const subFiles = await getFiles(fullPath, recursive);
        fileList = fileList.concat(subFiles);
      } else if (entry.isFile()) {
        const ext = path.extname(entry.name).toLowerCase();
        if (SUPPORTED_EXT.has(ext)) {
          fileList.push(fullPath);
        }
      }
    }
  }

  return fileList;
}

function formatBytes(bytes) {
  if (bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
}

async function runCLI() {
  console.log('\n' + picocolors.bold(picocolors.cyan('Cinch — batch image compression')));
  console.log(picocolors.gray('----------------------------------------------------'));

  let allFiles = [];
  for (const inputPath of inputArgs) {
    try {
      const files = await getFiles(path.resolve(inputPath), options.recursive);
      allFiles = allFiles.concat(files);
    } catch (err) {
      console.error(picocolors.red(`⚠️  Error reading path "${inputPath}": ${err.message}`));
    }
  }

  if (allFiles.length === 0) {
    console.log(picocolors.yellow('⚠️  No supported image files found to process.'));
    process.exit(1);
  }

  console.log(picocolors.green(`📁 Found ${allFiles.length} image(s) for batch processing.`));
  console.log(picocolors.dim(`⚙️  Target Format: ${options.format.toUpperCase()} | Quality: ${options.quality}% | Effort: ${options.effort}`));
  if (options.maxWidth || options.maxHeight) {
    console.log(picocolors.dim(`📐 Resize Bounds: ${options.maxWidth || 'auto'} x ${options.maxHeight || 'auto'}`));
  }
  console.log(picocolors.gray('----------------------------------------------------\n'));

  const outputDir = path.resolve(options.output);
  await fsPromises.mkdir(outputDir, { recursive: true });

  const progressBar = new cliProgress.SingleBar({
    format: picocolors.cyan('{bar}') + ' | {percentage}% | {value}/{total} files | Speed: {speed} img/s',
    barCompleteChar: '\u2588',
    barIncompleteChar: '\u2591',
    hideCursor: true
  });

  const startTime = Date.now();
  progressBar.start(allFiles.length, 0, { speed: 'N/A' });

  let totalOriginalBytes = 0;
  let totalOptimizedBytes = 0;
  let successCount = 0;
  let failCount = 0;

  for (let i = 0; i < allFiles.length; i++) {
    const file = allFiles[i];
    const fileBasename = path.basename(file, path.extname(file));
    
    // Output extension based on target format
    let targetExt = `.${options.format.toLowerCase()}`;
    if (options.format.toLowerCase() === 'original') {
      targetExt = path.extname(file);
    } else if (options.format.toLowerCase() === 'jpeg') {
      targetExt = '.jpg';
    }

    const outFilePath = path.join(outputDir, `${fileBasename}${targetExt}`);

    try {
      const res = await optimizeImage({
        input: file,
        outputPath: outFilePath,
        options: {
          format: options.format,
          quality: parseInt(options.quality, 10),
          effort: parseInt(options.effort, 10),
          maxWidth: options.maxWidth,
          maxHeight: options.maxHeight,
          stripMetadata: !options.keepExif,
          lossless: options.lossless
        }
      });

      totalOriginalBytes += res.originalSize;
      totalOptimizedBytes += res.newSize;
      successCount++;
    } catch (err) {
      failCount++;
    }

    const elapsedSec = (Date.now() - startTime) / 1000;
    const speed = elapsedSec > 0 ? ((i + 1) / elapsedSec).toFixed(1) : '0';
    progressBar.update(i + 1, { speed });
  }

  progressBar.stop();

  const totalSavedBytes = Math.max(0, totalOriginalBytes - totalOptimizedBytes);
  const totalSavedPercent = totalOriginalBytes > 0 ? ((totalSavedBytes / totalOriginalBytes) * 100).toFixed(1) : '0';
  const totalTimeSec = ((Date.now() - startTime) / 1000).toFixed(2);

  console.log('\n' + picocolors.bold(picocolors.green('✅ Batch Optimization Finished!')));
  console.log(picocolors.gray('----------------------------------------------------'));
  console.log(`📊 Processed Files:     ${picocolors.bold(successCount)} successful, ${failCount} failed`);
  console.log(`📦 Total Input Size:    ${formatBytes(totalOriginalBytes)}`);
  console.log(`⚡ Total Output Size:   ${formatBytes(totalOptimizedBytes)}`);
  console.log(`🎉 Total Saved Space:   ${picocolors.bold(picocolors.green(formatBytes(totalSavedBytes)))} (${picocolors.bold(picocolors.green(totalSavedPercent + '%'))})`);
  console.log(`⏱️  Total Duration:      ${totalTimeSec} seconds`);
  console.log(`📂 Output Directory:    ${picocolors.cyan(outputDir)}`);
  console.log(picocolors.gray('----------------------------------------------------\n'));
}

runCLI();
