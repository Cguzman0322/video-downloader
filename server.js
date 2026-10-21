const express = require('express');
const { spawn, execFile } = require('child_process');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const https = require('https');

const multer = require('multer');

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public'), { etag: true, maxAge: '1h' }));

const DOWNLOADS_DIR = path.join(__dirname, 'downloads');
const YT_DLP = path.join(__dirname, 'yt-dlp-bin');
const COOKIES_FILE = path.join(__dirname, 'cookies.txt');
const activeDownloads = new Map();
const activeShrinks = new Map();
const activeResizes = new Map();
const activeVolumes = new Map();

function probeVideoCodec(filePath) {
  return new Promise((resolve) => {
    execFile('ffprobe', ['-v', 'error', '-select_streams', 'v:0',
      '-show_entries', 'stream=codec_name', '-of', 'csv=p=0', filePath],
      { timeout: 10000 }, (err, stdout) => {
        resolve(err ? '' : stdout.trim().split('\n')[0]);
      });
  });
}

function autoStripMetadata(filePath) {
  return new Promise((resolve) => {
    if (!fs.existsSync(filePath)) return resolve();
    const ext = path.extname(filePath).toLowerCase();
    const strippable = new Set(['.mp4', '.mov', '.mkv', '.webm', '.avi', '.m4v', '.mp3', '.m4a',
      '.jpg', '.jpeg', '.png', '.tiff', '.tif', '.bmp', '.gif', '.heic', '.heif', '.webp']);
    if (!strippable.has(ext)) return resolve();
    const tmp = filePath + '.tmp_clean' + ext;
    const isVideo = ['.mp4', '.mov', '.mkv', '.webm', '.avi', '.m4v', '.mp3', '.m4a'].includes(ext);

    if (!isVideo) {
      const args = ['-y', '-i', filePath, '-map_metadata', '-1', tmp];
      execFile('ffmpeg', args, { timeout: 120000 }, (err) => {
        if (err || !fs.existsSync(tmp)) {
          try { if (fs.existsSync(tmp)) fs.unlinkSync(tmp); } catch {}
          console.error('[meta-strip] failed for', path.basename(filePath), err?.message || '');
          return resolve();
        }
        try { fs.unlinkSync(filePath); fs.renameSync(tmp, filePath); } catch {}
        console.log('[meta-strip] cleaned', path.basename(filePath));
        resolve();
      });
      return;
    }

    probeVideoCodec(filePath).then((codec) => {
      const needsTranscode = codec && codec !== 'h264' && codec !== 'aac' && codec !== '';
      const args = needsTranscode
        ? ['-y', '-i', filePath, '-map', '0', '-map_metadata', '-1',
           '-c:v', 'libx264', '-crf', '18', '-preset', 'fast', '-pix_fmt', 'yuv420p',
           '-c:a', 'aac', '-b:a', '192k', '-movflags', '+faststart', tmp]
        : ['-y', '-i', filePath, '-map', '0', '-map_metadata', '-1', '-c', 'copy', '-fflags', '+bitexact', tmp];

      if (needsTranscode) console.log('[meta-strip] transcoding', codec, '→ h264 for', path.basename(filePath));

      execFile('ffmpeg', args, { timeout: 300000 }, (err) => {
        if (err || !fs.existsSync(tmp)) {
          try { if (fs.existsSync(tmp)) fs.unlinkSync(tmp); } catch {}
          console.error('[meta-strip] failed for', path.basename(filePath), err?.message || '');
          return resolve();
        }
        try { fs.unlinkSync(filePath); fs.renameSync(tmp, filePath); } catch {}
        console.log('[meta-strip] cleaned', path.basename(filePath));
        resolve();
      });
    });
  });
}


