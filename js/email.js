// ══════════════════════════════════════════════════════════════════════════════
//  EMAIL SYSTEM  –  Powered by Firebase "Trigger Email from Firestore" Extension
//
//  Setup (one-time, ~5 minutes):
//  1. Go to Firebase Console → Extensions
//  2. Install "Trigger Email from Firestore"
//  3. Connect your Gmail / SMTP / SendGrid account
//  4. Set the collection name to:  mail
//
//  After setup, every document added to the "mail" Firestore collection
//  is automatically sent as a real email by Firebase. No API keys needed here.
// ══════════════════════════════════════════════════════════════════════════════

import { db } from "./firebase-config.js";
import { collection, addDoc } from "https://www.gstatic.com/firebasejs/12.15.0/firebase-firestore.js";

const SITE_NAME   = "PRIME METRIX Trading";
const SITE_URL    = typeof window !== "undefined" ? window.location.origin : "";
const FROM_NAME   = "PRIME METRIX Trading";
const REPLY_TO    = "noreply@primemetrixtrading.com"; // Change to your email address

// ── Internal helper ───────────────────────────────────────────────────────────
async function sendMail(to, subject, htmlBody, replyTo = REPLY_TO) {
  if (!to) {
    console.warn("[Email] No recipient address — skipping.");
    return false;
  }
  try {
    await addDoc(collection(db, "mail"), {
      to,
      replyTo,
      message: {
        subject: `${subject} | ${SITE_NAME}`,
        html: htmlBody,
      },
      createdAt: new Date().toISOString(),
    });
    console.log(`[Email] ✅ Queued: "${subject}" → ${to}`);
    return true;
  } catch (err) {
    console.error("[Email] Failed to queue mail document:", err);
    return false;
  }
}

// ── Shared HTML wrapper ───────────────────────────────────────────────────────
function wrapHtml(content) {
  return `
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <style>
    body { margin:0; padding:0; background:#0e0e10; font-family:'Segoe UI',Arial,sans-serif; color:#e2e8f0; }
    .wrap { max-width:580px; margin:40px auto; background:#181818; border:1px solid rgba(232,177,45,0.15); border-radius:16px; overflow:hidden; }
    .header { background:linear-gradient(135deg,#1a1a1c,#111113); padding:32px 36px 24px; border-bottom:2px solid rgba(232,177,45,0.2); }
    .logo { font-size:22px; font-weight:900; letter-spacing:-0.02em; color:#fff; text-transform:uppercase; }
    .logo span { color:#e8b12d; }
    .body { padding:32px 36px; }
    h2 { font-size:20px; font-weight:800; color:#fff; margin:0 0 12px; }
    p { font-size:15px; line-height:1.7; color:#94a3b8; margin:0 0 16px; }
    .highlight { background:rgba(232,177,45,0.08); border:1px solid rgba(232,177,45,0.2); border-radius:10px; padding:16px 20px; margin:20px 0; }
    .highlight strong { color:#e8b12d; font-size:16px; }
    .btn { display:inline-block; background:linear-gradient(135deg,#e8b12d,#f5a623); color:#000; font-weight:800; text-decoration:none; padding:14px 28px; border-radius:10px; margin:8px 0; font-size:15px; }
    .divider { border:none; border-top:1px solid rgba(255,255,255,0.06); margin:24px 0; }
    .footer { background:#0e0e10; padding:20px 36px; font-size:12px; color:#475569; border-top:1px solid rgba(255,255,255,0.04); text-align:center; }
    .badge { display:inline-block; background:rgba(232,177,45,0.15); color:#e8b12d; font-weight:700; font-size:12px; padding:4px 12px; border-radius:20px; text-transform:uppercase; letter-spacing:0.06em; }
  </style>
</head>
<body>
  <div class="wrap">
    <div class="header">
      <div class="logo">PRIME<span> METRIX</span></div>
      <div style="font-size:12px;color:#64748b;margin-top:4px;font-weight:600;letter-spacing:0.05em;text-transform:uppercase;">Trading Signals &amp; Auto-Trading</div>
    </div>
    <div class="body">
      ${content}
    </div>
    <div class="footer">
      © ${new Date().getFullYear()} ${SITE_NAME}. All rights reserved.<br>
      You received this because you have an account on <a href="${SITE_URL}" style="color:#e8b12d;">${SITE_URL || "PRIME METRIX Trading"}</a>.
    </div>
  </div>
</body>
</html>`;
}

// ══════════════════════════════════════════════════════════════════════════════
//  PUBLIC EMAIL FUNCTIONS
// ══════════════════════════════════════════════════════════════════════════════

/**
 * Welcome email – sent after a new user registers.
 */
export async function sendWelcomeEmail(user) {
  if (!user?.email) return;
  const name = user.displayName || user.email.split("@")[0];
  const html = wrapHtml(`
    <h2>Welcome to ${SITE_NAME}, ${name}! 🎉</h2>
    <p>Your account is ready. You now have access to free crypto trading signals powered by real-time market analysis.</p>
    <div class="highlight">
      <strong>What's included with your Free account:</strong><br>
      <p style="margin:8px 0 0;">✅ Daily free signals &nbsp;•&nbsp; ✅ Signal history &nbsp;•&nbsp; ✅ Referral rewards</p>
    </div>
    <p>Upgrade to <strong style="color:#e8b12d;">VIP Premium</strong> to unlock all signals, the auto-trading bot, and priority support.</p>
    <a href="${SITE_URL}/signals.html" class="btn">View Live Signals →</a>
    <hr class="divider">
    <p style="font-size:13px;">Share your referral link to earn <strong style="color:#00e676;">$0.20</strong> for each friend who joins, plus <strong style="color:#e8b12d;">15% commission</strong> on their VIP upgrades.</p>
    <a href="${SITE_URL}/referrals.html" style="color:#e8b12d;font-size:13px;">Get your referral link →</a>
  `);
  return sendMail(user.email, `Welcome to ${SITE_NAME}!`, html);
}

