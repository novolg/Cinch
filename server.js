const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const path = require('path');
const fs = require('fs');
const fsPromises = fs.promises;
const multer = require('multer');
const archiver = require('archiver');
const { exec } = require('child_process');
const { optimizeImage } = require('./optimizer');

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

const PORT = process.env.PORT || 3777;

// Active Batch Cancellation & Pause tracking
let currentBatchCancelled = false;
let currentBatchPaused = false;

// Configure file upload storage (temporary in uploads/)
const uploadDir = path.join(__dirname, 'uploads');
const outputDir = path.join(__dirname, 'output');
fs.mkdirSync(uploadDir, { recursive: true });
fs.mkdirSync(outputDir, { recursive: true });

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, uploadDir),
  filename: (req, file, cb) => {
    const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1e9);
    const ext = path.extname(file.originalname);
    cb(null, file.fieldname + '-' + uniqueSuffix + ext);
  }
});

const upload = multer({
  storage: storage,
  limits: { fileSize: 500 * 1024 * 1024 } // Up to 500MB per file
});

app.use(express.json({ limit: '100mb' }));
app.use(express.urlencoded({ extended: true, limit: '100mb' }));
app.use(express.static(path.join(__dirname, 'public')));
app.use('/output', express.static(outputDir));

// WebSocket Clients broadcast helper
function broadcast(data) {
  wss.clients.forEach(client => {
    if (client.readyState === WebSocket.OPEN) {
      client.send(JSON.stringify(data));
    }
  });
}

wss.on('connection', (ws) => {
  ws.send(JSON.stringify({ type: 'INIT', message: 'Connected to Cinch WebSocket' }));
});

