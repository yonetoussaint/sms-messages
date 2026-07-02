import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import { createClient } from "@supabase/supabase-js";

dotenv.config();

const app = express();

app.use(cors());
app.use(express.json());

// =====================
// SUPABASE CLIENT
// =====================
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

// =====================
// API KEY MIDDLEWARE
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
// HEALTH CHECK
// =====================
app.get("/", (req, res) => {
  res.json({ status: "SMS server running 🚀" });
});

// =====================
// STRICT MON CASH PARSER
// =====================
function parseMonCash(message) {
  // STRICT match only "Mon Cash" (exact phrase)
  const from = message.includes("Mon Cash") ? "Mon Cash" : null;

  // AMOUNT (G0.00, G580.00, etc.)
  const amountMatch = message.match(/G\s?(\d+(?:\.\d+)?)/i);
  const amount = amountMatch ? Number(amountMatch[1]) : 0;

  // PHONE NUMBER AFTER "de"
  const senderPhoneMatch = message.match(/de\s+(\d{8,15})/i);
  const sender_phone = senderPhoneMatch ? senderPhoneMatch[1] : null;

  // TXN ID
  const txnIdMatch = message.match(/Txn ID[:\s]*([0-9]+)/i);
  const txn_id = txnIdMatch ? txnIdMatch[1] : null;

  return {
    from,
    amount,
    sender_phone,
    txn_id
  };
}

// =====================
// SMS ENDPOINT
// =====================
app.post("/sms", checkApiKey, async (req, res) => {
  try {
    const { sender, message, time } = req.body;

    // VALIDATION
    if (!sender || !message) {
      return res.status(400).json({
        success: false,
        message: "Missing sender or message"
      });
    }

    // =====================
    // PARSE SMS
    // =====================
    const parsed = parseMonCash(message);

    // =====================
    // BUILD PAYLOAD (JSONB)
    // =====================
    const payload = {
      sender: String(sender),
      message: String(message),

      from: parsed.from,
      amount: parsed.amount,
      sender_phone: parsed.sender_phone,
      txn_id: parsed.txn_id,

      time: time || Date.now(),
      received_at: new Date().toISOString(),
      source: "sms-forwarder"
    };

    // =====================
    // OPTIONAL: DUPLICATE CHECK
    // =====================
    if (parsed.txn_id) {
      const { data: existing } = await supabase
        .from("sms_messages")
        .select("id")
        .contains("payload", { txn_id: parsed.txn_id })
        .maybeSingle();

      if (existing) {
        return res.json({
          success: true,
          message: "Duplicate transaction ignored",
          txn_id: parsed.txn_id
        });
      }
    }

    // =====================
    // INSERT INTO SUPABASE
    // =====================
    const { error } = await supabase
      .from("sms_messages")
      .insert({
        payload
      });

    if (error) {
      console.error("Supabase error FULL:", JSON.stringify(error, null, 2));

      return res.status(500).json({
        success: false,
        message: "Database insert failed"
      });
    }

    // RESPONSE
    res.json({
      success: true,
      parsed
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
// START SERVER
// =====================
const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
  console.log(`SMS server running on port ${PORT}`);
});