/**
 * VIP Activated email – sent when premium is approved.
 */
export async function sendVipActivationEmail(email, displayName, planName, expiresAt) {
  if (!email) return;
  const name   = displayName || email.split("@")[0];
  const expiry = expiresAt
    ? new Date(expiresAt).toLocaleDateString("en-GB", { day: "2-digit", month: "long", year: "numeric" })
    : "Never (Lifetime Access)";
  const html = wrapHtml(`
    <div style="text-align:center;margin-bottom:24px;">
      <span class="badge">⚡ VIP Premium Activated</span>
    </div>
    <h2>Congratulations, ${name}! Your VIP is Live 🚀</h2>
    <p>Your <strong style="color:#e8b12d;">${planName} Premium</strong> subscription has been activated successfully.</p>
    <div class="highlight">
      <strong>Plan:</strong> ${planName}<br>
      <strong>Expires:</strong> ${expiry}<br>
      <strong>Status:</strong> <span style="color:#00e676;">✅ Active</span>
    </div>
    <p>You now have full access to all VIP signals, the AI auto-trading bot, and priority features.</p>
    <a href="${SITE_URL}/signals.html" class="btn">Access VIP Signals →</a>
    <hr class="divider">
    <p style="font-size:13px;color:#64748b;">Questions? Reply to this email or reach us via the platform.</p>
  `);
  return sendMail(email, `🔓 VIP Premium Activated – ${planName}`, html);
}

/**
 * Top-Up Approved email – sent when admin approves a wallet deposit.
 */
export async function sendTopupApprovedEmail(email, displayName, amount, newBalance) {
  if (!email) return;
  const name = displayName || email.split("@")[0];
  const html = wrapHtml(`
    <div style="text-align:center;margin-bottom:24px;">
      <span class="badge">💰 Deposit Approved</span>
    </div>
    <h2>Your deposit has been credited, ${name}!</h2>
    <p>Great news — your wallet top-up has been verified and credited to your account.</p>
    <div class="highlight">
      <strong>Amount Credited:</strong> <span style="color:#00e676;font-size:22px;font-weight:900;">$${parseFloat(amount).toFixed(2)}</span><br>
      <strong>New Wallet Balance:</strong> <span style="color:#e8b12d;font-weight:800;">$${parseFloat(newBalance).toFixed(2)}</span>
    </div>
    <p>You can use your balance to upgrade to VIP Premium or purchase individual signals.</p>
    <a href="${SITE_URL}/topup.html" class="btn">View Wallet →</a>
  `);
  return sendMail(email, `💰 Wallet Top-Up Approved – $${parseFloat(amount).toFixed(2)}`, html);
}

/**
 * Payment Received email – sent when user submits a bank payment slip.
 */
export async function sendPaymentReceivedEmail(email, displayName, planName, txid) {
  if (!email) return;
  const name = displayName || email.split("@")[0];
  const html = wrapHtml(`
    <h2>Payment Received – Under Review</h2>
    <p>Hi ${name}, we've received your payment details for the <strong style="color:#2ec4a0;">${planName || "VIP Premium"}</strong> plan.</p>
    <div class="highlight">
      <strong>Transaction Reference:</strong> <span style="font-family:monospace;color:#f59e0b;">${txid || "N/A"}</span><br>
      <strong>Plan:</strong> ${planName || "VIP Premium"}<br>
      <strong>Status:</strong> <span style="color:#f59e0b;">⏳ Under Review</span>
    </div>
    <p>Our team will verify your payment and activate your account within a few hours. You'll receive another email once it's confirmed.</p>
    <hr class="divider">
    <p style="font-size:13px;color:#64748b;">If you haven't made a payment, please ignore this email.</p>
  `);
  return sendMail(email, `Payment Received – Verifying ${planName || "VIP"}`, html);
}

/**
 * Gift / Admin Message email – sent when admin gifts wallet balance or sends a message.
 */
export async function sendGiftEmail(email, displayName, subject, messageBody, giftAmount = 0) {
  if (!email) return;
  const name = displayName || email.split("@")[0];
  const giftSection = giftAmount > 0 ? `
    <div class="highlight" style="text-align:center;">
      <div style="font-size:12px;font-weight:700;text-transform:uppercase;letter-spacing:0.08em;color:#64748b;margin-bottom:6px;">🎁 Wallet Gift</div>
      <div style="font-size:32px;font-weight:900;color:#00e676;">+$${parseFloat(giftAmount).toFixed(2)}</div>
      <div style="font-size:13px;color:#94a3b8;margin-top:4px;">Has been added to your wallet</div>
    </div>` : "";
  const html = wrapHtml(`
    <div style="text-align:center;margin-bottom:24px;">
      <span class="badge">📨 Message from Admin</span>
    </div>
    <h2>${subject}</h2>
    <p>Hi ${name},</p>
    <p>${messageBody.replace(/\n/g, "<br>")}</p>
    ${giftSection}
    <a href="${SITE_URL}/index.html" class="btn">Open App →</a>
  `);
  return sendMail(email, subject, html);
}
