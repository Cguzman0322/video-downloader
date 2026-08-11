const express = require('express');
const { spawn, execFile } = require('child_process');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const https = require('https');

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public'), { etag: false, maxAge: 0 }));

const DOWNLOADS_DIR = path.join(__dirname, 'downloads');
const YT_DLP = path.join(__dirname, 'yt-dlp-bin');
const COOKIES_FILE = path.join(__dirname, 'cookies.txt');
const activeDownloads = new Map();


function detectPlatform(url) {
  if (/youtube\.com|youtu\.be/i.test(url)) return 'youtube';
  if (/instagram\.com/i.test(url)) return 'instagram';
  if (/tiktok\.com/i.test(url)) return 'tiktok';
  return 'unknown';
}

const UNSUPPORTED_PLATFORMS = new Set();

function httpsGet(url) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const options = {
      hostname: parsed.hostname,
      path: parsed.pathname + parsed.search,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0.0.0 Safari/537.36',
        'Accept': 'application/json',
      },
    };
    https.get(options, (res) => {
      let data = '';
      res.on('data', (chunk) => (data += chunk));
      res.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch { reject(new Error('Invalid JSON response')); }
      });
    }).on('error', reject);
  });
}

async function tikwmInfo(url) {
  const encoded = encodeURIComponent(url);
  const data = await httpsGet(`https://www.tikwm.com/api/?url=${encoded}&hd=1`);
  if (data.code !== 0 || !data.data) throw new Error(data.msg || 'TikWM API failed');
  const d = data.data;
  const formats = [];
  if (d.hdplay) formats.push({ format_id: 'hd', ext: 'mp4', resolution: '1080p', height: 1080, filesize: d.hd_size || null, hasVideo: true, hasAudio: true, note: 'HD' });
  if (d.play) formats.push({ format_id: 'sd', ext: 'mp4', resolution: '720p', height: 720, filesize: d.size || null, hasVideo: true, hasAudio: true, note: 'SD' });
  return {
    platform: 'tiktok',
    title: d.title || 'TikTok Video',
    thumbnail: d.cover || d.origin_cover || null,
    duration: d.duration || 0,
    uploader: d.author?.nickname || d.author?.unique_id || '',
    videoFormats: formats,
    audioFormats: d.music ? [{ format_id: 'audio', ext: 'mp3', hasVideo: false, hasAudio: true }] : [],
    _tikwm: { play: d.play, hdplay: d.hdplay, music: d.music },
  };
}

async function tikwmDownload(downloadUrl, destPath) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(downloadUrl);
    const options = {
      hostname: parsed.hostname,
      path: parsed.pathname + parsed.search,
      headers: { 'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36' },
    };
    const doGet = (opts) => {
      https.get(opts, (res) => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          const redir = new URL(res.headers.location);
          doGet({ hostname: redir.hostname, path: redir.pathname + redir.search, headers: opts.headers });
          return;
        }
        if (res.statusCode !== 200) { reject(new Error('Download HTTP ' + res.statusCode)); return; }
        const total = parseInt(res.headers['content-length'], 10) || 0;
        let received = 0;
        const file = fs.createWriteStream(destPath);
        res.on('data', (chunk) => { received += chunk.length; file.write(chunk); });
        res.on('end', () => { file.end(); resolve({ size: received, total }); });
        res.on('error', reject);
      }).on('error', reject);
    };
    doGet(options);
  });
}

app.post('/api/info', async (req, res) => {
  const { url } = req.body;
  if (!url) return res.status(400).json({ error: 'URL is required' });

  const platform = detectPlatform(url);
  if (platform === 'unknown') {
    return res.status(400).json({ error: 'Unsupported platform. Use YouTube, TikTok, or Instagram URLs.' });
  }
  if (UNSUPPORTED_PLATFORMS.has(platform)) {
    return res.status(400).json({ error: 'This platform is not currently supported.' });
  }

  if (platform === 'tiktok') {
    try {
      const info = await tikwmInfo(url);
      return res.json(info);
    } catch (e) {
      console.error('TikWM fallback error:', e.message);
      return res.status(500).json({ error: 'Failed to fetch TikTok video. Check the URL.' });
    }
  }

  const args = ['--dump-json', '--no-playlist'];
  if (platform === 'instagram' && fs.existsSync(COOKIES_FILE)) {
    args.push('--cookies', COOKIES_FILE);
  }
  args.push(url);
  const proc = spawn(YT_DLP, args);

  let stdout = '';
  let stderr = '';

  proc.stdout.on('data', (d) => (stdout += d));
  proc.stderr.on('data', (d) => (stderr += d));

  proc.on('close', (code) => {
    if (code !== 0) {
      console.error('yt-dlp info error:', stderr);
      const msg = stderr.includes('is not a valid URL') || stderr.includes('Unsupported URL')
        ? 'Unsupported or invalid URL. Try a YouTube, TikTok, or Instagram link.'
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
  const { url, formatId, audioOnly, _tikwm } = req.body;
  if (!url) return res.status(400).json({ error: 'URL is required' });

  const platform = detectPlatform(url);
  const id = crypto.randomBytes(8).toString('hex');

  if (platform === 'tiktok') {
    activeDownloads.set(id, { progress: 0, status: 'downloading', filename: null, error: null });
    res.json({ id });

    (async () => {
      const dl = activeDownloads.get(id);
      try {
        let info = _tikwm;
        if (!info || (!info.play && !info.hdplay)) {
          const result = await tikwmInfo(url);
          info = result._tikwm;
        }
        let downloadUrl;
        if (audioOnly && info.music) downloadUrl = info.music;
        else if (formatId === 'hd' && info.hdplay) downloadUrl = info.hdplay;
        else downloadUrl = info.play || info.hdplay;

        if (!downloadUrl) { dl.status = 'error'; dl.error = 'No download URL found'; return; }

        const ext = audioOnly ? 'mp3' : 'mp4';
        const safeName = (url.match(/video\/(\d+)/) || ['', 'tiktok_' + Date.now()])[1];
        const filename = `tiktok_${safeName}.${ext}`;
        const destPath = path.join(DOWNLOADS_DIR, filename);

        dl.filename = filename;
        dl.progress = 10;

        await tikwmDownload(downloadUrl, destPath);
        dl.progress = 100;
        dl.status = 'complete';
      } catch (e) {
        dl.status = 'error';
        dl.error = e.message || 'TikTok download failed';
        console.error('TikTok download error:', e.message);
      }
    })();
    return;
  }

  const args = ['--no-playlist', '--newline', '--progress'];
  if (platform === 'instagram' && fs.existsSync(COOKIES_FILE)) {
    args.push('--cookies', COOKIES_FILE);
  }

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