function detectPlatform(url) {
  if (/youtube\.com|youtu\.be/i.test(url)) return 'youtube';
  if (/instagram\.com/i.test(url)) return 'instagram';
  if (/tiktok\.com/i.test(url)) return 'tiktok';
  if (/facebook\.com|fb\.watch|fb\.com/i.test(url)) return 'facebook';
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
    return res.status(400).json({ error: 'Unsupported platform. Use YouTube, TikTok, Instagram, or Facebook URLs.' });
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
  if ((platform === 'instagram' || platform === 'facebook') && fs.existsSync(COOKIES_FILE)) {
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
        dl.progress = 95;
        await autoStripMetadata(destPath);
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
        dl.progress = 95;
        await autoStripMetadata(destPath);
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
  if ((platform === 'instagram' || platform === 'facebook') && fs.existsSync(COOKIES_FILE)) {
    args.push('--cookies', COOKIES_FILE);
  }

  if (isImage) {
    // no format or conversion flags for images
  } else if (audioOnly) {
    args.push('-x', '--audio-format', 'mp3');
  } else {
    if (formatId) {
      args.push('-f', `${formatId}+bestaudio/bestvideo+bestaudio/best`);
    } else {
      args.push('-f', 'bestvideo+bestaudio/best');
    }
    args.push('--merge-output-format', 'mp4');
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

    const mergeMatch = line.match(/\[Merger\].*?Merging.*?into\s*"?(.+?)"?\s*$/);
    if (mergeMatch) {
      dl.filename = path.basename(mergeMatch[1].trim());
    }

    const alreadyMatch = line.match(/\[download\].*?"?(.+?)"? has already been downloaded/);
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

  proc.on('close', async (code) => {
    const dl = activeDownloads.get(id);
    if (!dl) return;

    if (code === 0) {
      if (!dl.filename) {
        const files = fs.readdirSync(DOWNLOADS_DIR)
          .map((f) => ({ name: f, time: fs.statSync(path.join(DOWNLOADS_DIR, f)).mtimeMs }))
          .sort((a, b) => b.time - a.time);
        if (files.length > 0) dl.filename = files[0].name;
      }
      dl.progress = 95;
      if (dl.filename) await autoStripMetadata(path.join(DOWNLOADS_DIR, dl.filename));
      dl.status = 'complete';
      dl.progress = 100;
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

const upload = multer({
  storage: multer.diskStorage({
    destination: DOWNLOADS_DIR,
    filename: (req, file, cb) => {
      const sanitized = file.originalname.replace(/[<>:"/\\|?*\x00-\x1f]/g, '').trim();
      cb(null, sanitized || `upload_${Date.now()}.mp4`);
    },
  }),
  limits: { fileSize: 2 * 1024 * 1024 * 1024 },
});

app.post('/api/upload', upload.single('file'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
  res.json({ filename: req.file.filename, size: req.file.size });
});

function cleanupPassLog(prefix) {
  try {
    const dir = path.dirname(prefix);
    const base = path.basename(prefix);
    fs.readdirSync(dir).filter(f => f.startsWith(base)).forEach(f => {
      try { fs.unlinkSync(path.join(dir, f)); } catch {}
    });
  } catch {}
}

app.post('/api/shrink', (req, res) => {
  const { filename, targetMB } = req.body;
  if (!filename) return res.status(400).json({ error: 'Filename is required' });
  if (filename.includes('/') || filename.includes('\\') || filename.includes('..'))
    return res.status(400).json({ error: 'Invalid filename' });

  const inputPath = path.join(DOWNLOADS_DIR, filename);
  if (!fs.existsSync(inputPath)) return res.status(404).json({ error: 'File not found' });

  const ext = path.extname(filename);
  const base = path.basename(filename, ext);
  const suffix = targetMB ? `_${targetMB}mb` : '_shrunk';
  const outputFilename = base + suffix + ext;
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

    if (targetMB && totalDuration > 0) {
      const targetBytes = targetMB * 0.95 * 1024 * 1024;
      const audioBitrate = 128000;
      const videoBitrate = Math.max(100000, Math.floor((targetBytes * 8 / totalDuration) - audioBitrate));
      const passLogPrefix = path.join(DOWNLOADS_DIR, `.ffmpeg2pass-${id}`);

      const pass1Args = ['-y', '-i', inputPath, '-c:v', 'libx264', '-b:v', String(videoBitrate),
        '-preset', 'medium', '-pix_fmt', 'yuv420p', '-pass', '1', '-passlogfile', passLogPrefix,
        '-an', '-f', 'null', '-progress', 'pipe:1', '/dev/null'];
      const pass1 = spawn('ffmpeg', pass1Args);

      pass1.stdout.on('data', (data) => {
        for (const line of data.toString().split('\n')) {
          const m = line.match(/out_time_us=(\d+)/);
          if (m && totalDuration > 0) {
            const shrink = activeShrinks.get(id);
            if (shrink) shrink.progress = Math.min(49, Math.round((parseInt(m[1]) / 1000000 / totalDuration) * 50));
          }
        }
      });
      pass1.stderr.on('data', () => {});

      pass1.on('close', (code) => {
        if (code !== 0) {
          const shrink = activeShrinks.get(id);
          if (shrink) { shrink.status = 'error'; shrink.error = 'Compression failed (pass 1)'; }
          cleanupPassLog(passLogPrefix);
          return;
        }

        const pass2Args = ['-y', '-i', inputPath, '-c:v', 'libx264', '-b:v', String(videoBitrate),
          '-preset', 'medium', '-pix_fmt', 'yuv420p', '-pass', '2', '-passlogfile', passLogPrefix,
          '-c:a', 'aac', '-b:a', '128k', '-movflags', '+faststart',
          '-progress', 'pipe:1', outputPath];
        const pass2 = spawn('ffmpeg', pass2Args);

        pass2.stdout.on('data', (data) => {
          for (const line of data.toString().split('\n')) {
            const m = line.match(/out_time_us=(\d+)/);
            if (m && totalDuration > 0) {
              const shrink = activeShrinks.get(id);
              if (shrink) shrink.progress = Math.min(99, 50 + Math.round((parseInt(m[1]) / 1000000 / totalDuration) * 50));
            }
          }
        });
        pass2.stderr.on('data', () => {});

        pass2.on('close', (code2) => {
          cleanupPassLog(passLogPrefix);
          const shrink = activeShrinks.get(id);
          if (!shrink) return;
          if (code2 === 0 && fs.existsSync(outputPath)) {
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
    } else {
      const args = ['-i', inputPath, '-c:v', 'libx264', '-crf', '28', '-preset', 'medium',
        '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-b:a', '128k', '-movflags', '+faststart',
        '-y', '-progress', 'pipe:1', outputPath];
      const proc = spawn('ffmpeg', args);

      proc.stdout.on('data', (data) => {
        for (const line of data.toString().split('\n')) {
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
    }
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

const RESIZE_PRESETS = {
  'reels': { w: 1080, h: 1920, label: 'ig_reels' },
  'portrait': { w: 1080, h: 1350, label: 'ig_portrait' },
  'square': { w: 1080, h: 1080, label: 'ig_square' },
  'landscape': { w: 1080, h: 566, label: 'ig_landscape' },
};

app.post('/api/resize', (req, res) => {
  const { filename, preset } = req.body;
  if (!filename) return res.status(400).json({ error: 'Filename is required' });
  if (filename.includes('/') || filename.includes('\\') || filename.includes('..'))
    return res.status(400).json({ error: 'Invalid filename' });

  const p = RESIZE_PRESETS[preset];
  if (!p) return res.status(400).json({ error: 'Invalid preset. Use: reels, portrait, square, landscape' });

  const inputPath = path.join(DOWNLOADS_DIR, filename);
  if (!fs.existsSync(inputPath)) return res.status(404).json({ error: 'File not found' });

  const ext = path.extname(filename);
  const base = path.basename(filename, ext);
  const outputFilename = `${base}_${p.label}${ext}`;
  const outputPath = path.join(DOWNLOADS_DIR, outputFilename);
  const id = crypto.randomBytes(8).toString('hex');

  execFile('ffprobe', ['-v', 'quiet', '-print_format', 'json', '-show_format', '-show_streams', inputPath], (err, stdout) => {
    let totalDuration = 0;
    if (!err) {
      try { totalDuration = parseFloat(JSON.parse(stdout).format.duration) || 0; } catch {}
    }

    activeResizes.set(id, { progress: 0, status: 'resizing', filename: outputFilename, error: null });
    res.json({ id });

    const vf = `split[bg][fg];[bg]scale=${p.w}:${p.h}:force_original_aspect_ratio=increase,crop=${p.w}:${p.h},boxblur=20:5[bg_blur];[fg]scale=${p.w}:${p.h}:force_original_aspect_ratio=decrease,setsar=1[fg_scaled];[bg_blur][fg_scaled]overlay=(W-w)/2:(H-h)/2,setsar=1`;
    const args = ['-y', '-i', inputPath, '-vf', vf,
      '-c:v', 'libx264', '-crf', '18', '-preset', 'medium', '-pix_fmt', 'yuv420p',
      '-c:a', 'aac', '-b:a', '192k', '-movflags', '+faststart',
      '-progress', 'pipe:1', outputPath];

    const proc = spawn('ffmpeg', args);

    proc.stdout.on('data', (data) => {
      for (const line of data.toString().split('\n')) {
        const m = line.match(/out_time_us=(\d+)/);
        if (m && totalDuration > 0) {
          const resize = activeResizes.get(id);
          if (resize) resize.progress = Math.min(99, Math.round((parseInt(m[1]) / 1000000 / totalDuration) * 100));
        }
      }
    });
    proc.stderr.on('data', () => {});

    proc.on('close', (code) => {
      const resize = activeResizes.get(id);
      if (!resize) return;
      if (code === 0 && fs.existsSync(outputPath)) {
        resize.progress = 100;
        resize.status = 'complete';
      } else {
        resize.status = 'error';
        resize.error = 'Resize failed';
        try { if (fs.existsSync(outputPath)) fs.unlinkSync(outputPath); } catch {}
      }
    });
  });
});

app.get('/api/resize-progress/:id', (req, res) => {
  const resize = activeResizes.get(req.params.id);
  if (!resize) return res.status(404).json({ error: 'Not found' });
  res.json({ progress: resize.progress, status: resize.status, filename: resize.filename, error: resize.error });
  if (resize.status === 'complete' || resize.status === 'error') {
    setTimeout(() => activeResizes.delete(req.params.id), DOWNLOAD_TTL_MS);
  }
});

const imageUpload = multer({
  storage: multer.diskStorage({
    destination: DOWNLOADS_DIR,
    filename: (req, file, cb) => {
      const sanitized = file.originalname.replace(/[<>:"/\\|?*\x00-\x1f]/g, '').trim();
      cb(null, `_converting_${Date.now()}_${sanitized || 'image'}`);
    },
  }),
  limits: { fileSize: 200 * 1024 * 1024 },
});

const SUPPORTED_OUTPUT_FORMATS = new Set(['jpeg', 'png', 'tiff', 'gif', 'bmp', 'heic']);

app.post('/api/convert-image', imageUpload.single('file'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file uploaded' });

  const targetFormat = (req.body.format || 'jpeg').toLowerCase();
  if (!SUPPORTED_OUTPUT_FORMATS.has(targetFormat)) {
    try { fs.unlinkSync(req.file.path); } catch {}
    return res.status(400).json({ error: 'Unsupported output format' });
  }

  const inputPath = req.file.path;
  const originalName = req.body.originalName || req.file.originalname || 'image';
  const baseName = path.basename(originalName, path.extname(originalName))
    .replace(/[<>:"/\\|?*\x00-\x1f]/g, '').trim() || 'image';
  const ext = targetFormat === 'jpeg' ? 'jpg' : targetFormat;
  const outputFilename = `${baseName}.${ext}`;
  const outputPath = path.join(DOWNLOADS_DIR, outputFilename);

  execFile('sips', ['-s', 'format', targetFormat, inputPath, '--out', outputPath], (err, stdout, stderr) => {
    try { fs.unlinkSync(inputPath); } catch {}

    if (err) {
      console.error('sips error:', stderr || err.message);
      try { if (fs.existsSync(outputPath)) fs.unlinkSync(outputPath); } catch {}
      return res.status(500).json({ error: 'Conversion failed. Make sure the input is a valid image.' });
    }

    const inputSize = req.file.size;
    const outputSize = fs.existsSync(outputPath) ? fs.statSync(outputPath).size : 0;
    res.json({ filename: outputFilename, inputSize, outputSize });
  });
});

const metaUpload = multer({
  storage: multer.diskStorage({
    destination: DOWNLOADS_DIR,
    filename: (req, file, cb) => {
      const sanitized = file.originalname.replace(/[<>:"/\\|?*\x00-\x1f]/g, '').trim();
      cb(null, `_meta_${Date.now()}_${sanitized || 'file'}`);
    },
  }),
  limits: { fileSize: 2 * 1024 * 1024 * 1024 },
});

app.post('/api/strip-metadata', metaUpload.single('file'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file uploaded' });

  const inputPath = req.file.path;
  const originalName = req.body.originalName || req.file.originalname || 'file';
  const ext = path.extname(originalName).toLowerCase();
  const baseName = path.basename(originalName, path.extname(originalName))
    .replace(/[<>:"/\\|?*\x00-\x1f]/g, '').trim() || 'file';
  const outputFilename = `${baseName}_clean${ext}`;
  const outputPath = path.join(DOWNLOADS_DIR, outputFilename);

  const imageExts = new Set(['.jpg', '.jpeg', '.png', '.tiff', '.tif', '.bmp', '.gif', '.heic', '.heif', '.webp']);
  const videoExts = new Set(['.mp4', '.mov', '.mkv', '.webm', '.avi', '.m4v', '.flv', '.wmv']);

  const isImage = imageExts.has(ext);
  const isVideo = videoExts.has(ext);

  if (!isImage && !isVideo) {
    try { fs.unlinkSync(inputPath); } catch {}
    return res.status(400).json({ error: 'Unsupported file type. Use images or videos.' });
  }

  let args;
  if (isVideo) {
    args = ['-y', '-i', inputPath, '-map', '0', '-map_metadata', '-1',
      '-c', 'copy', '-fflags', '+bitexact', outputPath];
  } else {
    args = ['-y', '-i', inputPath, '-map_metadata', '-1', outputPath];
  }

  execFile('ffmpeg', args, { timeout: 120000 }, (err, stdout, stderr) => {
    try { fs.unlinkSync(inputPath); } catch {}

    if (err) {
      console.error('metadata strip error:', stderr || err.message);
      try { if (fs.existsSync(outputPath)) fs.unlinkSync(outputPath); } catch {}
      return res.status(500).json({ error: 'Failed to remove metadata. Make sure the file is valid.' });
    }

    const inputSize = req.file.size;
    const outputSize = fs.existsSync(outputPath) ? fs.statSync(outputPath).size : 0;
    res.json({ filename: outputFilename, inputSize, outputSize });
  });
});

// ─── SONG ANALYZER ───
const activeCuts = new Map();

app.post('/api/analyze-song', (req, res) => {
  const { filename } = req.body;
  if (!filename) return res.status(400).json({ error: 'Filename is required' });
  if (filename.includes('/') || filename.includes('\\') || filename.includes('..'))
    return res.status(400).json({ error: 'Invalid filename' });

  const inputPath = path.join(DOWNLOADS_DIR, filename);
  if (!fs.existsSync(inputPath)) return res.status(404).json({ error: 'File not found' });

  const scriptPath = path.join(__dirname, 'analyze_song.py');
  const analyzeScript = path.join(__dirname, 'run_analyze.sh');
  execFile(analyzeScript, [inputPath], { timeout: 120000, maxBuffer: 10 * 1024 * 1024, cwd: __dirname }, (err, stdout, stderr) => {
    if (err) {
      console.error('analyze error:', stderr || err.message);
      return res.status(500).json({ error: 'Analysis failed: ' + (stderr || err.message).slice(0, 200) });
    }
    try {
      const result = JSON.parse(stdout);
      res.json(result);
    } catch (e) {
      res.status(500).json({ error: 'Failed to parse analysis output' });
    }
  });
});

app.post('/api/analyze-upload', multer({
  storage: multer.diskStorage({
    destination: DOWNLOADS_DIR,
    filename: (req, file, cb) => {
      const sanitized = file.originalname.replace(/[<>:"/\\|?*\x00-\x1f]/g, '').trim();
      cb(null, sanitized || `upload_${Date.now()}.mp4`);
    },
  }),
  limits: { fileSize: 2 * 1024 * 1024 * 1024 },
}).single('file'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
  res.json({ filename: req.file.filename, size: req.file.size });
});

app.post('/api/cut-section', (req, res) => {
  const { filename, start, end, label } = req.body;
  if (!filename) return res.status(400).json({ error: 'Filename is required' });
  if (filename.includes('/') || filename.includes('\\') || filename.includes('..'))
    return res.status(400).json({ error: 'Invalid filename' });
  if (start == null || end == null) return res.status(400).json({ error: 'Start and end are required' });

  const inputPath = path.join(DOWNLOADS_DIR, filename);
  if (!fs.existsSync(inputPath)) return res.status(404).json({ error: 'File not found' });

  const ext = path.extname(filename);
  const base = path.basename(filename, ext);
  const tag = (label || 'section').toLowerCase().replace(/[^a-z0-9]/g, '_');
  const outputFilename = `${base}_${tag}_${Math.round(start)}s${ext}`;
  const outputPath = path.join(DOWNLOADS_DIR, outputFilename);
  const id = crypto.randomBytes(8).toString('hex');

  const duration = end - start;
  activeCuts.set(id, { progress: 0, status: 'cutting', filename: outputFilename, error: null });
  res.json({ id });

  const args = ['-y', '-ss', String(start), '-t', String(duration), '-i', inputPath,
    '-c:v', 'libx264', '-crf', '18', '-preset', 'fast', '-pix_fmt', 'yuv420p',
    '-c:a', 'aac', '-b:a', '192k', '-movflags', '+faststart',
    '-progress', 'pipe:1', outputPath];

  const proc = spawn('ffmpeg', args);

  proc.stdout.on('data', (data) => {
    for (const line of data.toString().split('\n')) {
      const m = line.match(/out_time_us=(\d+)/);
      if (m && duration > 0) {
        const cut = activeCuts.get(id);
        if (cut) cut.progress = Math.min(99, Math.round((parseInt(m[1]) / 1000000 / duration) * 100));
      }
    }
  });
  proc.stderr.on('data', () => {});

  proc.on('close', (code) => {
    const cut = activeCuts.get(id);
    if (!cut) return;
    if (code === 0 && fs.existsSync(outputPath)) {
      cut.progress = 100;
      cut.status = 'complete';
    } else {
      cut.status = 'error';
      cut.error = 'Cut failed';
      try { if (fs.existsSync(outputPath)) fs.unlinkSync(outputPath); } catch {}
    }
  });
});

app.get('/api/cut-progress/:id', (req, res) => {
  const cut = activeCuts.get(req.params.id);
  if (!cut) return res.status(404).json({ error: 'Not found' });
  res.json({ progress: cut.progress, status: cut.status, filename: cut.filename, error: cut.error });
  if (cut.status === 'complete' || cut.status === 'error') {
    setTimeout(() => activeCuts.delete(req.params.id), 60000);
  }
});

// ─── VOLUME ANALYZER ───

app.post('/api/volume-analyze', (req, res) => {
  const { filename } = req.body;
  if (!filename) return res.status(400).json({ error: 'Filename is required' });
  if (filename.includes('/') || filename.includes('\\') || filename.includes('..'))
    return res.status(400).json({ error: 'Invalid filename' });

  const inputPath = path.join(DOWNLOADS_DIR, filename);
  if (!fs.existsSync(inputPath)) return res.status(404).json({ error: 'File not found' });

  const args = ['-hide_banner', '-i', inputPath, '-af', 'loudnorm=I=-14:TP=-1.5:LRA=11:print_format=json', '-f', 'null', '/dev/null'];
  const proc = spawn('ffmpeg', args);
  let stderr = '';
  proc.stderr.on('data', (d) => stderr += d.toString());
  proc.on('close', () => {
    const lastBrace = stderr.lastIndexOf('{');
    const closeBrace = stderr.lastIndexOf('}');
    if (lastBrace === -1 || closeBrace === -1) {
      const msg = stderr.includes('no audio') || stderr.includes('does not contain') || stderr.includes('Filter audio')
        ? 'File has no audio stream to analyze' : 'Failed to analyze volume';
      return res.status(500).json({ error: msg });
    }
    try {
      const data = JSON.parse(stderr.slice(lastBrace, closeBrace + 1));
      res.json({
        inputLoudness: parseFloat(data.input_i),
        truePeak: parseFloat(data.input_tp),
        loudnessRange: parseFloat(data.input_lra),
        threshold: parseFloat(data.input_thresh),
        targetOffset: parseFloat(data.target_offset),
      });
    } catch {
      res.status(500).json({ error: 'Failed to parse volume analysis' });
    }
  });
});

app.post('/api/volume-normalize', (req, res) => {
  const { filename, targetLUFS } = req.body;
  if (!filename) return res.status(400).json({ error: 'Filename is required' });
  if (filename.includes('/') || filename.includes('\\') || filename.includes('..'))
    return res.status(400).json({ error: 'Invalid filename' });

  const inputPath = path.join(DOWNLOADS_DIR, filename);
  if (!fs.existsSync(inputPath)) return res.status(404).json({ error: 'File not found' });

  const target = targetLUFS || -14;
  const ext = path.extname(filename);
  const base = path.basename(filename, ext);
  const suffix = target === -14 ? '_boosted' : '_boosted_' + Math.abs(target);
  const outputFilename = base + suffix + ext;
  const outputPath = path.join(DOWNLOADS_DIR, outputFilename);
  const id = crypto.randomBytes(8).toString('hex');

  activeVolumes.set(id, { progress: 0, status: 'analyzing', filename: outputFilename, error: null });
  res.json({ id });

  const analyzeArgs = ['-hide_banner', '-i', inputPath, '-af', 'loudnorm=I=' + target + ':TP=-1.5:LRA=11:print_format=json', '-f', 'null', '/dev/null'];
  const analyzeProc = spawn('ffmpeg', analyzeArgs);
  let stderr1 = '';
  analyzeProc.stderr.on('data', (d) => stderr1 += d.toString());
  analyzeProc.on('close', () => {
    const vol = activeVolumes.get(id);
    if (!vol) return;

    const lastBrace = stderr1.lastIndexOf('{');
    const closeBrace = stderr1.lastIndexOf('}');
    if (lastBrace === -1 || closeBrace === -1) { vol.status = 'error'; vol.error = 'Volume analysis failed'; return; }
    let measured;
    try { measured = JSON.parse(stderr1.slice(lastBrace, closeBrace + 1)); } catch { vol.status = 'error'; vol.error = 'Failed to parse analysis'; return; }

    vol.status = 'normalizing';
    vol.progress = 10;

    execFile('ffprobe', ['-v', 'quiet', '-print_format', 'json', '-show_format', inputPath], { timeout: 10000 }, (err, stdout) => {
      let totalDuration = 0;
      if (!err) try { totalDuration = parseFloat(JSON.parse(stdout).format.duration) || 0; } catch {}

      const af = 'loudnorm=I=' + target + ':TP=-1.5:LRA=11:measured_I=' + measured.input_i + ':measured_TP=' + measured.input_tp + ':measured_LRA=' + measured.input_lra + ':measured_thresh=' + measured.input_thresh + ':offset=' + measured.target_offset + ':linear=true';
      const args = ['-y', '-i', inputPath, '-af', af, '-c:v', 'copy', '-c:a', 'aac', '-b:a', '192k', '-movflags', '+faststart', '-progress', 'pipe:1', outputPath];
      const proc = spawn('ffmpeg', args);

      proc.stdout.on('data', (data) => {
        for (const line of data.toString().split('\n')) {
          const m = line.match(/out_time_us=(\d+)/);
          if (m && totalDuration > 0) {
            const v = activeVolumes.get(id);
            if (v) v.progress = Math.min(99, 10 + Math.round((parseInt(m[1]) / 1000000 / totalDuration) * 90));
          }
        }
      });
      proc.stderr.on('data', () => {});

      proc.on('close', (code) => {
        const v = activeVolumes.get(id);
        if (!v) return;
        if (code === 0 && fs.existsSync(outputPath)) {
          v.progress = 100;
          v.status = 'complete';
        } else {
          v.status = 'error';
          v.error = 'Volume normalization failed';
          try { if (fs.existsSync(outputPath)) fs.unlinkSync(outputPath); } catch {}
        }
      });
    });
  });
});

app.get('/api/volume-progress/:id', (req, res) => {
  const vol = activeVolumes.get(req.params.id);
  if (!vol) return res.status(404).json({ error: 'Not found' });
  res.json({ progress: vol.progress, status: vol.status, filename: vol.filename, error: vol.error });
  if (vol.status === 'complete' || vol.status === 'error') {
    setTimeout(() => activeVolumes.delete(req.params.id), DOWNLOAD_TTL_MS);
  }
});

// ─── STREAM (for A/B preview) ───

app.get('/api/stream/:filename', (req, res) => {
  const filename = req.params.filename;
  if (filename.includes('/') || filename.includes('\\') || filename.includes('..'))
    return res.status(400).json({ error: 'Invalid filename' });

  const filePath = path.join(DOWNLOADS_DIR, filename);
  if (!fs.existsSync(filePath)) return res.status(404).json({ error: 'File not found' });

  const stat = fs.statSync(filePath);
  const ext = path.extname(filename).toLowerCase();
  const mimeTypes = { '.mp4': 'video/mp4', '.mp3': 'audio/mpeg', '.wav': 'audio/wav', '.m4a': 'audio/mp4', '.webm': 'video/webm', '.ogg': 'audio/ogg', '.aac': 'audio/aac', '.mov': 'video/quicktime' };
  const contentType = mimeTypes[ext] || 'application/octet-stream';

  const range = req.headers.range;
  if (range) {
    const parts = range.replace(/bytes=/, '').split('-');
    const start = parseInt(parts[0], 10);
    const end = parts[1] ? parseInt(parts[1], 10) : stat.size - 1;
    res.writeHead(206, { 'Content-Range': `bytes ${start}-${end}/${stat.size}`, 'Accept-Ranges': 'bytes', 'Content-Length': end - start + 1, 'Content-Type': contentType });
    fs.createReadStream(filePath, { start, end }).pipe(res);
  } else {
    res.writeHead(200, { 'Content-Length': stat.size, 'Content-Type': contentType, 'Accept-Ranges': 'bytes' });
    fs.createReadStream(filePath).pipe(res);
  }
});

// ─── VOCAL BOOST ───

app.post('/api/vocal-boost', (req, res) => {
  const { filename, intensity } = req.body;
  if (!filename) return res.status(400).json({ error: 'Filename is required' });
  if (filename.includes('/') || filename.includes('\\') || filename.includes('..'))
    return res.status(400).json({ error: 'Invalid filename' });

  const inputPath = path.join(DOWNLOADS_DIR, filename);
  if (!fs.existsSync(inputPath)) return res.status(404).json({ error: 'File not found' });

  const ext = path.extname(filename);
  const base = path.basename(filename, ext);
  const outputFilename = base + '_vocal' + ext;
  const outputPath = path.join(DOWNLOADS_DIR, outputFilename);
  const id = crypto.randomBytes(8).toString('hex');

  let af;
  switch (intensity) {
    case 'light':
      af = 'highpass=f=80,acompressor=threshold=0.08:ratio=2.5:attack=10:release=150:makeup=4:knee=8,equalizer=f=2500:t=q:w=1.5:g=2,alimiter=limit=0.89:attack=3:release=50';
      break;
    case 'heavy':
      af = 'highpass=f=100,acompressor=threshold=0.03:ratio=6:attack=3:release=80:makeup=12:knee=4,equalizer=f=2500:t=q:w=1.5:g=5,equalizer=f=200:t=q:w=1:g=-3,alimiter=limit=0.89:attack=3:release=30';
      break;
    default:
      af = 'highpass=f=80,acompressor=threshold=0.05:ratio=4:attack=5:release=100:makeup=8:knee=6,equalizer=f=2500:t=q:w=1.5:g=3,alimiter=limit=0.89:attack=3:release=50';
  }

  activeVolumes.set(id, { progress: 0, status: 'processing', filename: outputFilename, error: null });
  res.json({ id });

  execFile('ffprobe', ['-v', 'quiet', '-print_format', 'json', '-show_format', inputPath], { timeout: 10000 }, (err, stdout) => {
    let totalDuration = 0;
    if (!err) try { totalDuration = parseFloat(JSON.parse(stdout).format.duration) || 0; } catch {}

    const args = ['-y', '-i', inputPath, '-af', af, '-c:v', 'copy', '-c:a', 'aac', '-b:a', '192k', '-movflags', '+faststart', '-progress', 'pipe:1', outputPath];
    const proc = spawn('ffmpeg', args);

    proc.stdout.on('data', (data) => {
      for (const line of data.toString().split('\n')) {
        const m = line.match(/out_time_us=(\d+)/);
        if (m && totalDuration > 0) {
          const v = activeVolumes.get(id);
          if (v) v.progress = Math.min(99, Math.round((parseInt(m[1]) / 1000000 / totalDuration) * 100));
        }
      }
    });
    proc.stderr.on('data', () => {});

    proc.on('close', (code) => {
      const v = activeVolumes.get(id);
      if (!v) return;
      if (code === 0 && fs.existsSync(outputPath)) {
        v.progress = 100;
        v.status = 'complete';
      } else {
        v.status = 'error';
        v.error = 'Vocal boost failed';
        try { if (fs.existsSync(outputPath)) fs.unlinkSync(outputPath); } catch {}
      }
    });
  });
});

// ─── AI VOCAL (Demucs) ───

const os = require('os');

app.post('/api/ai-vocal', (req, res) => {
  const { filename } = req.body;
  if (!filename) return res.status(400).json({ error: 'Filename is required' });
  if (filename.includes('/') || filename.includes('\\') || filename.includes('..'))
    return res.status(400).json({ error: 'Invalid filename' });

  const inputPath = path.join(DOWNLOADS_DIR, filename);
  if (!fs.existsSync(inputPath)) return res.status(404).json({ error: 'File not found' });

  const ext = path.extname(filename);
  const base = path.basename(filename, ext);
  const outputFilename = base + '_ai_vocal' + ext;
  const outputPath = path.join(DOWNLOADS_DIR, outputFilename);
  const id = crypto.randomBytes(8).toString('hex');
  const tmpDir = path.join(os.tmpdir(), 'demucs_' + id);

  fs.mkdirSync(tmpDir, { recursive: true });
  activeVolumes.set(id, { progress: 0, status: 'extracting', filename: outputFilename, error: null });
  res.json({ id });

  const wavPath = path.join(tmpDir, 'input.wav');
  const extractProc = spawn('ffmpeg', ['-y', '-i', inputPath, '-vn', '-acodec', 'pcm_s16le', '-ar', '44100', '-ac', '2', wavPath]);
  extractProc.stderr.on('data', () => {});

  extractProc.on('close', (code) => {
    const v = activeVolumes.get(id);
    if (!v) return;
    if (code !== 0) { v.status = 'error'; v.error = 'Audio extraction failed'; return; }

    v.progress = 10; v.status = 'separating';

    const demucsProc = spawn('python3', ['-m', 'demucs', '--two-stems', 'vocals', '-n', 'htdemucs', '--out', path.join(tmpDir, 'output'), wavPath]);

    demucsProc.stderr.on('data', (data) => {
      const line = data.toString();
      const m = line.match(/(\d+)%/);
      if (m && v) v.progress = 10 + Math.round(parseInt(m[1]) * 0.6);
    });
    demucsProc.stdout.on('data', () => {});

    demucsProc.on('close', (code2) => {
      if (!activeVolumes.get(id)) return;
      const v2 = activeVolumes.get(id);
      if (code2 !== 0) { v2.status = 'error'; v2.error = 'Vocal separation failed'; return; }

      v2.progress = 75; v2.status = 'remixing';

      const vocalsPath = path.join(tmpDir, 'output', 'htdemucs', 'input', 'vocals.wav');
      const bgPath = path.join(tmpDir, 'output', 'htdemucs', 'input', 'no_vocals.wav');

      if (!fs.existsSync(vocalsPath) || !fs.existsSync(bgPath)) {
        v2.status = 'error'; v2.error = 'Separated stems not found'; return;
      }

      const remixArgs = ['-y', '-i', inputPath, '-i', vocalsPath, '-i', bgPath,
        '-filter_complex',
        '[1:a]acompressor=threshold=0.05:ratio=4:attack=5:release=100:makeup=8:knee=6,equalizer=f=2500:t=q:w=1.5:g=3[boosted_vocals];[boosted_vocals][2:a]amix=inputs=2:duration=first:weights=1 0.7:normalize=0[mixed];[mixed]alimiter=limit=0.89:attack=3:release=50[out]',
        '-map', '0:v', '-map', '[out]', '-c:v', 'copy', '-c:a', 'aac', '-b:a', '192k', '-movflags', '+faststart', outputPath];
      const remixProc = spawn('ffmpeg', remixArgs);

      remixProc.stderr.on('data', () => {});
      remixProc.stdout.on('data', () => {});

      remixProc.on('close', (code3) => {
        const v3 = activeVolumes.get(id);
        if (!v3) return;

        // Clean up temp files
        try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}

        if (code3 === 0 && fs.existsSync(outputPath)) {
          v3.progress = 100; v3.status = 'complete';
        } else {
          v3.status = 'error'; v3.error = 'Remix failed';
          try { if (fs.existsSync(outputPath)) fs.unlinkSync(outputPath); } catch {}
        }
      });
    });
  });
});

const PORT = 3456;
app.listen(PORT, () => {
  console.log(`Video Downloader running at http://localhost:${PORT}`);
});
