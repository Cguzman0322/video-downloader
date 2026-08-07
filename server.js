const express = require('express');
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public'), { etag: false, maxAge: 0 }));

const DOWNLOADS_DIR = path.join(__dirname, 'downloads');
const YT_DLP = '/opt/homebrew/bin/yt-dlp';

const activeDownloads = new Map();

function detectPlatform(url) {
  if (/youtube\.com|youtu\.be/i.test(url)) return 'youtube';
  if (/instagram\.com/i.test(url)) return 'instagram';
  if (/tiktok\.com/i.test(url)) return 'tiktok';
  return 'unknown';
}

const UNSUPPORTED_PLATFORMS = new Set(['instagram']);

app.post('/api/info', async (req, res) => {
  const { url } = req.body;
  if (!url) return res.status(400).json({ error: 'URL is required' });

  const platform = detectPlatform(url);
  if (platform === 'unknown') {
    return res.status(400).json({ error: 'Unsupported platform. Use YouTube or TikTok URLs.' });
  }
  if (UNSUPPORTED_PLATFORMS.has(platform)) {
    return res.status(400).json({ error: 'Instagram is not supported due to platform restrictions.' });
  }

  const args = ['--dump-json', '--no-playlist', url];
  const proc = spawn(YT_DLP, args);

  let stdout = '';
  let stderr = '';

  proc.stdout.on('data', (d) => (stdout += d));
  proc.stderr.on('data', (d) => (stderr += d));

  proc.on('close', (code) => {
    if (code !== 0) {
      console.error('yt-dlp info error:', stderr);
      const msg = stderr.includes('is not a valid URL') || stderr.includes('Unsupported URL')
        ? 'Unsupported or invalid URL. Try a YouTube, Instagram, or TikTok link.'
        : stderr.includes('Private video') || stderr.includes('Sign in')
        ? 'This video is private or requires sign-in.'
        : stderr.includes('Video unavailable')
        ? 'This video is unavailable.'
        : 'Failed to fetch video info. Check the URL.';
      return res.status(500).json({ error: msg });
    }

    try {
      const info = JSON.parse(stdout);

      const formats = (info.formats || [])
        .filter((f) => f.vcodec !== 'none' || f.acodec !== 'none')
        .map((f) => ({
          format_id: f.format_id,
          ext: f.ext,
          resolution: f.resolution || (f.height ? `${f.width}x${f.height}` : 'audio only'),
          height: f.height || 0,
          filesize: f.filesize || f.filesize_approx || null,
          fps: f.fps || null,
          vcodec: f.vcodec,
          acodec: f.acodec,
          hasVideo: f.vcodec !== 'none',
          hasAudio: f.acodec !== 'none',
          note: f.format_note || '',
        }));

      const videoFormats = formats
        .filter((f) => f.hasVideo && f.hasAudio)
        .sort((a, b) => b.height - a.height);

      const videoOnlyFormats = formats
        .filter((f) => f.hasVideo && !f.hasAudio)
        .sort((a, b) => b.height - a.height);

      const audioFormats = formats
        .filter((f) => !f.hasVideo && f.hasAudio)
        .sort((a, b) => (b.filesize || 0) - (a.filesize || 0));

      const bestQualities = [];
      const seenHeights = new Set();

      for (const f of videoFormats) {
        if (!seenHeights.has(f.height) && f.height > 0) {
          seenHeights.add(f.height);
          bestQualities.push(f);
        }
      }

      for (const f of videoOnlyFormats) {
        if (!seenHeights.has(f.height) && f.height > 0) {
          seenHeights.add(f.height);
          bestQualities.push({ ...f, note: f.note + ' (video only)' });
        }
      }

      bestQualities.sort((a, b) => b.height - a.height);

      res.json({
        platform,
        title: info.title || 'Untitled',
        thumbnail: info.thumbnail || null,
        duration: info.duration || 0,
        uploader: info.uploader || info.channel || '',
        videoFormats: bestQualities,
        audioFormats: audioFormats.slice(0, 5),
      });
    } catch (e) {
      console.error('Parse error:', e);
      res.status(500).json({ error: 'Failed to parse video info' });
    }
  });
});

