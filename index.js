const express = require("express");
const http = require("http");
const cors = require("cors");
const { Server } = require("socket.io");
const { spawn, spawnSync } = require("child_process");
const path = require("path");
const fs = require("fs");
require("dotenv").config();

const YTDLP_PATH = path.join(__dirname, "bin", "yt-dlp");
const COOKIE_B64 = process.env.COOKIE_B64 || "";
const COOKIE_DIR = path.join(__dirname, "secrets");
const COOKIE_FILE = path.join(COOKIE_DIR, "youtube-cookies.txt");

if (COOKIE_B64) {
  fs.mkdirSync(COOKIE_DIR, { recursive: true });
  fs.writeFileSync(COOKIE_FILE, Buffer.from(COOKIE_B64, "base64").toString("utf-8"));
  console.log("✅ Cookie file created from base64.");
} else {
  console.warn("⚠️ COOKIE_B64 not found. Some YouTube videos may require it.");
}

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: "*" },
});

const DOWNLOAD_DIR = path.join(__dirname, "downloads");
if (!fs.existsSync(DOWNLOAD_DIR)) fs.mkdirSync(DOWNLOAD_DIR);

app.use(cors());
app.use(express.json());
app.use(express.static(DOWNLOAD_DIR));

const scheduleFileDeletion = (filepath) => {
  setTimeout(() => {
    if (fs.existsSync(filepath)) {
      try {
        fs.unlinkSync(filepath);
        console.log(`🗑️ Deleted ${filepath}`);
      } catch (err) {
        console.error("❌ Failed to delete file:", err.message);
      }
    }
  }, 2 * 60 * 60 * 1000);
};

io.on("connection", (socket) => {
  console.log("✅ Client connected");

  socket.on("get-formats", (url) => {
    const result = spawnSync(
      YTDLP_PATH,
      ["--cookies", COOKIE_FILE, "-J", url],
      { encoding: "utf-8" }
    );

    if (result.error) {
      console.error("❌ yt-dlp spawn error:", result.error.message);
      socket.emit("status", "❌ Failed to fetch formats.");
      socket.emit("formats", []);
      return;
    }

    if (result.stderr) {
      console.warn("⚠️ yt-dlp stderr:", result.stderr.trim());
    }

    try {
      const info = JSON.parse(result.stdout);
      if (!info || !info.formats) throw new Error("Invalid or missing formats");
      socket.emit("formats", info.formats);
    } catch (e) {
      console.error("❌ Error parsing formats:", e.message);
      socket.emit("status", "❌ Could not parse formats. Invalid URL or unavailable video.");
      socket.emit("formats", []);
    }
  });

  socket.on("start-download", ({ url, format_id, type }) => {
    const outputTemplate = path.join(DOWNLOAD_DIR, "%(title)s.%(ext)s");

    const filenameResult = spawnSync(
      YTDLP_PATH,
      ["--cookies", COOKIE_FILE, "-f", format_id, "--get-filename", "-o", "%(title)s.%(ext)s", url],
      { encoding: "utf-8" }
    );

    const expectedFilename = filenameResult.stdout.trim().split("\n").pop();
    const fullPath = path.join(DOWNLOAD_DIR, expectedFilename);

    if (!expectedFilename) {
      socket.emit("status", "❌ Could not determine filename.");
      return;
    }

    const args = [
      "--cookies", COOKIE_FILE,
      url,
      "-f",
      format_id,
      "-o",
      outputTemplate,
      ...(type === "audio"
        ? ["--extract-audio", "--audio-format", "mp3", "--audio-quality", "192"]
        : []),
    ];

    const ytdlp = spawn(YTDLP_PATH, args);

    ytdlp.stdout.on("data", (data) => {
      const output = data.toString();

      if (output.includes("Downloading webpage")) socket.emit("status", "📄 Downloading video page...");
      else if (output.includes("Extracting URL")) socket.emit("status", "🔗 Extracting video URL...");
      else if (output.includes("Downloading m3u8 information")) socket.emit("status", "🔄 Fetching stream information...");
      else if (output.includes("Downloading 1 format")) socket.emit("status", "⚙️ Preparing formats...");
      else if (output.includes("Destination:")) socket.emit("status", "⬇️ Starting download...");

      const match = output.match(
        /\[download\]\s+(\d{1,3}\.\d+)% of\s+([\d.]+\w+) at\s+([\d.]+\w+\/s) ETA\s+(\d{2}:\d{2})/
      );
      if (match) {
        const [, percent, size, speed] = match;
        const downloaded =
          ((parseFloat(percent) / 100) * parseFloat(size)).toFixed(2) +
          size.replace(/[\d.]/g, "");
        socket.emit("progress", {
          percent: parseFloat(percent),
          size,
          speed,
          downloaded,
        });
      }
    });

    ytdlp.stderr.on("data", (data) => {
      const errorMsg = data.toString().trim();
      if (errorMsg) {
        console.warn("⚠️ yt-dlp stderr:", errorMsg);
        socket.emit("status", errorMsg);
      }
    });

    ytdlp.on("close", () => {
      let finalFile = fullPath;

      if (!fs.existsSync(finalFile)) {
        const files = fs.readdirSync(DOWNLOAD_DIR)
          .map((name) => {
            const filepath = path.join(DOWNLOAD_DIR, name);
            return {
              name,
              time: fs.statSync(filepath).mtime.getTime(),
              path: filepath,
            };
          })
          .filter((f) => f.name.endsWith(type === "audio" ? ".mp3" : ".mp4"))
          .sort((a, b) => b.time - a.time);

        if (files.length) {
          finalFile = files[0].path;
        }
      }

      if (fs.existsSync(finalFile)) {
        const filename = path.basename(finalFile);
        console.log("✅ File downloaded:", filename);
        socket.emit("complete", { filename });
        scheduleFileDeletion(finalFile);
      } else {
        console.error("❌ Download completed but file not found.");
        socket.emit("status", "❌ Download failed. File not found.");
      }
    });
  });
});

app.get("/download/:filename", (req, res) => {
  const file = path.join(DOWNLOAD_DIR, req.params.filename);
  if (fs.existsSync(file)) {
    res.download(file);
  } else {
    res.status(404).send("❌ File not found.");
  }
});

const PORT = process.env.PORT || 7350;
server.listen(PORT, () => {
  console.log(`🚀 Backend running on http://localhost:${PORT}`);
});
