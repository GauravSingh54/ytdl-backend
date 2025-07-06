const express = require("express");
const http = require("http");
const cors = require("cors");
const { Server } = require("socket.io");
const { spawn, spawnSync } = require("child_process");
const path = require("path");
const fs = require("fs");

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

// 🧹 Schedule file deletion after 2 hours
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
  }, 2 * 60 * 60 * 1000); // 2 hours
};

// 🔌 WebSocket Communication
io.on("connection", (socket) => {
  console.log("✅ Client connected");

  // 1. Get video formats
  socket.on("get-formats", (url) => {
    const result = spawnSync("yt-dlp", ["-J", url], { encoding: "utf-8" });
    try {
      const info = JSON.parse(result.stdout);
      socket.emit("formats", info.formats || []);
    } catch (e) {
      console.error("❌ Error parsing formats:", e.message);
      socket.emit("formats", []);
    }
  });

  // 2. Start download
  socket.on("start-download", ({ url, format_id, type }) => {
    const outputTemplate = path.join(DOWNLOAD_DIR, "%(title)s.%(ext)s");

    const filenameResult = spawnSync(
      "yt-dlp",
      ["-f", format_id, "--get-filename", "-o", "%(title)s.%(ext)s", url],
      { encoding: "utf-8" }
    );

    const expectedFilename = filenameResult.stdout.trim().split("\n").pop();
    const fullPath = path.join(DOWNLOAD_DIR, expectedFilename);

    if (!expectedFilename) {
      socket.emit("status", "❌ Could not determine filename.");
      return;
    }

    const args = [
      url,
      "-f",
      format_id,
      "-o",
      outputTemplate,
      ...(type === "audio"
        ? ["--extract-audio", "--audio-format", "mp3", "--audio-quality", "192"]
        : []),
    ];

    const ytdlp = spawn("yt-dlp", args);

    ytdlp.stdout.on("data", (data) => {
      const output = data.toString();

      // Live Status Messages
      if (output.includes("Downloading webpage")) socket.emit("status", "📄 Downloading video page...");
      else if (output.includes("Extracting URL")) socket.emit("status", "🔗 Extracting video URL...");
      else if (output.includes("Downloading m3u8 information")) socket.emit("status", "🔄 Fetching stream information...");
      else if (output.includes("Downloading 1 format")) socket.emit("status", "⚙️ Preparing formats...");
      else if (output.includes("Destination:")) socket.emit("status", "⬇️ Starting download...");

      // Live Progress Parsing
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
      socket.emit("status", data.toString());
    });

    ytdlp.on("close", () => {
      let finalFile = fullPath;

      // Fallback: dynamically find last modified file in downloads dir
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
        scheduleFileDeletion(finalFile); // 🧹 Schedule deletion in 2 hours
      } else {
        socket.emit("status", "❌ Download failed.");
      }
    });
  });
});

// 3. Serve file for download
app.get("/download/:filename", (req, res) => {
  const file = path.join(DOWNLOAD_DIR, req.params.filename);
  if (fs.existsSync(file)) {
    res.download(file);
  } else {
    res.status(404).send("❌ File not found.");
  }
});

// Start server
const PORT = process.env.PORT || 7350;
server.listen(PORT, () => {
  console.log(`🚀 Backend running on http://localhost:${PORT}`);
});
