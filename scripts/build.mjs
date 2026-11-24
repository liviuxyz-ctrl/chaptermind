import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';
import esbuild from 'esbuild';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, '..');
const distDir = path.join(rootDir, 'dist');

function crc32(buf) {
  let crc = 0xffffffff;
  for (let i = 0; i < buf.length; i++) {
    crc ^= buf[i];
    for (let j = 0; j < 8; j++) {
      crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function pngChunk(type, data) {
  const typeBuf = Buffer.from(type, 'ascii');
  const lenBuf = Buffer.alloc(4);
  lenBuf.writeUInt32BE(data.length, 0);
  const crcInput = Buffer.concat([typeBuf, data]);
  const crcBuf = Buffer.alloc(4);
  crcBuf.writeUInt32BE(crc32(crcInput), 0);
  return Buffer.concat([lenBuf, typeBuf, data, crcBuf]);
}

function createIconPng(size) {
  const width = size;
  const height = size;
  const raw = Buffer.alloc((width * 4 + 1) * height);

  const radius = size * 0.22;
  const cx = size / 2;
  const cy = size / 2;

  for (let y = 0; y < height; y++) {
    const rowStart = y * (width * 4 + 1);
    raw[rowStart] = 0; // filter type 0
    for (let x = 0; x < width; x++) {
      const px = rowStart + 1 + x * 4;
      // Signed distance to rounded rect
      const dx = Math.max(Math.abs(x + 0.5 - cx) - (width / 2 - radius), 0);
      const dy = Math.max(Math.abs(y + 0.5 - cy) - (height / 2 - radius), 0);
      const dist = Math.hypot(dx, dy) - radius;

      if (dist > 0.7) {
        raw[px] = 0;
        raw[px + 1] = 0;
        raw[px + 2] = 0;
        raw[px + 3] = 0;
        continue;
      }

      // Base gradient dark slate -> deep teal
      const t = (x + y) / (width + height);
      let r = Math.round(15 + t * 12);
      let g = Math.round(20 + t * 24);
      let b = Math.round(32 + t * 28);
      const alpha = dist > -0.3 ? Math.round(255 * Math.max(0, 0.7 - dist)) : 255;

      // Subtle emerald chapter bar along the bottom
      const barTop = size * 0.76;
      const barBottom = size * 0.84;
      const barLeft = size * 0.18;
      const barRight = size * 0.82;
      if (y >= barTop && y <= barBottom && x >= barLeft && x <= barRight) {
        const segX = (x - barLeft) / (barRight - barLeft);
        if (segX > 0.34 && segX < 0.48) {
          // SponsorBlock green segment
          r = 0;
          g = 212;
          b = 110;
        } else {
          // Cyan chapter bar
          r = 56;
          g = 189;
          b = 248;
        }
      }

      // Play triangle in center-upper area
      const tx0 = size * 0.34;
      const tx1 = size * 0.70;
      const tyMid = size * 0.44;
      const tHalfH = size * 0.22;
      if (x >= tx0 && x <= tx1) {
        const frac = (x - tx0) / (tx1 - tx0);
        const halfSpan = tHalfH * (1 - frac);
        if (Math.abs(y + 0.5 - tyMid) <= halfSpan) {
          r = 16;
          g = 225;
          b = 158;
        }
      }

      raw[px] = r;
      raw[px + 1] = g;
      raw[px + 2] = b;
      raw[px + 3] = alpha;
    }
  }

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;

  const idat = zlib.deflateSync(raw);
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', idat),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}

async function build() {
  fs.rmSync(distDir, { recursive: true, force: true });
  fs.mkdirSync(path.join(distDir, 'icons'), { recursive: true });

  for (const size of [16, 48, 128]) {
    fs.writeFileSync(path.join(distDir, 'icons', `icon${size}.png`), createIconPng(size));
  }

  const common = {
    bundle: true,
    sourcemap: false,
    minify: false,
    target: ['chrome120'],
    logLevel: 'info',
  };

  await Promise.all([
    esbuild.build({
      ...common,
      entryPoints: [path.join(rootDir, 'src/background/index.ts')],
      outfile: path.join(distDir, 'background.js'),
      format: 'esm',
    }),
    esbuild.build({
      ...common,
      entryPoints: [path.join(rootDir, 'src/content/main-world.ts')],
      outfile: path.join(distDir, 'content-main.js'),
      format: 'iife',
    }),
    esbuild.build({
      ...common,
      entryPoints: [path.join(rootDir, 'src/content/youtube-content.ts')],
      outfile: path.join(distDir, 'content-youtube.js'),
      format: 'iife',
    }),
    esbuild.build({
      ...common,
      entryPoints: [path.join(rootDir, 'src/content/ai-bridge.ts')],
      outfile: path.join(distDir, 'content-ai-bridge.js'),
      format: 'iife',
    }),
    esbuild.build({
      ...common,
      entryPoints: [path.join(rootDir, 'src/sidepanel/main.ts')],
      outfile: path.join(distDir, 'sidepanel.js'),
      format: 'iife',
    }),
  ]);

  fs.copyFileSync(path.join(rootDir, 'manifest.json'), path.join(distDir, 'manifest.json'));
  fs.copyFileSync(
    path.join(rootDir, 'src/sidepanel/sidepanel.html'),
    path.join(distDir, 'sidepanel.html')
  );
  fs.copyFileSync(
    path.join(rootDir, 'src/sidepanel/sidepanel.css'),
    path.join(distDir, 'sidepanel.css')
  );

  // Verify all files referenced by dist/manifest.json exist
  const manifest = JSON.parse(fs.readFileSync(path.join(distDir, 'manifest.json'), 'utf8'));
  const requiredPaths = [
    manifest.background?.service_worker,
    manifest.side_panel?.default_path,
    ...Object.values(manifest.icons || {}),
    ...Object.values(manifest.action?.default_icon || {}),
    ...(manifest.content_scripts || []).flatMap((cs) => cs.js || []),
  ].filter(Boolean);

  for (const rel of requiredPaths) {
    const abs = path.join(distDir, rel);
    if (!fs.existsSync(abs)) {
      throw new Error(`Missing build output referenced by manifest.json: ${rel}`);
    }
  }

  console.log(`Build verified: ${requiredPaths.length} manifest assets present in dist/`);
}

build().catch((err) => {
  console.error(err);
  process.exit(1);
});
