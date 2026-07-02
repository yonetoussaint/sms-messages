import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import { createClient } from "@supabase/supabase-js";

dotenv.config();

const app = express();

app.use(cors());
app.use(express.json());

// =====================
// Supabase client
// =====================
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

// =====================
// Security middleware
// =====================
function checkApiKey(req, res, next) {
  const apiKey = req.headers["x-api-key"];

  if (!apiKey || apiKey !== process.env.API_KEY) {
    return res.status(401).json({
      success: false,
      message: "Unauthorized"
    });
  }

  next();
}

// =====================
// Health check route
// =====================
app.get("/", (req, res) => {
  res.json({ status: "SMS server running 🚀" });
});

// =====================
// SMS endpoint
// =====================
app.post("/sms", checkApiKey, async (req, res) => {
  try {
    const { sender, message, time } = req.body;

    // Basic validation
    if (!sender || !message) {
      return res.status(400).json({
        success: false,
        message: "Missing sender or message"
      });
    }

    // Build payload
    const payload = {
      sender: String(sender),
      message: String(message),
      time: time || Date.now(),
      received_at: new Date().toISOString(),
      source: "sms-forwarder"
    };

    // Insert into Supabase
    const { error } = await supabase
      .from("sms_messages")
      .insert({
        payload
      });

    if (error) {
      console.error("Supabase error:", error);

      return res.status(500).json({
        success: false,
        message: "Database insert failed"
      });
    }

    res.json({
      success: true
    });

  } catch (err) {
    console.error("Server error:", err);

    res.status(500).json({
      success: false,
      message: "Internal server error"
    });
  }
});

// =====================
// Start server
// =====================
const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
  console.log(`SMS server running on port ${PORT}`);
});