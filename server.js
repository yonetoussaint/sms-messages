import express from "express";
import cors from "cors";
import { createServer } from "http";
import { WebSocketServer } from "ws";
import pty from "node-pty";
import { execFile } from "child_process";
import { promisify } from "util";

const execFileAsync = promisify(execFile);

const app = express();
app.use(express.json());
app.use(cors({ origin: process.env.FRONTEND_ORIGIN || "*" }));

const AUTH_TOKEN = process.env.GATEWAY_AUTH_TOKEN;

function checkAuth(req, res, next) {
  if (!AUTH_TOKEN) return next();
  const header = req.headers.authorization || "";
  if (header === `Bearer ${AUTH_TOKEN}`) return next();
  res.status(401).json({ error: "unauthorized" });
}

app.get("/api/codespaces", checkAuth, async (req, res) => {
  try {
    const { stdout } = await execFileAsync("gh", [
      "codespace",
      "list",
      "--json",
      "name,displayName,repository,state,gitStatus,lastUsedAt",
    ]);
    res.json(JSON.parse(stdout));
  } catch (err) {
    console.error("GET /api/codespaces failed:", err);
    res.status(500).json({ error: err.message });
  }
});

app.post("/api/codespaces/:name/stop", checkAuth, async (req, res) => {
  try {
    await execFileAsync("gh", ["codespace", "stop", "-c", req.params.name]);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

const server = createServer(app);
const wss = new WebSocketServer({ noServer: true });

server.on("upgrade", (request, socket, head) => {
  const url = new URL(request.url, "http://localhost");
  if (url.pathname !== "/api/terminal") {
    socket.destroy();
    return;
  }

  if (AUTH_TOKEN) {
    const token = url.searchParams.get("token");
    if (token !== AUTH_TOKEN) {
      socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
      socket.destroy();
      return;
    }
  }

  wss.handleUpgrade(request, socket, head, (ws) => {
    wss.emit("connection", ws, request);
  });
});

wss.on("connection", (ws, request) => {
  const url = new URL(request.url, "http://localhost");
  const codespace = url.searchParams.get("codespace");
  const sessionId = url.searchParams.get("session");

  if (!codespace) {
    ws.send("\r\n\x1b[31mNo codespace specified\x1b[0m\r\n");
    ws.close();
    return;
  }

  if (!sessionId) {
    ws.send("\r\n\x1b[31mNo session specified\x1b[0m\r\n");
    ws.close();
    return;
  }

  // Sanitize: tmux session names can't contain '.' or ':', and this value
  // comes from a client-controlled query param.
  const safeSessionId = sessionId.replace(/[^a-zA-Z0-9_-]/g, "");
  const tmuxSessionName = `gateway-terminal-${safeSessionId}`;

  // Each tab gets its own tmux session on the codespace, so tabs run
  // fully independent shells instead of mirroring one shared session.
  const shell = pty.spawn(
    "gh",
    [
      "codespace",
      "ssh",
      "-c",
      codespace,
      "--",
      "-t",
      "tmux",
      "new-session",
      "-A",
      "-s",
      tmuxSessionName,
    ],
    {
      name: "xterm-256color",
      cols: 80,
      rows: 24,
      cwd: process.cwd(),
      env: process.env,
    }
  );

  shell.onData((data) => {
    if (ws.readyState === ws.OPEN) ws.send(data);
  });

  ws.on("message", (message) => {
    try {
      const payload = JSON.parse(message.toString());
      if (payload.type === "input") shell.write(payload.data);
      if (payload.type === "resize") shell.resize(payload.cols, payload.rows);
    } catch {
      // ignore malformed messages
    }
  });

  ws.on("close", () => shell.kill());
  shell.onExit(() => {
    if (ws.readyState === ws.OPEN) ws.close();
  });
});

const PORT = process.env.PORT || 8080;
server.listen(PORT, () => {
  console.log(`Terminal gateway listening on :${PORT}`);
});