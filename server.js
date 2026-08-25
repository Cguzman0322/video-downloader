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
const activeShrinks = new Map();


function detectPlatform(url) {
  if (/youtube\.com|youtu\.be/i.test(url)) return 'youtube';
  if (/instagram\.com/i.test(url)) return 'instagram';
  if (/tiktok\.com/i.test(url)) return 'tiktok';
  return 'unknown';
}

const UNSUPPORTED_PLATFORMS = new Set();
const DOWNLOAD_TTL_MS = 30 * 60 * 1000;

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
        res.pipe(file);
        res.on('data', (chunk) => { received += chunk.length; });
        file.on('finish', () => resolve({ size: received, total }));
        file.on('error', reject);
        res.on('error', reject);
      }).on('error', reject);
    };
    doGet(options);
  });
}

function extractShortcode(url) {
  const match = url.match(/(?:\/p\/|\/reel\/|\/tv\/)([A-Za-z0-9_-]+)/);
  return match ? match[1] : null;
}

function shortcodeToMediaId(shortcode) {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
  let id = BigInt(0);
  for (const char of shortcode) {
    id = id * BigInt(64) + BigInt(alphabet.indexOf(char));
  }
  return id.toString();
}

function getInstagramCookies(filePath) {
  if (!fs.existsSync(filePath)) return '';
  const content = fs.readFileSync(filePath, 'utf-8');
  const cookies = [];
  for (const line of content.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const parts = trimmed.split('\t');
    if (parts.length < 7) continue;
    const [domain, , , , , name, value] = parts;
    if (domain.includes('instagram.com')) cookies.push(`${name}=${value}`);
  }
  return cookies.join('; ');
}

function instagramApiGet(apiPath, cookieStr) {
  return new Promise((resolve, reject) => {
    const options = {
      hostname: 'www.instagram.com',
      path: apiPath,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0.0.0 Safari/537.36',
        'Accept': '*/*',
        'Cookie': cookieStr,
        'X-IG-App-ID': '936619743392459',
        'X-Requested-With': 'XMLHttpRequest',
      },
    };
    https.get(options, (res) => {
      let data = '';
      res.on('data', (chunk) => data += chunk);
      res.on('end', () => {
        if (res.statusCode !== 200) {
          reject(new Error(`Instagram API returned ${res.statusCode}`));
          return;
        }
        try { resolve(JSON.parse(data)); }
        catch { reject(new Error('Invalid JSON from Instagram API')); }
      });
    }).on('error', reject);
  });
}

function igVideoFormats(versions) {
  if (!versions || versions.length === 0) return [];
  const seen = new Set();
  const fmts = [];
  for (const v of versions) {
    if (v.height && !seen.has(v.height)) {
      seen.add(v.height);
      fmts.push({
        format_id: `ig-${v.height}`,
        ext: 'mp4',
        resolution: `${v.width}x${v.height}`,
        height: v.height,
        filesize: null,
        hasVideo: true,
        hasAudio: true,
        note: '',
        downloadUrl: v.url,
      });
    }
  }
  return fmts.sort((a, b) => b.height - a.height);
}

async function instagramInfo(url) {
  const shortcode = extractShortcode(url);
  if (!shortcode) throw new Error('Could not extract Instagram shortcode from URL');

  const mediaId = shortcodeToMediaId(shortcode);
  const cookieStr = getInstagramCookies(COOKIES_FILE);
  const json = await instagramApiGet(`/api/v1/media/${mediaId}/info/`, cookieStr);

  if (!json.items || json.items.length === 0) throw new Error('No media found for this post');

  const item = json.items[0];
  const user = item.user || {};
  const caption = (item.caption?.text || 'Instagram Post').slice(0, 100);

  if (item.carousel_media && item.carousel_media.length > 1) {
    const carouselItems = item.carousel_media.map((cm, i) => {
      const isVideo = cm.media_type === 2;
      const thumbnail = cm.image_versions2?.candidates?.[0]?.url || null;
      const videoUrl = isVideo ? (cm.video_versions?.[0]?.url || null) : null;
      return {
        index: i + 1,
        thumbnail,
        isVideo,
        downloadUrl: isVideo ? videoUrl : thumbnail,
        duration: isVideo ? Math.round(cm.video_duration || 0) : 0,
        title: `Item ${i + 1}`,
        videoFormats: isVideo ? igVideoFormats(cm.video_versions) : [],
        audioFormats: [],
      };
    });
    return {
      platform: 'instagram',
      isCarousel: true,
      title: caption,
      uploader: user.username || '',
      items: carouselItems,
    };
  }

  const isVideo = item.media_type === 2;
  const thumbnail = item.image_versions2?.candidates?.[0]?.url || null;
  const videoFormats = isVideo ? igVideoFormats(item.video_versions) : [];
  const bestUrl = isVideo ? (item.video_versions?.[0]?.url || null) : thumbnail;

  return {
    platform: 'instagram',
    title: caption,
    thumbnail,
    duration: isVideo ? Math.round(item.video_duration || 0) : 0,
    uploader: user.username || '',
    videoFormats,
    audioFormats: [],
    downloadUrl: bestUrl,
    isImage: !isVideo,
  };
}

