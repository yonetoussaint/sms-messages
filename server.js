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
// PHONE NORMALIZATION
// =====================
// Mobile money numbers are stored in `profiles` as "+509XXXXXXXX". The
// number parsed out of the SMS body is digits-only (e.g. "50932175344" or
// just the 8-digit local number, depending on how the sender phrases it).
// Comparing those two forms directly with a plain `.eq()` never matches,
// which is why deposits were logged but never credited. Normalizing both
// sides to the same "+509XXXXXXXX" shape before comparing fixes that —
// the "+" itself is cosmetic, what matters is both sides agreeing on it.
function normalizeHaitiPhone(raw) {
  if (!raw) return raw;
  let digits = String(raw).replace(/\D/g, "");
  if (digits.startsWith("509") && digits.length > 8) {
    digits = digits.slice(3);
  }
  if (!digits) return raw;
  return `+509${digits}`;
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
// AUTO-CREDIT: match the parsed sender phone number against
// registered users in `profiles` and credit their wallet.
// Runs with the service role key, so it always has write access —
// nothing in the app needs to be open or clicked for this to happen.
// =====================
async function autoCreditMatchingUser(parsed) {
  if (!parsed.sender_phone || !parsed.amount || parsed.amount <= 0) {
    return null;
  }

  const methodLabel = parsed.from === "Mon Cash" ? "moncash" : "natcash";
  const numberCol = `${methodLabel}_number`;
  const verifiedCol = `${methodLabel}_verified`;
  const verifiedAtCol = `${methodLabel}_verified_at`;

  // Normalize to the same "+509XXXXXXXX" shape the app always saves into
  // profiles, so the comparison below actually lines up regardless of how
  // the carrier phrased the number in the SMS.
  const normalizedSenderPhone = normalizeHaitiPhone(parsed.sender_phone);

  // Every profile that currently has this number saved — there may be more
  // than one if multiple people entered the same number before either got
  // verified by a real deposit.
  const { data: candidates, error: matchErr } = await supabase
    .from("profiles")
    .select(`id, ${verifiedCol}`)
    .eq(numberCol, normalizedSenderPhone);

  if (matchErr) {
    console.error("Profile match error:", matchErr);
    return null;
  }
  if (!candidates || candidates.length === 0) {
    console.log(`No profile matches phone ${normalizedSenderPhone} — deposit logged but not credited.`);
    return null;
  }

  let matchedProfile = candidates.find((c) => c[verifiedCol]);

  if (!matchedProfile) {
    // Nobody's verified for this number yet. If more than one profile is
    // claiming it, we can't safely tell who actually owns it — skip
    // auto-credit rather than risk crediting the wrong person.
    if (candidates.length > 1) {
      console.warn(
        `Multiple unverified profiles claim ${normalizedSenderPhone} for ${methodLabel} — skipping auto-credit, needs manual review.`
      );
      return null;
    }

    // Exactly one claimant and a real deposit just came in from that
    // number — that's proof of ownership. Verify them now.
    matchedProfile = candidates[0];
    const { error: verifyErr } = await supabase
      .from("profiles")
      .update({ [verifiedCol]: true, [verifiedAtCol]: new Date().toISOString() })
      .eq("id", matchedProfile.id);

    if (verifyErr) {
      console.error("Verification update error:", verifyErr);
      return null;
    }
    console.log(
      `Verified ${methodLabel} number ${normalizedSenderPhone} for profile ${matchedProfile.id} via first real deposit.`
    );
  }

  const userId = matchedProfile.id;

  const { data: existingBalance, error: balFetchErr } = await supabase
    .from("wallet_balances")
    .select("balance")
    .eq("user_id", userId)
    .maybeSingle();

  if (balFetchErr) {
    console.error("Balance fetch error:", balFetchErr);
    return null;
  }

  const newBalance = (existingBalance?.balance || 0) + parsed.amount;

  const { error: balErr } = await supabase
    .from("wallet_balances")
    .upsert(
      { user_id: userId, balance: newBalance, updated_at: new Date().toISOString() },
      { onConflict: "user_id" }
    );

  if (balErr) {
    console.error("Balance update error:", balErr);
    return null;
  }

  const { error: txErr } = await supabase.from("wallet_transactions").insert({
    user_id: userId,
    type: "deposit",
    label: `Dépôt — ${parsed.from || "Mobile Money"}`,
    amount: parsed.amount,
    method: methodLabel,
    sender_phone: normalizedSenderPhone,
    txn_id: parsed.txn_id,
  });

  if (txErr) {
    console.error("Transaction insert error:", txErr);
    return null;
  }

  return { userId, credited: parsed.amount, newBalance };
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
    const { data: inserted, error } = await supabase
      .from("sms_messages")
      .insert({ payload })
      .select("id")
      .maybeSingle();

    if (error) {
      console.error("Supabase error FULL:", JSON.stringify(error, null, 2));

      return res.status(500).json({
        success: false,
        message: "Database insert failed"
      });
    }

    // =====================
    // AUTO-CREDIT MATCHING USER
    // =====================
    let creditResult = null;
    try {
      creditResult = await autoCreditMatchingUser(parsed);
    } catch (creditErr) {
      // Never fail the whole request just because crediting failed —
      // the SMS is already safely logged in sms_messages either way.
      console.error("Auto-credit error:", creditErr);
    }

    // RESPONSE
    res.json({
      success: true,
      parsed,
      creditResult
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
