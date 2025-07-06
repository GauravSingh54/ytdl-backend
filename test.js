const { spawnSync, spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const readline = require('readline');

const DOWNLOAD_DIR = path.join(__dirname, 'downloads');
if (!fs.existsSync(DOWNLOAD_DIR)) fs.mkdirSync(DOWNLOAD_DIR);

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout,
});

const ask = (q) => new Promise((res) => rl.question(q, res));

(async () => {
  const url = await ask('Enter YouTube URL: ');

  // Step 1: Get format list
  console.log('\n📄 Fetching available formats...\n');
  const formatResult = spawnSync('yt-dlp', ['-F', url], { encoding: 'utf-8' });

  if (formatResult.error) {
    console.error('❌ Error fetching formats:', formatResult.error.message);
    process.exit(1);
  }

  const lines = formatResult.stdout.split('\n');
  const formats = [];

  console.log('📺 Available formats:\n');
  console.log('FormatID | Extension | Resolution/FPS | Size');
  console.log('----------------------------------------------');

  lines.forEach((line) => {
    const match = line.match(/^(\d+|\w+\-\w+)\s+(\w+)\s+(.+?)\s+([\d.]+[KMG]iB)?/);
    if (match) {
      const [, format_id, ext, quality, size] = match;
      formats.push({ format_id, ext, quality, size: size || 'N/A' });
      console.log(`${format_id.padEnd(8)} | ${ext.padEnd(9)} | ${quality.trim().padEnd(18)} | ${size || 'N/A'}`);
    }
  });

  console.log('\n');

  const type = await ask('Download audio or video? (audio/video): ');
  const format_id = type === 'video' ? await ask('Enter format ID from above list: ') : null;
  rl.close();

  const filename = `video_${Date.now()}.${type === 'audio' ? 'mp3' : 'mp4'}`;
  const filepath = path.join(DOWNLOAD_DIR, filename);

  const format = type === 'audio'
    ? ['-f', 'bestaudio', '--extract-audio', '--audio-format', 'mp3', '--audio-quality', '192']
    : ['-f', `${format_id}+bestaudio/best`, '--merge-output-format', 'mp4'];

  const args = [
    url,
    ...format,
    '-o', filepath,
  ];

  console.log(`\n📥 Starting download to: ${filepath}`);
  console.log(`> yt-dlp ${args.join(' ')}`);
  console.log('\n---------------------------\n');

  const ytdlp = spawn('yt-dlp', args);

  ytdlp.stdout.on('data', (data) => {
    const output = data.toString();
    process.stdout.write(output);

    const match = output.match(/\[download\]\s+(\d{1,3}\.\d+)% of\s+([\d.]+\w+) at\s+([\d.]+\w+\/s) ETA\s+(\d{2}:\d{2})/);
    if (match) {
      const [, percent, size, speed, eta] = match;
      const downloaded = ((parseFloat(percent) / 100) * parseFloat(size)).toFixed(2) + size.replace(/[\d.]/g, '');
      console.log(`⬇️  ${percent}% | ${downloaded} / ${size} | Speed: ${speed} | ETA: ${eta}`);
    }
  });

  ytdlp.stderr.on('data', (data) => {
    const err = data.toString();
    console.error('❌ yt-dlp error:', err);
  });

  ytdlp.on('close', (code) => {
    console.log('\n✅ Download finished.');
    console.log(`Saved to: ${filepath}`);
    console.log(`yt-dlp exited with code ${code}`);
  });
})();
