window.onerror = function(msg, url, line, col, error) {
  fetch('/api/log-error', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ error: `${msg} at ${line}:${col}` }) });
};
window.addEventListener('unhandledrejection', function(event) {
  fetch('/api/log-error', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ error: `Promise rejected: ${event.reason}` }) });
});

document.addEventListener('DOMContentLoaded', () => {
  // Sidebar Controls
  const formatSelect = document.getElementById('formatSelect');
  const qualityRange = document.getElementById('qualityRange');
  const qualityVal = document.getElementById('qualityVal');
  const qualityField = document.getElementById('qualityField');
  const effortRange = document.getElementById('effortRange');
  const effortVal = document.getElementById('effortVal');
  const maxWidth = document.getElementById('maxWidth');
  const maxHeight = document.getElementById('maxHeight');
  const stripMetadata = document.getElementById('stripMetadata');
  const losslessMode = document.getElementById('losslessMode');

  const presetButtons = document.querySelectorAll('.preset-btn');
  const btnTestSingleGlobal = document.getElementById('btnTestSingleGlobal');

  // Input & Main Action Elements
  const dropzone = document.getElementById('dropzone');
  const resultsSection = document.getElementById('resultsSection');
  
  const fileInput = document.getElementById('fileInput');
  const folderInput = document.getElementById('folderInput');
  const localFolderPathInput = document.getElementById('localFolderPathInput');
  const btnScanFolder = document.getElementById('btnScanFolder');

  const btnProcessBatch = document.getElementById('btnProcessBatch');
  const btnDownloadZip = document.getElementById('btnDownloadZip');
  const btnOpenFinder = document.getElementById('btnOpenFinder');
  const btnClearQueue = document.getElementById('btnClearQueue');

  // Table
  const fileTableBody = document.getElementById('fileTableBody');
  const fileCountBadge = document.getElementById('fileCountBadge');

  // Progress Footer & Sidebar Stats
  const progressBanner = document.getElementById('progressBanner');
  const progressText = document.getElementById('progressText');
  const progressPercent = document.getElementById('progressPercent');
  const progressBarFill = document.getElementById('progressBarFill');
  const btnStopBatch = document.getElementById('btnStopBatch');
  const btnPauseBatch = document.getElementById('btnPauseBatch');
  let isBatchPaused = false;

  const statsSummary = document.getElementById('statsSummary');
  const statOriginal = document.getElementById('statOriginal');
  const statNew = document.getElementById('statNew');
  const statSaved = document.getElementById('statSaved');

  // Modal & Zoom Elements
  const compareModal = document.getElementById('compareModal');
  const btnCloseModal = document.getElementById('btnCloseModal');
  const compareWrapper = document.getElementById('compareWrapper');
  const zoomLayerOrig = document.getElementById('zoomLayerOrig');
  const zoomLayerOpt = document.getElementById('zoomLayerOpt');
  
  const compareOriginalImg = document.getElementById('compareOriginalImg');
  const compareOptimizedImg = document.getElementById('compareOptimizedImg');
  const compareSliderOverlay = document.getElementById('compareSliderOverlay');
  const compareHandle = document.getElementById('compareHandle');
  const compareStatsInfo = document.getElementById('compareStatsInfo');

  const btnZoomIn = document.getElementById('btnZoomIn');
  const btnZoomOut = document.getElementById('btnZoomOut');
  const btnZoomReset = document.getElementById('btnZoomReset');
  const zoomLevelText = document.getElementById('zoomLevelText');

  const toastStack = document.getElementById('toastStack');

  // State
  let queueFiles = []; 
  let queueLocalFiles = [];
  let completedResults = [];
  let outputDirectoryPath = '';
  let isBatchRunning = false;
  let isBatchCancelled = false;

  // Zoom & Pan State
  let zoomScale = 1.0;
  let panX = 0;
  let panY = 0;
  let isPanning = false;
  let startX = 0;
  let startY = 0;

  // WebSocket
  const wsProtocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  const wsUrl = `${wsProtocol}//${window.location.host}`;
  const socket = new WebSocket(wsUrl);

  socket.onmessage = (event) => {
    try {
      const data = JSON.parse(event.data);
      if (data.type === 'ITEM_PROGRESS') {
        if (isBatchCancelled) return;
        const pct = Math.round((data.index / data.total) * 100);
        progressText.textContent = `Optimizing ${data.index} of ${data.total} — ${data.item.fileName}`;
        progressPercent.textContent = `${pct}%`;
        progressBarFill.style.width = `${pct}%`;

        updateTableRow(data.index - 1, data.item);
      } else if (data.type === 'BATCH_COMPLETE') {
        const s = data.summary;
        isBatchRunning = false;

        if (s.cancelled || isBatchCancelled) {
          progressText.textContent = `Stopped after ${s.processedFiles} of ${s.totalFiles} files.`;
          progressBarFill.style.background = 'var(--danger)';
        } else {
          progressText.textContent = `Finished ${s.processedFiles} of ${s.totalFiles} files.`;
          progressBarFill.style.background = 'var(--good)';
          toast(`Saved ${formatBytes(s.totalSavedBytes)} — ${s.totalSavedPercent}% smaller.`, 'success');
        }

        statOriginal.textContent = formatBytes(s.totalOriginalSize);
        statNew.textContent = formatBytes(s.totalNewSize);
        statSaved.textContent = `${formatBytes(s.totalSavedBytes)} (${s.totalSavedPercent}%)`;
        statsSummary.classList.remove('hidden');

        completedResults = s.results;
        outputDirectoryPath = s.outputDirectory;

        btnDownloadZip.classList.remove('hidden');
        btnStopBatch.classList.add('hidden');
        if (btnPauseBatch) {
          btnPauseBatch.classList.add('hidden');
          setBtnLabel(btnPauseBatch, 'Pause');
          isBatchPaused = false;
        }
        btnProcessBatch.disabled = false;
        setBtnLabel(btnProcessBatch, 'Run again');
      }
    } catch (e) {
      console.error('WS Error:', e);
    }
  };

  function formatBytes(bytes) {
    if (!bytes || bytes === 0) return '0 B';
    const k = 1024;
    const sizes = ['B', 'KB', 'MB', 'GB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
  }

  function escapeHtml(str) {
    return String(str).replace(/[&<>"']/g, ch => (
      { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]
    ));
  }

  // Buttons keep an inline icon, so only the label span is rewritten.
  function setBtnLabel(btn, text) {
    if (!btn) return;
    const label = btn.querySelector('.btn-label');
    if (label) label.textContent = text;
    else btn.textContent = text;
  }

  function toast(message, type = 'info', duration = 5000) {
    const el = document.createElement('div');
    el.className = `toast ${type}`;
    el.setAttribute('role', type === 'error' ? 'alert' : 'status');
    el.textContent = message;
    toastStack.appendChild(el);

    setTimeout(() => {
      el.classList.add('out');
      el.addEventListener('animationend', () => el.remove(), { once: true });
    }, duration);
  }

  // Paints the filled portion of a range input.
  function paintSlider(range) {
    const min = Number(range.min || 0);
    const max = Number(range.max || 100);
    const pct = ((Number(range.value) - min) / (max - min)) * 100;
    range.style.setProperty('--fill', `${pct}%`);
  }

  // Presets
  const presets = {
    'avif-ultra': { format: 'avif', quality: 75, effort: 6, stripMetadata: true, lossless: false },
    'webp-balanced': { format: 'webp', quality: 75, effort: 5, stripMetadata: true, lossless: false },
    'mozjpeg': { format: 'jpeg', quality: 85, effort: 6, stripMetadata: false, lossless: false },
    'png-quant': { format: 'png', quality: 80, effort: 7, stripMetadata: true, lossless: false }
  };

  presetButtons.forEach(btn => {
    btn.addEventListener('click', () => {
      presetButtons.forEach(b => {
        b.classList.remove('active');
        b.setAttribute('aria-checked', 'false');
      });
      btn.classList.add('active');
      btn.setAttribute('aria-checked', 'true');

      const cfg = presets[btn.getAttribute('data-preset')];
      if (cfg) {
        formatSelect.value = cfg.format;
        qualityRange.value = cfg.quality;
        effortRange.value = cfg.effort;
        stripMetadata.checked = cfg.stripMetadata;
        losslessMode.checked = cfg.lossless;
        syncControls();
      }
    });
  });

  // Keeps readouts, slider fills and dependent states in sync with the inputs.
  function syncControls() {
    qualityVal.textContent = qualityRange.value;
    effortVal.textContent = effortRange.value;
    paintSlider(qualityRange);
    paintSlider(effortRange);
    // Quality has no meaning in lossless mode.
    qualityField.classList.toggle('is-disabled', losslessMode.checked);
  }

  qualityRange.addEventListener('input', syncControls);
  effortRange.addEventListener('input', syncControls);
  losslessMode.addEventListener('change', syncControls);
  syncControls();

  // Drag & Drop — the whole workspace accepts drops, so files can still be
  // added once the queue table has replaced the empty state.
  const workspace = document.querySelector('.workspace');
  const isImage = (f) => f.type.startsWith('image/') || /\.(heic|heif|tif|tiff)$/i.test(f.name);

  function setDragState(on) {
    workspace.classList.toggle('drag-active', on);
    dropzone.classList.toggle('dragover', on);
  }

  ['dragenter', 'dragover'].forEach(name => {
    workspace.addEventListener(name, (e) => { e.preventDefault(); setDragState(true); });
  });

  workspace.addEventListener('dragleave', (e) => {
    if (!workspace.contains(e.relatedTarget)) setDragState(false);
  });

  workspace.addEventListener('drop', (e) => {
    e.preventDefault();
    setDragState(false);
    const files = Array.from(e.dataTransfer.files).filter(isImage);
    if (files.length > 0) addFilesToQueue(files);
    else toast('No supported images in that drop.', 'error');
  });

  fileInput.addEventListener('change', () => {
    if (fileInput.files.length > 0) addFilesToQueue(Array.from(fileInput.files));
    fileInput.value = ''; // reset
  });

  folderInput.addEventListener('change', () => {
    const files = Array.from(folderInput.files).filter(f => f.type.startsWith('image/') || f.name.match(/\.(heic|heif|tif|tiff)$/i));
    if (files.length > 0) addFilesToQueue(files);
    folderInput.value = '';
  });

  // Local Folder Scan
  async function scanFolderPath() {
    const pathVal = localFolderPathInput.value.trim();
    if (!pathVal) return toast('Enter a folder path first.', 'error');

    btnScanFolder.disabled = true;
    setBtnLabel(btnScanFolder, 'Scanning…');
    try {
      const res = await fetch('/api/scan-folder', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ folderPath: pathVal })
      });
      const data = await res.json();
      if (data.success) {
        queueLocalFiles = queueLocalFiles.concat(data.files);
        updateWorkspaceView();
        localFolderPathInput.value = '';
        toast(data.files.length
          ? `Added ${data.files.length} image${data.files.length === 1 ? '' : 's'} from ${pathVal}.`
          : `No supported images found in ${pathVal}.`,
          data.files.length ? 'success' : 'info');
      } else {
        toast(data.error, 'error');
      }
    } catch (e) {
      toast('Could not reach the server. Is it still running?', 'error');
    } finally {
      btnScanFolder.disabled = false;
      setBtnLabel(btnScanFolder, 'Scan');
    }
  }

  btnScanFolder.addEventListener('click', scanFolderPath);

  localFolderPathInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      scanFolderPath();
    }
  });

  function addFilesToQueue(files) {
    queueFiles = queueFiles.concat(files);
    updateWorkspaceView();
  }

  btnClearQueue.addEventListener('click', () => {
    queueFiles = [];
    queueLocalFiles = [];
    completedResults = [];
    statsSummary.classList.add('hidden');
    progressBanner.classList.add('hidden');
    btnDownloadZip.classList.add('hidden');
    setBtnLabel(btnProcessBatch, 'Optimize');
    updateWorkspaceView();
  });

  function updateWorkspaceView() {
    const totalCount = queueFiles.length + queueLocalFiles.length;
    fileCountBadge.textContent = totalCount;
    
    if (totalCount === 0) {
      dropzone.classList.remove('hidden');
      resultsSection.classList.add('hidden');
    } else {
      dropzone.classList.add('hidden');
      resultsSection.classList.remove('hidden');
      renderQueueTable();
    }
  }

  function queueRow(idx, name, size, note) {
    const tr = document.createElement('tr');
    tr.id = `row-${idx}`;
    tr.innerHTML = `
      <td class="col-file">
        <span class="file-name" title="${escapeHtml(note || name)}">${escapeHtml(name)}</span>
        ${note ? `<span class="file-note">${escapeHtml(note)}</span>` : ''}
      </td>
      <td class="num">${formatBytes(size)}</td>
      <td class="num">—</td>
      <td class="num">—</td>
      <td><span class="status">Queued</span></td>
      <td class="col-actions">
        <button type="button" class="btn btn-quiet btn-sm" onclick="previewSingle(${idx})">Preview</button>
      </td>
    `;
    return tr;
  }

  function renderQueueTable() {
    fileTableBody.innerHTML = '';
    let rowIdx = 0;

    queueFiles.forEach((file) => {
      fileTableBody.appendChild(queueRow(rowIdx, file.name, file.size, ''));
      rowIdx++;
    });

    queueLocalFiles.forEach((file) => {
      fileTableBody.appendChild(queueRow(rowIdx, file.name, file.size, file.relativePath));
      rowIdx++;
    });
  }

  function updateTableRow(idx, item) {
    const tr = document.getElementById(`row-${idx}`);
    if (!tr) return;

    if (item.error) {
      tr.innerHTML = `
        <td class="col-file">
          <span class="file-name" title="${escapeHtml(item.fileName)}">${escapeHtml(item.fileName)}</span>
          <span class="file-note">${escapeHtml(item.error)}</span>
        </td>
        <td class="num">—</td>
        <td class="num">—</td>
        <td class="num">—</td>
        <td><span class="status error">Failed</span></td>
        <td class="col-actions"></td>
      `;
    } else {
      tr.innerHTML = `
        <td class="col-file">
          <span class="file-name" title="${escapeHtml(item.fileName)}">${escapeHtml(item.fileName)}</span>
          <span class="file-note">${escapeHtml(item.outputName)}</span>
        </td>
        <td class="num">${formatBytes(item.originalSize)}</td>
        <td class="num">${formatBytes(item.newSize)}</td>
        <td class="num"><span class="saved-delta">−${item.savedPercent}%</span></td>
        <td><span class="status done">Done</span></td>
        <td class="col-actions">
          <button type="button" class="btn btn-quiet btn-sm" onclick="showComparisonModal('${item.webUrl}', ${idx})">Compare</button>
        </td>
      `;
    }
  }

  // Batch Process
  btnProcessBatch.addEventListener('click', async () => {
    if (queueFiles.length === 0 && queueLocalFiles.length === 0) return;

    isBatchRunning = true;
    isBatchCancelled = false;
    btnProcessBatch.disabled = true;
    setBtnLabel(btnProcessBatch, 'Optimizing…');
    btnDownloadZip.classList.add('hidden');
    statsSummary.classList.add('hidden');

    btnStopBatch.classList.remove('hidden');
    btnStopBatch.disabled = false;
    setBtnLabel(btnStopBatch, 'Stop');
    if (btnPauseBatch) {
      btnPauseBatch.classList.remove('hidden');
      setBtnLabel(btnPauseBatch, 'Pause');
      isBatchPaused = false;
    }
    progressBanner.classList.remove('hidden');
    progressBarFill.style.background = 'var(--accent)';
    progressText.textContent = 'Starting…';
    progressBarFill.style.width = '0%';

    const formData = new FormData();
    queueFiles.forEach(f => formData.append('files', f));
    formData.append('localFiles', JSON.stringify(queueLocalFiles));

    const options = {
      format: formatSelect.value,
      quality: parseInt(qualityRange.value, 10),
      effort: parseInt(effortRange.value, 10),
      maxWidth: maxWidth.value ? parseInt(maxWidth.value, 10) : null,
      maxHeight: maxHeight.value ? parseInt(maxHeight.value, 10) : null,
      stripMetadata: stripMetadata.checked,
      lossless: losslessMode.checked
    };
    formData.append('options', JSON.stringify(options));

    try {
      const res = await fetch('/api/optimize-batch', { method: 'POST', body: formData });
      if (!res.ok) throw new Error('Network error');
    } catch (err) {
      toast(`Batch failed: ${err.message}`, 'error');
      isBatchRunning = false;
      btnProcessBatch.disabled = false;
      setBtnLabel(btnProcessBatch, 'Optimize');
      progressBanner.classList.add('hidden');
    }
  });

  btnStopBatch.addEventListener('click', async () => {
    isBatchCancelled = true;
    await fetch('/api/cancel-batch', { method: 'POST' });
    setBtnLabel(btnStopBatch, 'Stopping…');
    btnStopBatch.disabled = true;
  });

  if (btnPauseBatch) {
    btnPauseBatch.addEventListener('click', async () => {
      if (!isBatchRunning || isBatchCancelled) return;
      isBatchPaused = !isBatchPaused;
      await fetch('/api/pause-batch', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ paused: isBatchPaused })
      });
      if (isBatchPaused) {
        setBtnLabel(btnPauseBatch, 'Resume');
        progressText.textContent = 'Paused.';
      } else {
        setBtnLabel(btnPauseBatch, 'Pause');
        progressText.textContent = 'Optimizing…';
      }
    });
  }

  btnTestSingleGlobal.addEventListener('click', () => {
    if (queueFiles.length === 0 && queueLocalFiles.length === 0) {
      return toast('Add some files before previewing.', 'error');
    }
    previewSingle(0);
  });

  // Single Test Preview
  window.previewSingle = async function(idx) {
    const isUploaded = idx < queueFiles.length;
    const fileObj = isUploaded ? queueFiles[idx] : null;
    const localObj = !isUploaded ? queueLocalFiles[idx - queueFiles.length] : null;
    if (!fileObj && !localObj) return;

    const formData = new FormData();
    if (fileObj) {
      formData.append('file', fileObj);
      compareOriginalImg.src = URL.createObjectURL(fileObj);
    } else {
      formData.append('localFilePath', localObj.fullPath);
      compareOriginalImg.src = `file://${localObj.fullPath}`;
    }

    const options = {
      format: formatSelect.value,
      quality: parseInt(qualityRange.value, 10),
      effort: parseInt(effortRange.value, 10),
      maxWidth: maxWidth.value ? parseInt(maxWidth.value, 10) : null,
      maxHeight: maxHeight.value ? parseInt(maxHeight.value, 10) : null,
      stripMetadata: stripMetadata.checked,
      lossless: losslessMode.checked
    };
    formData.append('options', JSON.stringify(options));

    try {
      const res = await fetch('/api/preview-comparison', { method: 'POST', body: formData });
      const data = await res.json();
      if (data.success) {
        compareOptimizedImg.src = data.previewUrl;
        compareStatsInfo.innerHTML = renderCompareStats(data);
        resetSlider();
        resetZoom();
        openModal();
      } else toast(`Preview failed: ${data.error}`, 'error');
    } catch (e) {
      console.error(e);
      toast(`Preview failed: ${e.message}`, 'error');
    }
  };

  function renderCompareStats(item) {
    return `
      <span class="stat"><span class="stat-label">Original</span><strong class="stat-value">${formatBytes(item.originalSize)}</strong></span>
      <span class="stat"><span class="stat-label">Optimized</span><strong class="stat-value">${formatBytes(item.newSize)}</strong></span>
      <span class="stat stat-good"><span class="stat-label">Saved</span><strong class="stat-value">${formatBytes(item.savedBytes)} (${item.savedPercent}%)</strong></span>
    `;
  }

  window.showComparisonModal = function(webUrl, idx) {
    const isUploaded = idx < queueFiles.length;
    const fileObj = isUploaded ? queueFiles[idx] : null;
    const localObj = !isUploaded ? queueLocalFiles[idx - queueFiles.length] : null;
    const item = completedResults[idx];

    if (fileObj) compareOriginalImg.src = URL.createObjectURL(fileObj);
    else if (localObj) compareOriginalImg.src = `file://${localObj.fullPath}`;

    compareOptimizedImg.src = webUrl;
    if (item) compareStatsInfo.innerHTML = renderCompareStats(item);
    resetSlider();
    resetZoom();
    openModal();
  };

  function openModal() {
    compareModal.classList.remove('hidden');
    btnCloseModal.focus();
  }

  function closeModal() {
    compareModal.classList.add('hidden');
  }

  btnCloseModal.addEventListener('click', closeModal);

  // Click the backdrop or press Escape to dismiss.
  compareModal.addEventListener('mousedown', (e) => {
    if (e.target === compareModal) closeModal();
  });

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !compareModal.classList.contains('hidden')) closeModal();
  });

  const compareOverlayWrapper = document.getElementById('compareOverlayWrapper');

  // Slider Dragging - Optimized with requestAnimationFrame and overflow wrapper
  let isDraggingSlider = false;
  let sliderRafId = null;

  compareHandle.addEventListener('mousedown', (e) => {
    isDraggingSlider = true;
    e.stopPropagation(); // prevent panning
  });
  window.addEventListener('mouseup', () => {
    isDraggingSlider = false;
    if (sliderRafId) {
      cancelAnimationFrame(sliderRafId);
      sliderRafId = null;
    }
  });

  function setSliderPosition(pct) {
    compareOverlayWrapper.style.width = `${pct}%`;
    compareHandle.style.left = `${pct}%`;
  }

  function resetSlider() {
    setSliderPosition(50);
  }

  // The clipped layer (the original image) must keep the full container width,
  // otherwise it squishes as the wipe wrapper narrows.
  const resizeObserver = new ResizeObserver(entries => {
    for (let entry of entries) {
      zoomLayerOrig.style.width = `${entry.contentRect.width}px`;
    }
  });
  resizeObserver.observe(compareWrapper);

  // Zoom & Pan - Optimized with requestAnimationFrame
  let panRafId = null;

  function updateZoomTransform() {
    const transformStr = `translate3d(${panX}px, ${panY}px, 0) scale(${zoomScale})`;
    zoomLayerOrig.style.transform = transformStr;
    zoomLayerOpt.style.transform = transformStr;
    zoomLevelText.textContent = `${Math.round(zoomScale * 100)}%`;
  }

  function resetZoom() {
    zoomScale = 1.0; panX = 0; panY = 0;
    if (panRafId) { cancelAnimationFrame(panRafId); panRafId = null; }
    updateZoomTransform();
  }

  btnZoomIn.addEventListener('click', () => { zoomScale = Math.min(zoomScale + 0.5, 8.0); updateZoomTransform(); });
  btnZoomOut.addEventListener('click', () => { zoomScale = Math.max(zoomScale - 0.5, 1.0); if(zoomScale===1){panX=0;panY=0;} updateZoomTransform(); });
  btnZoomReset.addEventListener('click', resetZoom);

  compareWrapper.addEventListener('wheel', (e) => {
    e.preventDefault();
    const delta = e.deltaY < 0 ? 0.1 : -0.1;
    zoomScale = Math.min(Math.max(zoomScale + delta, 1.0), 8.0);
    if (zoomScale === 1.0) { panX = 0; panY = 0; }
    updateZoomTransform();
  });

  compareWrapper.addEventListener('mousedown', (e) => {
    if (isDraggingSlider || zoomScale <= 1.0) return;
    isPanning = true;
    startX = e.clientX - panX;
    startY = e.clientY - panY;
  });

  window.addEventListener('mousemove', (e) => {
    // Handle slider dragging
    if (isDraggingSlider) {
      if (!sliderRafId) {
        sliderRafId = requestAnimationFrame(() => {
          const rect = compareSliderOverlay.getBoundingClientRect();
          let x = e.clientX - rect.left;
          x = Math.max(0, Math.min(x, rect.width));
          setSliderPosition((x / rect.width) * 100);
          sliderRafId = null;
        });
      }
      return; // prevent panning while dragging slider
    }

    // Handle panning
    if (!isPanning) return;
    if (!panRafId) {
      panRafId = requestAnimationFrame(() => {
        panX = e.clientX - startX;
        panY = e.clientY - startY;
        updateZoomTransform();
        panRafId = null;
      });
    }
  });
  window.addEventListener('mouseup', () => {
    isPanning = false;
    if (panRafId) {
      cancelAnimationFrame(panRafId);
      panRafId = null;
    }
  });

  btnOpenFinder.addEventListener('click', async () => {
    try {
      const res = await fetch('/api/open-finder', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ folderPath: outputDirectoryPath })
      });
      if (!res.ok) throw new Error('Finder could not open the folder');
    } catch (e) {
      toast(e.message, 'error');
    }
  });

  btnDownloadZip.addEventListener('click', async () => {
    const paths = completedResults.filter(r => r.outputPath).map(r => r.outputPath);
    if (paths.length === 0) return toast('Nothing to download yet.', 'error');

    try {
      const res = await fetch('/api/download-zip', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ files: paths })
      });
      if (!res.ok) throw new Error('The archive could not be created');

      const blob = await res.blob();
      const url = window.URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = 'optimized_images.zip';
      a.click();
      window.URL.revokeObjectURL(url);
    } catch (e) {
      toast(e.message, 'error');
    }
  });
});
