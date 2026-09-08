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
// Set FRONTEND_ORIGIN to your Netlify URL, e.g. https://your-site.netlify.app
app.use(cors({ origin: process.env.FRONTEND_ORIGIN || "*" }));

// Set GATEWAY_AUTH_TOKEN in production. Requests/connections must present it.
const AUTH_TOKEN = process.env.GATEWAY_AUTH_TOKEN;

function checkAuth(req, res, next) {
  if (!AUTH_TOKEN) return next(); // no token configured — dev mode only
  const header = req.headers.authorization || "";
  if (header === `Bearer ${AUTH_TOKEN}`) return next();
  res.status(401).json({ error: "unauthorized" });
}

// gh CLI reads GH_TOKEN (or GITHUB_TOKEN) from the environment automatically —
// set that on this server's process, never send it to the browser.

// List the authenticated user's codespaces.
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

// Stop a codespace. (There is no "start" command — connecting via ssh
// below auto-starts a stopped codespace.)
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

  if (!codespace) {
    ws.send("\r\n\x1b[31mNo codespace specified\x1b[0m\r\n");
    ws.close();
    return;
  }

  // `gh codespace ssh` auto-starts a stopped codespace, then gives an
  // interactive shell. node-pty gives it a real PTY so full-screen /
  // interactive programs (vim, claude, etc.) render correctly.
  //
  // Running inside tmux on the codespace itself means the actual shell
  // (and anything running in it, like a `claude` session) survives even
  // if this WebSocket drops — e.g. a mobile browser backgrounding the
  // tab. Reconnecting reattaches to the same tmux session instead of
  // starting fresh.
  const shell = pty.spawn(
    "gh",
    [
      "codespace",
      "ssh",
      "-c",
      codespace,
      "--",
      "tmux",
      "new-session",
      "-A",
      "-s",
      "gateway-terminal",
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
