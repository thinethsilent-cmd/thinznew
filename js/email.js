// ══════════════════════════════════════════════════════════════════════════════
//  EMAIL NOTIFICATION SYSTEM  –  Powered by EmailJS (free, no backend needed)
//  Setup: https://emailjs.com
//  1. Create a free account at emailjs.com
//  2. Add your Email Service (Gmail, Outlook, etc.)
//  3. Create email templates for each notification type
//  4. Replace the constants below with your actual IDs
// ══════════════════════════════════════════════════════════════════════════════

// ── EmailJS Configuration ─────────────────────────────────────────────────────
const EMAILJS_PUBLIC_KEY   = "YOUR_EMAILJS_PUBLIC_KEY";   // From EmailJS Dashboard → Account
const EMAILJS_SERVICE_ID   = "YOUR_SERVICE_ID";            // From EmailJS → Email Services
const EMAILJS_TEMPLATES = {
  welcome:         "template_welcome",        // Sent on new user registration
  vipActivated:    "template_vip_activated",  // Sent when VIP subscription activated
  topupApproved:   "template_topup_approved", // Sent when admin approves top-up
  paymentReceived: "template_payment_received" // Sent when user submits payment slip
};

// ── Load EmailJS SDK lazily (only once) ───────────────────────────────────────
let emailJsReady = false;
async function ensureEmailJsLoaded() {
  if (emailJsReady) return true;
  if (typeof window.emailjs !== "undefined") {
    window.emailjs.init(EMAILJS_PUBLIC_KEY);
    emailJsReady = true;
    return true;
  }
  return new Promise((resolve) => {
    const script = document.createElement("script");
    script.src = "https://cdn.jsdelivr.net/npm/@emailjs/browser@4/dist/email.min.js";
    script.onload = () => {
      window.emailjs.init(EMAILJS_PUBLIC_KEY);
      emailJsReady = true;
      resolve(true);
    };
    script.onerror = () => {
      console.warn("[Email] Failed to load EmailJS SDK.");
      resolve(false);
    };
    document.head.appendChild(script);
  });
}

// ── Internal send helper ──────────────────────────────────────────────────────
async function sendEmail(templateId, templateParams) {
  try {
    const ready = await ensureEmailJsLoaded();
    if (!ready) return false;

    // Guard: skip if not configured yet
    if (EMAILJS_PUBLIC_KEY === "YOUR_EMAILJS_PUBLIC_KEY") {
      console.log("[Email] EmailJS not configured yet. Skipping send.", { templateId, templateParams });
      return false;
    }

    await window.emailjs.send(EMAILJS_SERVICE_ID, templateId, templateParams);
    console.log(`[Email] ✅ Sent template: ${templateId} to ${templateParams.to_email}`);
    return true;
  } catch (err) {
    console.error("[Email] Send failed:", err);
    return false;
  }
}

// ══════════════════════════════════════════════════════════════════════════════
//  PUBLIC EMAIL FUNCTIONS
// ══════════════════════════════════════════════════════════════════════════════

/**
 * Welcome email – sent after a new user registers.
 * Template variables: {{to_name}}, {{to_email}}
 */
export async function sendWelcomeEmail(user) {
  if (!user?.email) return;
  return sendEmail(EMAILJS_TEMPLATES.welcome, {
    to_name:  user.displayName || user.email.split("@")[0],
    to_email: user.email,
    site_name: "THINz Banda",
    signals_url: `${window.location.origin}/signals.html`,
    year: new Date().getFullYear()
  });
}

/**
 * VIP Activated email – sent when premium is approved or wallet checkout completes.
 * Template variables: {{to_name}}, {{to_email}}, {{plan_name}}, {{expires_at}}
 */
export async function sendVipActivationEmail(email, displayName, planName, expiresAt) {
  if (!email) return;
  const expiry = expiresAt
    ? new Date(expiresAt).toLocaleDateString("en-GB", { day: "2-digit", month: "long", year: "numeric" })
    : "Never (Lifetime)";
  return sendEmail(EMAILJS_TEMPLATES.vipActivated, {
    to_name:   displayName || email.split("@")[0],
    to_email:  email,
    plan_name: planName || "VIP Premium",
    expires_at: expiry,
    signals_url: `${window.location.origin}/signals.html`,
    site_name: "THINz Banda"
  });
}

/**
 * Top-Up Approved email – sent when admin approves a wallet deposit.
 * Template variables: {{to_name}}, {{to_email}}, {{amount}}, {{new_balance}}
 */
export async function sendTopupApprovedEmail(email, displayName, amount, newBalance) {
  if (!email) return;
  return sendEmail(EMAILJS_TEMPLATES.topupApproved, {
    to_name:     displayName || email.split("@")[0],
    to_email:    email,
    amount:      `$${parseFloat(amount).toFixed(2)}`,
    new_balance: `$${parseFloat(newBalance).toFixed(2)}`,
    topup_url:   `${window.location.origin}/topup.html`,
    site_name:   "THINz Banda"
  });
}

/**
 * Payment Received email – sent when user submits a bank payment slip.
 * Template variables: {{to_name}}, {{to_email}}, {{plan_name}}, {{txid}}
 */
export async function sendPaymentReceivedEmail(email, displayName, planName, txid) {
  if (!email) return;
  return sendEmail(EMAILJS_TEMPLATES.paymentReceived, {
    to_name:   displayName || email.split("@")[0],
    to_email:  email,
    plan_name: planName || "VIP Premium",
    txid:      txid || "N/A",
    site_name: "THINz Banda"
  });
}