app.post('/api/download', (req, res) => {
  const { url, formatId, audioOnly } = req.body;
  if (!url) return res.status(400).json({ error: 'URL is required' });

  const id = crypto.randomBytes(8).toString('hex');

  const args = ['--no-playlist', '--newline', '--progress'];

  if (audioOnly) {
    args.push('-x', '--audio-format', 'mp3');
  } else if (formatId) {
    args.push('-f', formatId);
  } else {
    args.push('-f', 'best');
  }

  args.push('-o', path.join(DOWNLOADS_DIR, '%(title)s.%(ext)s'));
  args.push(url);

  const proc = spawn(YT_DLP, args);

  activeDownloads.set(id, {
    proc,
    progress: 0,
    status: 'downloading',
    filename: null,
    error: null,
  });

  let stderr = '';

  proc.stdout.on('data', (data) => {
    const line = data.toString();
    const dl = activeDownloads.get(id);
    if (!dl) return;

    const pctMatch = line.match(/(\d+\.?\d*)%/);
    if (pctMatch) {
      dl.progress = parseFloat(pctMatch[1]);
    }

    const destMatch = line.match(/Destination:\s*(.+)/);
    if (destMatch) {
      dl.filename = path.basename(destMatch[1].trim());
    }

    const mergeMatch = line.match(/\[Merger\].*?Merging.*?into\s*(.+)/);
    if (mergeMatch) {
      dl.filename = path.basename(mergeMatch[1].trim());
    }

    const alreadyMatch = line.match(/\[download\].*?(.+?) has already been downloaded/);
    if (alreadyMatch) {
      dl.filename = path.basename(alreadyMatch[1].trim());
      dl.progress = 100;
      dl.status = 'complete';
    }
  });

  proc.stderr.on('data', (d) => (stderr += d));

  proc.on('close', (code) => {
    const dl = activeDownloads.get(id);
    if (!dl) return;

    if (code === 0) {
      dl.status = 'complete';
      dl.progress = 100;

      if (!dl.filename) {
        const files = fs.readdirSync(DOWNLOADS_DIR)
          .map((f) => ({ name: f, time: fs.statSync(path.join(DOWNLOADS_DIR, f)).mtimeMs }))
          .sort((a, b) => b.time - a.time);
        if (files.length > 0) dl.filename = files[0].name;
      }
    } else {
      dl.status = 'error';
      dl.error = stderr || 'Download failed';
      console.error('Download error:', stderr);
    }
  });

  res.json({ id });
});

app.get('/api/progress/:id', (req, res) => {
  const dl = activeDownloads.get(req.params.id);
  if (!dl) return res.status(404).json({ error: 'Download not found' });

  res.json({
    progress: dl.progress,
    status: dl.status,
    filename: dl.filename,
    error: dl.error,
  });
});

app.get('/api/downloads', (req, res) => {
  try {
    const files = fs.readdirSync(DOWNLOADS_DIR)
      .filter((f) => !f.startsWith('.'))
      .map((f) => {
        const stat = fs.statSync(path.join(DOWNLOADS_DIR, f));
        return {
          name: f,
          size: stat.size,
          date: stat.mtime,
        };
      })
      .sort((a, b) => new Date(b.date) - new Date(a.date));

    res.json(files);
  } catch {
    res.json([]);
  }
});

app.get('/api/open-downloads', (req, res) => {
  spawn('open', [DOWNLOADS_DIR]);
  res.json({ ok: true });
});

const PORT = 3456;
app.listen(PORT, () => {
  console.log(`Video Downloader running at http://localhost:${PORT}`);
});