function parseFormats(info) {
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

  const videoFormats = formats.filter((f) => f.hasVideo && f.hasAudio).sort((a, b) => b.height - a.height);
  const videoOnlyFormats = formats.filter((f) => f.hasVideo && !f.hasAudio).sort((a, b) => b.height - a.height);
  const audioFormats = formats.filter((f) => !f.hasVideo && f.hasAudio).sort((a, b) => (b.filesize || 0) - (a.filesize || 0));

  const bestQualities = [];
  const seenHeights = new Set();
  for (const f of videoFormats) {
    if (!seenHeights.has(f.height) && f.height > 0) { seenHeights.add(f.height); bestQualities.push(f); }
  }
  for (const f of videoOnlyFormats) {
    if (!seenHeights.has(f.height) && f.height > 0) { seenHeights.add(f.height); bestQualities.push({ ...f, note: f.note + ' (video only)' }); }
  }
  bestQualities.sort((a, b) => b.height - a.height);

  return { videoFormats: bestQualities, audioFormats: audioFormats.slice(0, 5) };
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

  if (platform === 'instagram') {
    try {
      const igInfo = await instagramInfo(url);
      if (igInfo.isCarousel) {
        return res.json(igInfo);
      }
    } catch (e) {
      console.error('Instagram API check:', e.message);
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
      const jsonLines = stdout.trim().split('\n');
      const items = [];
      for (const line of jsonLines) {
        const trimmed = line.trim();
        if (trimmed.startsWith('{')) {
          try { items.push(JSON.parse(trimmed)); } catch {}
        }
      }
      if (items.length === 0) throw new Error('No data parsed');

      if (platform === 'instagram' && items.length > 1) {
        const carouselItems = items.map((info, i) => {
          const { videoFormats, audioFormats } = parseFormats(info);
          const isVideo = (info.duration && info.duration > 0) || videoFormats.length > 0;
          return {
            index: i + 1,
            thumbnail: info.thumbnail || null,
            isVideo,
            duration: info.duration || 0,
            title: info.title || `Item ${i + 1}`,
            videoFormats,
            audioFormats,
          };
        });
        return res.json({
          platform: 'instagram',
          isCarousel: true,
          title: items[0].playlist_title || items[0].title || 'Instagram Post',
          uploader: items[0].uploader || items[0].channel || '',
          items: carouselItems,
        });
      }

      const info = items[0];
      const { videoFormats, audioFormats } = parseFormats(info);

      res.json({
        platform,
        title: info.title || 'Untitled',
        thumbnail: info.thumbnail || null,
        duration: info.duration || 0,
        uploader: info.uploader || info.channel || '',
        videoFormats,
        audioFormats,
      });
    } catch (e) {
      console.error('Parse error:', e);
      res.status(500).json({ error: 'Failed to parse video info' });
    }
  });
});