// Helper format bytes
function formatBytes(bytes) {
  if (bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
}

const SUPPORTED_EXT = new Set(['.jpg', '.jpeg', '.png', '.webp', '.avif', '.heic', '.heif', '.tiff', '.tif', '.gif']);

// Recursive directory file scanner
async function scanDirectory(dirPath, recursive = true) {
  let fileList = [];
  const entries = await fsPromises.readdir(dirPath, { withFileTypes: true });

  for (const entry of entries) {
    const fullPath = path.join(dirPath, entry.name);
    if (entry.isDirectory() && recursive) {
      const subFiles = await scanDirectory(fullPath, recursive);
      fileList = fileList.concat(subFiles);
    } else if (entry.isFile()) {
      const ext = path.extname(entry.name).toLowerCase();
      if (SUPPORTED_EXT.has(ext)) {
        const stat = await fsPromises.stat(fullPath);
        fileList.push({
          fullPath,
          name: entry.name,
          relativePath: path.relative(dirPath, fullPath),
          size: stat.size
        });
      }
    }
  }
  return fileList;
}

// Endpoint: System Capabilities
app.get('/api/status', (req, res) => {
  res.json({
    status: 'ok',
    platform: process.platform,
    outputDir: outputDir,
    codecs: ['avif', 'webp', 'jpeg', 'png', 'original']
  });
});

// Endpoint: Scan Local macOS Folder Path
app.post('/api/scan-folder', async (req, res) => {
  try {
    const { folderPath } = req.body;
    if (!folderPath) {
      return res.status(400).json({ error: 'Enter a folder path.' });
    }

    const resolvedPath = path.resolve(folderPath.trim());
    const stat = await fsPromises.stat(resolvedPath);
    if (!stat.isDirectory()) {
      return res.status(400).json({ error: 'That path is not a folder.' });
    }

    const files = await scanDirectory(resolvedPath, true);
    res.json({
      success: true,
      folderPath: resolvedPath,
      totalFiles: files.length,
      files: files
    });
  } catch (err) {
    console.error('Folder scan error:', err);
    res.status(500).json({ error: 'Could not read that folder: ' + err.message });
  }
});

// Endpoint: Single Preview Comparison (Returns Base64 optimized image)
app.post('/api/preview-comparison', upload.single('file'), async (req, res) => {
  try {
    let inputSource;
    let tempPathToUnlink = null;

    if (req.file) {
      inputSource = req.file.path;
      tempPathToUnlink = req.file.path;
    } else if (req.body.localFilePath) {
      inputSource = req.body.localFilePath;
    } else {
      return res.status(400).json({ error: 'No image provided for preview' });
    }

    const options = JSON.parse(req.body.options || '{}');

    const result = await optimizeImage({
      input: inputSource,
      options: options
    });

    const base64Image = `data:image/${result.outputFormat};base64,${result.buffer.toString('base64')}`;

    if (tempPathToUnlink) {
      await fsPromises.unlink(tempPathToUnlink).catch(() => {});
    }

    res.json({
      success: true,
      originalSize: result.originalSize,
      newSize: result.newSize,
      savedBytes: result.savedBytes,
      savedPercent: result.savedPercent,
      originalWidth: result.originalWidth,
      originalHeight: result.originalHeight,
      outputWidth: result.outputWidth,
      outputHeight: result.outputHeight,
      outputFormat: result.outputFormat,
      processingTimeMs: result.processingTimeMs,
      previewUrl: base64Image
    });
  } catch (err) {
    console.error('Preview error:', err);
    res.status(500).json({ error: err.message });
  }
});

// Endpoint: Cancel Batch
app.post('/api/cancel-batch', (req, res) => {
  currentBatchCancelled = true;
  currentBatchPaused = false;
  broadcast({ type: 'BATCH_CANCELLED_SIGNAL' });
  res.json({ success: true, message: 'Batch cancelled signal sent' });
});

// Endpoint: Pause/Resume Batch
app.post('/api/pause-batch', (req, res) => {
  currentBatchPaused = req.body.paused;
  broadcast({ type: 'BATCH_PAUSED_SIGNAL', paused: currentBatchPaused });
  res.json({ success: true, paused: currentBatchPaused });
});

// Endpoint: Batch Optimization
app.post('/api/optimize-batch', upload.array('files', 100000), async (req, res) => {
  try {
    currentBatchCancelled = false;
    currentBatchPaused = false;
    const uploadedFiles = req.files || [];
    const localFilePaths = JSON.parse(req.body.localFiles || '[]');
    const options = JSON.parse(req.body.options || '{}');
    const customOutputDir = options.outputFolder ? path.resolve(options.outputFolder) : outputDir;

    await fsPromises.mkdir(customOutputDir, { recursive: true });

    // Combine uploaded files and local filesystem scanned files
    const allWorkItems = [];
    uploadedFiles.forEach(f => {
      allWorkItems.push({
        sourcePath: f.path,
        originalName: f.originalname,
        isUploaded: true
      });
    });
    localFilePaths.forEach(lf => {
      allWorkItems.push({
        sourcePath: lf.fullPath,
        originalName: lf.name,
        isUploaded: false
      });
    });

    if (allWorkItems.length === 0) {
      return res.status(400).json({ error: 'No files to process.' });
    }

    const results = [];
    let totalOriginal = 0;
    let totalNew = 0;
    const batchId = 'batch-' + Date.now();

    broadcast({ type: 'BATCH_START', batchId, totalCount: allWorkItems.length });

    for (let i = 0; i < allWorkItems.length; i++) {
      while (currentBatchPaused && !currentBatchCancelled) {
        await new Promise(resolve => setTimeout(resolve, 500));
      }

      if (currentBatchCancelled) {
        console.log('Batch processing stopped by user request.');
        broadcast({ type: 'BATCH_STOPPED', processedCount: i });
        break;
      }

      const item = allWorkItems[i];
      const parsed = path.parse(item.originalName);

      let ext = `.${options.format.toLowerCase()}`;
      if (options.format.toLowerCase() === 'original') {
        ext = parsed.ext;
      } else if (options.format.toLowerCase() === 'jpeg') {
        ext = '.jpg';
      }

      const outFileName = `${parsed.name}_optimized${ext}`;
      const outFilePath = path.join(customOutputDir, outFileName);

      try {
        const itemRes = await optimizeImage({
          input: item.sourcePath,
          outputPath: outFilePath,
          options: options
        });

        totalOriginal += itemRes.originalSize;
        totalNew += itemRes.newSize;

        const itemData = {
          id: i,
          fileName: item.originalName,
          outputName: outFileName,
          originalSize: itemRes.originalSize,
          newSize: itemRes.newSize,
          savedBytes: itemRes.savedBytes,
          savedPercent: itemRes.savedPercent,
          width: itemRes.outputWidth,
          height: itemRes.outputHeight,
          format: itemRes.outputFormat,
          timeMs: itemRes.processingTimeMs,
          outputPath: outFilePath,
          webUrl: `/output/${outFileName}`
        };

        results.push(itemData);

        broadcast({
          type: 'ITEM_PROGRESS',
          batchId,
          index: i + 1,
          total: allWorkItems.length,
          item: itemData,
          totalOriginal,
          totalNew
        });
      } catch (err) {
        console.error(`Error processing file ${item.originalName}:`, err);
        results.push({
          id: i,
          fileName: item.originalName,
          error: err.message,
          success: false
        });
      } finally {
        if (item.isUploaded) {
          await fsPromises.unlink(item.sourcePath).catch(() => {});
        }
      }
    }

    const totalSavedBytes = Math.max(0, totalOriginal - totalNew);
    const totalSavedPercent = totalOriginal > 0 ? ((totalSavedBytes / totalOriginal) * 100).toFixed(1) : 0;

    const summary = {
      success: true,
      batchId,
      cancelled: currentBatchCancelled,
      totalFiles: allWorkItems.length,
      processedFiles: results.length,
      totalOriginalSize: totalOriginal,
      totalNewSize: totalNew,
      totalSavedBytes: totalSavedBytes,
      totalSavedPercent: parseFloat(totalSavedPercent),
      outputDirectory: customOutputDir,
      results: results
    };

    broadcast({ type: 'BATCH_COMPLETE', summary });
    res.json(summary);
  } catch (err) {
    console.error('Batch error:', err);
    res.status(500).json({ error: err.message });
  }
});

// Endpoint: Open folder in macOS Finder
app.post('/api/open-finder', (req, res) => {
  const folderPath = req.body.folderPath || outputDir;
  exec(`open "${folderPath}"`, (error) => {
    if (error) {
      return res.status(500).json({ error: 'Failed to open folder in Finder' });
    }
    res.json({ success: true, opened: folderPath });
  });
});

// Endpoint: Download Zip Archive
app.post('/api/download-zip', async (req, res) => {
  const { files } = req.body;
  if (!files || files.length === 0) {
    return res.status(400).json({ error: 'No files provided for zip archive' });
  }

  res.attachment('optimized_images.zip');
  const archive = archiver('zip', { zlib: { level: 9 } });
  archive.pipe(res);

  for (const filePath of files) {
    if (fs.existsSync(filePath)) {
      archive.file(filePath, { name: path.basename(filePath) });
    }
  }

  archive.finalize();
});

// Frontend error logging endpoint
app.post('/api/log-error', (req, res) => {
  console.error('[FRONTEND ERROR]:', req.body.error);
  res.json({ success: true });
});

server.listen(PORT, () => {
  const url = `http://localhost:${PORT}`;
  console.log(`\n✨ Cinch is running at: ${url}`);
  console.log(`📂 Output files saved to: ${outputDir}\n`);
});
