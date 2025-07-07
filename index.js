const express = require("express");
const http = require("http");
const cors = require("cors");
const { Server } = require("socket.io");
const { spawn, spawnSync } = require("child_process");
const path = require("path");
const fs = require("fs");

const YTDLP_PATH = path.join(__dirname, "bin", "yt-dlp");
const FFMPEG_LOCATION = process.env.FFMPEG_LOCATION;
const COOKIE_B64 = process.env.COOKIE_B64 || "";
const COOKIE_DIR = path.join(__dirname, "secrets");
const COOKIE_FILE = path.join(COOKIE_DIR, "youtube-cookies.txt");

// Decode and write cookie file
if (COOKIE_B64) {
  fs.mkdirSync(COOKIE_DIR, { recursive: true });
  fs.writeFileSync(COOKIE_FILE, Buffer.from(COOKIE_B64, "base64").toString("utf-8"));
  console.log("✅ Cookie file created from base64.");
} else {
  console.warn("⚠️ COOKIE_B64 not found. Some YouTube videos may require it.");
}

if (!FFMPEG_LOCATION) {
  console.warn("⚠️ FFMPEG_LOCATION not set. yt-dlp may warn/fail.");
} else {
  console.log("✅ FFMPEG location set:", FFMPEG_LOCATION);
}

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*" } });

const DOWNLOAD_DIR = path.join(__dirname, "downloads");
if (!fs.existsSync(DOWNLOAD_DIR)) fs.mkdirSync(DOWNLOAD_DIR);

app.use(cors());
app.use(express.json());
app.use(express.static(DOWNLOAD_DIR));

// Auto-delete after 2 hours
const scheduleFileDeletion = (filepath) => {
  setTimeout(() => {
    if (fs.existsSync(filepath)) {
      try {
        fs.unlinkSync(filepath);
        console.log(`🗑️ Deleted ${filepath}`);
      } catch (err) {
        console.error("❌ Failed to delete:", err.message);
      }
    }
  }, 2 * 60 * 60 * 1000);
};

// yt-dlp base args
const buildYtDlpArgs = (url, extraArgs = []) => [
  "--cookies", COOKIE_FILE,
  ...(FFMPEG_LOCATION ? ["--ffmpeg-location", FFMPEG_LOCATION] : []),
  ...extraArgs,
  url,
];

// Socket.io handlers
io.on("connection", (socket) => {
  console.log("✅ Client connected");

  socket.on("get-formats", (url) => {
    const result = spawnSync(YTDLP_PATH, buildYtDlpArgs(url, ["-J"]), { encoding: "utf-8" });

    if (result.error) {
      console.error("❌ yt-dlp spawn error:", result.error.message);
      socket.emit("status", "❌ Failed to fetch formats.");
      socket.emit("formats", []);
      return;
    }

    try {
      const info = JSON.parse(result.stdout);
      const formats = info.formats || [];

      const audioOnly = formats.filter(f => f.vcodec === "none" && f.acodec !== "none");

      socket.emit("formats", { audioOnly });
    } catch (e) {
      console.error("❌ Parsing error:", e.message);
      socket.emit("status", "❌ Could not parse formats.");
      socket.emit("formats", []);
    }
  });

  socket.on("start-download", ({ url, format_id, type }) => {
    const outputTemplate = path.join(DOWNLOAD_DIR, "%(title)s.%(ext)s");

    let args = [];
    if (type === "audio") {
      args = buildYtDlpArgs(url, [
        "-f", format_id,
        "--extract-audio",
        "--audio-format", "mp3",
        "--audio-quality", "192",
        "-o", outputTemplate
      ]);
    } else if (type === "video") {
      args = buildYtDlpArgs(url, [
        "-f", "bv*+ba/best",
        "-o", outputTemplate
      ]);
    } else {
      socket.emit("status", "❌ Invalid download type.");
      return;
    }

    const ytdlp = spawn(YTDLP_PATH, args);

    ytdlp.stdout.on("data", (data) => {
      const output = data.toString();
      if (output.includes("Downloading webpage")) socket.emit("status", "📄 Downloading webpage...");
      if (output.includes("Destination:")) socket.emit("status", "⬇️ Starting download...");

      const match = output.match(/\[download\]\s+(\d{1,3}\.\d+)% of\s+([\d.]+\w+) at\s+([\d.]+\w+\/s)/);
      if (match) {
        const [, percent, size, speed] = match;
        socket.emit("progress", {
          percent: parseFloat(percent),
          size,
          speed,
          downloaded: ((parseFloat(percent) / 100) * parseFloat(size)).toFixed(2) + size.replace(/[\d.]/g, "")
        });
      }
    });

    ytdlp.stderr.on("data", (data) => {
      const error = data.toString().trim();
      if (error) {
        console.warn("⚠️ yt-dlp stderr:", error);
        socket.emit("status", error);
      }
    });

    ytdlp.on("close", () => {
      const files = fs.readdirSync(DOWNLOAD_DIR)
        .map(name => ({
          name,
          time: fs.statSync(path.join(DOWNLOAD_DIR, name)).mtime.getTime(),
          path: path.join(DOWNLOAD_DIR, name),
        }))
        .filter(f => f.name.endsWith(".mp4") || f.name.endsWith(".mp3"))
        .sort((a, b) => b.time - a.time);

      if (files.length) {
        const finalFile = files[0].path;
        const filename = path.basename(finalFile);
        console.log("✅ Download complete:", filename);
        socket.emit("complete", { filename });
        scheduleFileDeletion(finalFile);
      } else {
        socket.emit("status", "❌ Download failed. File not found.");
      }
    });
  });
});

// Serve file
app.get("/download/:filename", (req, res) => {
  const file = path.join(DOWNLOAD_DIR, req.params.filename);
  if (fs.existsSync(file)) res.download(file);
  else res.status(404).send("❌ File not found.");
});

const PORT = process.env.PORT || 7350;
server.listen(PORT, () => {
  console.log(`🚀 Server running at http://localhost:${PORT}`);
});