app.post('/api/download', (req, res) => {
  const { url, formatId, audioOnly, _tikwm, playlistItem, isImage } = req.body;
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
        let title = '';
        if (!info || (!info.play && !info.hdplay)) {
          const result = await tikwmInfo(url);
          info = result._tikwm;
          title = result.title || '';
        }
        if (!title && _tikwm) title = req.body.title || '';
        let downloadUrl;
        if (audioOnly && info.music) downloadUrl = info.music;
        else if (formatId === 'hd' && info.hdplay) downloadUrl = info.hdplay;
        else downloadUrl = info.play || info.hdplay;

        if (!downloadUrl) { dl.status = 'error'; dl.error = 'No download URL found'; return; }

        const ext = audioOnly ? 'mp3' : 'mp4';
        const sanitized = title.replace(/[<>:"/\\|?*\x00-\x1f]/g, '').trim().slice(0, 200);
        const fallback = (url.match(/video\/(\d+)/) || ['', 'tiktok_' + Date.now()])[1];
        const filename = (sanitized || `tiktok_${fallback}`) + `.${ext}`;
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

  if (platform === 'instagram' && req.body.instagramUrl) {
    activeDownloads.set(id, { progress: 0, status: 'downloading', filename: null, error: null });
    res.json({ id });

    (async () => {
      const dl = activeDownloads.get(id);
      try {
        const igUrl = req.body.instagramUrl;
        const isImg = req.body.isImage;
        const ext = isImg ? 'jpg' : 'mp4';
        const title = (req.body.title || 'instagram').replace(/[<>:"/\\|?*\x00-\x1f]/g, '').trim().slice(0, 200);
        const filename = (title || 'instagram_' + Date.now()) + '.' + ext;
        const destPath = path.join(DOWNLOADS_DIR, filename);

        dl.filename = filename;
        dl.progress = 10;

        await tikwmDownload(igUrl, destPath);
        dl.progress = 100;
        dl.status = 'complete';
      } catch (e) {
        dl.status = 'error';
        dl.error = e.message || 'Instagram download failed';
        console.error('Instagram download error:', e.message);
      }
    })();
    return;
  }

  const args = ['--newline', '--progress', '--force-overwrites'];
  if (playlistItem) {
    args.push('--playlist-items', String(playlistItem));
  } else {
    args.push('--no-playlist');
  }
  if (platform === 'instagram' && fs.existsSync(COOKIES_FILE)) {
    args.push('--cookies', COOKIES_FILE);
  }

  if (isImage) {
    // no format or conversion flags for images
  } else if (audioOnly) {
    args.push('-x', '--audio-format', 'mp3');
  } else {
    if (formatId) {
      args.push('-f', `${formatId}+bestaudio/${formatId}/best`);
    } else {
      args.push('-f', 'bestvideo+bestaudio/best');
    }
    args.push('--merge-output-format', 'mp4',
      '--postprocessor-args', 'ffmpeg:-c:v libx264 -preset fast -crf 18 -c:a aac -b:a 192k');
  }

  args.push('-o', path.join(DOWNLOADS_DIR, '%(title)s.%(ext)s'));
  args.push(url);

  console.log('[download] spawning:', YT_DLP, args.join(' '));
  const proc = spawn(YT_DLP, args);

  proc.on('error', (err) => {
    console.error('[spawn error]', err);
    const dl = activeDownloads.get(id);
    if (dl) {
      dl.status = 'error';
      dl.error = err.message || 'Failed to start download';
    }
  });

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

  proc.stderr.on('data', (d) => {
    stderr += d;
    console.error('[yt-dlp]', d.toString().trim());
  });

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

  if (dl.status === 'complete' || dl.status === 'error') {
    setTimeout(() => activeDownloads.delete(req.params.id), DOWNLOAD_TTL_MS);
  }
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

app.post('/api/shrink', (req, res) => {
  const { filename } = req.body;
  if (!filename) return res.status(400).json({ error: 'Filename is required' });
  if (filename.includes('/') || filename.includes('\\') || filename.includes('..'))
    return res.status(400).json({ error: 'Invalid filename' });

  const inputPath = path.join(DOWNLOADS_DIR, filename);
  if (!fs.existsSync(inputPath)) return res.status(404).json({ error: 'File not found' });

  const ext = path.extname(filename);
  const base = path.basename(filename, ext);
  const outputFilename = base + '_shrunk' + ext;
  const outputPath = path.join(DOWNLOADS_DIR, outputFilename);
  const id = crypto.randomBytes(8).toString('hex');
  const originalSize = fs.statSync(inputPath).size;

  execFile('ffprobe', ['-v', 'quiet', '-print_format', 'json', '-show_format', inputPath], (err, stdout) => {
    let totalDuration = 0;
    if (!err) {
      try { totalDuration = parseFloat(JSON.parse(stdout).format.duration) || 0; } catch {}
    }

    activeShrinks.set(id, { progress: 0, status: 'shrinking', filename: outputFilename, originalSize, newSize: null, error: null });
    res.json({ id, originalSize });

    const args = ['-i', inputPath, '-c:v', 'libx264', '-crf', '28', '-preset', 'medium', '-c:a', 'aac', '-b:a', '128k', '-y', '-progress', 'pipe:1', outputPath];
    const proc = spawn('ffmpeg', args);

    proc.stdout.on('data', (data) => {
      const lines = data.toString().split('\n');
      for (const line of lines) {
        const m = line.match(/out_time_us=(\d+)/);
        if (m && totalDuration > 0) {
          const shrink = activeShrinks.get(id);
          if (shrink) shrink.progress = Math.min(99, Math.round((parseInt(m[1]) / 1000000 / totalDuration) * 100));
        }
      }
    });

    proc.stderr.on('data', () => {});

    proc.on('close', (code) => {
      const shrink = activeShrinks.get(id);
      if (!shrink) return;
      if (code === 0 && fs.existsSync(outputPath)) {
        shrink.newSize = fs.statSync(outputPath).size;
        shrink.progress = 100;
        shrink.status = 'complete';
      } else {
        shrink.status = 'error';
        shrink.error = 'Compression failed';
        try { if (fs.existsSync(outputPath)) fs.unlinkSync(outputPath); } catch {}
      }
    });
  });
});

app.get('/api/shrink-progress/:id', (req, res) => {
  const shrink = activeShrinks.get(req.params.id);
  if (!shrink) return res.status(404).json({ error: 'Not found' });
  res.json({ progress: shrink.progress, status: shrink.status, filename: shrink.filename, originalSize: shrink.originalSize, newSize: shrink.newSize, error: shrink.error });
  if (shrink.status === 'complete' || shrink.status === 'error') {
    setTimeout(() => activeShrinks.delete(req.params.id), DOWNLOAD_TTL_MS);
  }
});

const PORT = 3456;
app.listen(PORT, () => {
  console.log(`Video Downloader running at http://localhost:${PORT}`);
});
