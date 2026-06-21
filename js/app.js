import { 
  observeAuthState, 
  signIn, 
  signUp, 
  signOutUser,
  getUserDoc,
  signInWithGoogle
} from "./auth.js";
import { 
  subscribeToSignals, 
  createSignal, 
  updateSignalStatus, 
  deleteSignal 
} from "./signals.js";
import { 
  subscribeToTrades, 
  startAutoTrading, 
  stopAutoTrading, 
  saveApiKeys 
} from "./bot.js";
import { 
  subscribeToAllUsers, 
  approvePremium, 
  rejectPremium 
} from "./admin.js";
import { db, storage } from "./firebase-config.js";
import { ref, uploadBytesResumable, getDownloadURL } from "https://www.gstatic.com/firebasejs/12.15.0/firebase-storage.js";
import { doc, updateDoc } from "https://www.gstatic.com/firebasejs/12.15.0/firebase-firestore.js";

// Global App State
let state = {
  user: null,
  profile: null,
  botRunning: false
};

// Active Listeners
let activeUnsubscribes = {
  signals: null,
  trades: null,
  users: null
};

// DOM Elements
const pages = {
  home: document.getElementById("page-home"),
  auth: document.getElementById("page-auth"),
  signals: document.getElementById("page-signals"),
  bot: document.getElementById("page-bot"),
  account: document.getElementById("page-account"),
  admin: document.getElementById("page-admin")
};

const navLinks = document.querySelectorAll("[data-target]");
const authLinks = document.querySelectorAll(".auth-link");
const guestLinks = document.querySelectorAll(".guest-link");
const adminLink = document.getElementById("nav-admin-link");
const profileSection = document.getElementById("nav-profile");
const profileName = document.getElementById("nav-profile-name");
const premiumBadge = document.getElementById("nav-premium-badge");

// App Initialization
document.addEventListener("DOMContentLoaded", () => {
  initRouter();
  initAuthListeners();
  initFormListeners();
});

// Router
function initRouter() {
  const navigate = () => {
    let hash = window.location.hash || "#home";
    let targetPage = hash.substring(1);

    if (!pages[targetPage]) {
      targetPage = "home";
    }

    // Auth Route Protection
    const authRequired = ["signals", "bot", "account", "admin"].includes(targetPage);
    const adminRequired = targetPage === "admin";

    if (authRequired && !state.user) {
      window.location.hash = "#auth";
      return;
    }

    if (adminRequired && (!state.profile || state.profile.role !== "admin")) {
      window.location.hash = "#dashboard"; // redirect to signals if not admin
      return;
    }

    // Toggle Pages
    Object.keys(pages).forEach(key => {
      if (key === targetPage) {
        pages[key].classList.remove("hidden");
      } else {
        pages[key].classList.add("hidden");
      }
    });

    // Update active navbar state
    navLinks.forEach(link => {
      if (link.getAttribute("href") === hash) {
        link.classList.add("active");
      } else {
        link.classList.remove("active");
      }
    });

    // Load data for specific pages
    handlePageLoad(targetPage);
  };

  window.addEventListener("hashchange", navigate);
  // Run once on load
  setTimeout(navigate, 200); // Small timeout to ensure Firebase auth is initialized
}

// Page Specific Data Loading
function handlePageLoad(page) {
  // Clear any existing subscriptions first to avoid memory leaks
  cleanupSubscriptions(page);

  if (page === "signals") {
    loadSignalsPage();
  } else if (page === "bot") {
    loadBotPage();
  } else if (page === "account") {
    loadAccountPage();
  } else if (page === "admin") {
    loadAdminPage();
  }
}

function cleanupSubscriptions(exceptPage) {
  if (exceptPage !== "signals" && activeUnsubscribes.signals) {
    activeUnsubscribes.signals();
    activeUnsubscribes.signals = null;
  }
  if (exceptPage !== "bot" && activeUnsubscribes.trades) {
    activeUnsubscribes.trades();
    activeUnsubscribes.trades = null;
  }
  if (exceptPage !== "admin" && activeUnsubscribes.users) {
    activeUnsubscribes.users();
    activeUnsubscribes.users = null;
  }
}

// Authentication Listeners
function initAuthListeners() {
  observeAuthState((user, profile) => {
    state.user = user;
    state.profile = profile;

    if (user) {
      // User is logged in
      authLinks.forEach(el => el.classList.remove("hidden"));
      guestLinks.forEach(el => el.classList.add("hidden"));
      
      profileSection.classList.remove("hidden");
      profileName.textContent = profile?.displayName || user.email.split("@")[0];
      
      // Admin menu item visibility
      if (profile?.role === "admin") {
        adminLink.classList.remove("hidden");
      } else {
        adminLink.classList.add("hidden");
      }

      // Render Badge
      updatePlanBadge(profile?.premiumStatus);

      // Start Bot auto-trading background check if premium and toggle is enabled in state/storage
      if (profile?.premiumStatus === "paid" || profile?.role === "admin") {
        const isBotEnabled = localStorage.getItem(`bot_enabled_${user.uid}`) === "true";
        if (isBotEnabled) {
          startBotExecution();
        }
      }
    } else {
      // User logged out
      authLinks.forEach(el => el.classList.add("hidden"));
      guestLinks.forEach(el => el.classList.remove("hidden"));
      profileSection.classList.add("hidden");
      adminLink.classList.add("hidden");
      
      stopBotExecution();
      cleanupSubscriptions("");
    }
  });
}

function updatePlanBadge(status) {
  premiumBadge.className = "plan-badge";
  if (status === "paid") {
    premiumBadge.textContent = "VIP Premium";
    premiumBadge.classList.add("badge-vip");
  } else if (status === "pending") {
    premiumBadge.textContent = "Pending VIP";
    premiumBadge.classList.add("badge-pending");
  } else {
    premiumBadge.textContent = "Free Tier";
    premiumBadge.classList.add("badge-free");
  }
}

// Form Handlers & Button Listeners
function initFormListeners() {
  // Sign Up Form
  const signupForm = document.getElementById("signup-form");
  if (signupForm) {
    signupForm.addEventListener("submit", async (e) => {
      e.preventDefault();
      const email = document.getElementById("signup-email").value;
      const pass = document.getElementById("signup-password").value;
      const name = document.getElementById("signup-name").value;
      const errorEl = document.getElementById("signup-error");

      try {
        errorEl.textContent = "";
        showLoading(true);
        await signUp(email, pass, name);
        window.location.hash = "#signals";
      } catch (err) {
        errorEl.textContent = err.message;
      } finally {
        showLoading(false);
      }
    });
  }

  // Sign In Form
  const loginForm = document.getElementById("login-form");
  if (loginForm) {
    loginForm.addEventListener("submit", async (e) => {
      e.preventDefault();
      const email = document.getElementById("login-email").value;
      const pass = document.getElementById("login-password").value;
      const errorEl = document.getElementById("login-error");

      try {
        errorEl.textContent = "";
        showLoading(true);
        const { userData } = await signIn(email, pass);
        if (userData && userData.role === "admin") {
          window.location.hash = "#admin";
        } else {
          window.location.hash = "#signals";
        }
      } catch (err) {
        errorEl.textContent = err.message;
      } finally {
        showLoading(false);
      }
    });
  }

  // Sign Out Button
  const signoutBtn = document.getElementById("btn-logout");
  if (signoutBtn) {
    signoutBtn.addEventListener("click", async (e) => {
      e.preventDefault();
      await signOutUser();
      window.location.hash = "#home";
    });
  }

  // Google Sign In Buttons
  const googleBtns = document.querySelectorAll(".btn-google-login");
  googleBtns.forEach(btn => {
    btn.addEventListener("click", async (e) => {
      e.preventDefault();
      const loginError = document.getElementById("login-error");
      const signupError = document.getElementById("signup-error");

      try {
        if (loginError) loginError.textContent = "";
        if (signupError) signupError.textContent = "";
        showLoading(true);
        const { userData } = await signInWithGoogle();
        if (userData && userData.role === "admin") {
          window.location.hash = "#admin";
        } else {
          window.location.hash = "#signals";
        }
      } catch (err) {
        if (loginError) loginError.textContent = err.message;
        if (signupError) signupError.textContent = err.message;
      } finally {
        showLoading(false);
      }
    });
  });

  // Bot Save API Settings
  const botSettingsForm = document.getElementById("bot-settings-form");
  if (botSettingsForm) {
    botSettingsForm.addEventListener("submit", async (e) => {
      e.preventDefault();
      const apiKey = document.getElementById("binance-api-key").value;
      const apiSecret = document.getElementById("binance-api-secret").value;
      const msgEl = document.getElementById("bot-settings-msg");

      try {
        msgEl.className = "status-message text-yellow";
        msgEl.textContent = "Saving keys...";
        await saveApiKeys(state.user.uid, apiKey, apiSecret);
        msgEl.className = "status-message text-green";
        msgEl.textContent = "Binance API Keys saved successfully!";
        setTimeout(() => msgEl.textContent = "", 3000);
      } catch (err) {
        msgEl.className = "status-message text-red";
        msgEl.textContent = "Error saving keys: " + err.message;
      }
    });
  }

  // Auto Bot Toggle Checkbox
  const botToggle = document.getElementById("bot-toggle-btn");
  if (botToggle) {
    botToggle.addEventListener("change", (e) => {
      if (e.target.checked) {
        startBotExecution();
      } else {
        stopBotExecution();
      }
    });
  }

  // Admin Add Signal Form
  const addSignalForm = document.getElementById("admin-signal-form");
  if (addSignalForm) {
    addSignalForm.addEventListener("submit", async (e) => {
      e.preventDefault();
      const pair = document.getElementById("sig-pair").value.toUpperCase();
      const direction = document.getElementById("sig-direction").value;
      const timeframe = document.getElementById("sig-timeframe").value;
      const entry = document.getElementById("sig-entry").value;
      const targets = document.getElementById("sig-targets").value.split(",").map(t => t.trim());
      const stopLoss = document.getElementById("sig-stoploss").value;
      const msgEl = document.getElementById("admin-signal-msg");

      const signalData = {
        pair,
        direction,
        timeframe,
        entry,
        targets,
        stopLoss
      };

      try {
        msgEl.className = "status-message text-yellow";
        msgEl.textContent = "Publishing signal...";
        await createSignal(signalData);
        msgEl.className = "status-message text-green";
        msgEl.textContent = "Signal published successfully!";
        addSignalForm.reset();
        setTimeout(() => msgEl.textContent = "", 3000);
      } catch (err) {
        msgEl.className = "status-message text-red";
        msgEl.textContent = "Error: " + err.message;
      }
    });
  }

  // Premium checkbox/toggle request
  const premiumCheckbox = document.getElementById("premium-opt-in");
  const paymentDetails = document.getElementById("payment-instructions-panel");
  const submitTxForm = document.getElementById("premium-payment-form");

  if (premiumCheckbox) {
    premiumCheckbox.addEventListener("change", (e) => {
      if (e.target.checked) {
        paymentDetails.classList.remove("hidden");
      } else {
        paymentDetails.classList.add("hidden");
      }
    });
  }

  if (submitTxForm) {
    submitTxForm.addEventListener("submit", async (e) => {
      e.preventDefault();
      const txid = document.getElementById("payment-txid").value;
      const msgEl = document.getElementById("payment-msg");
      const submitBtn = submitTxForm.querySelector("button[type='submit']");
      const progressWrap = document.getElementById("upload-progress-wrap");
      const progressBar = document.getElementById("upload-progress-bar");
      const progressPct = document.getElementById("upload-progress-pct");

      // Helper to update progress bar
      const setProgress = (pct) => {
        if (progressBar) progressBar.style.width = pct + "%";
        if (progressPct) progressPct.textContent = pct + "%";
      };

      if (!state.user) {
        msgEl.className = "status-message text-red";
        msgEl.textContent = "Error: You must be logged in to submit a request.";
        return;
      }

      if (!txid.trim()) {
        msgEl.className = "status-message text-red";
        msgEl.textContent = "Please enter a valid Reference ID / TxID.";
        return;
      }

      // Disable button to prevent double-submits
      if (submitBtn) { submitBtn.disabled = true; submitBtn.textContent = "Submitting..."; }
      msgEl.className = "status-message text-yellow";
      msgEl.textContent = "Submitting payment details...";

      try {
        // Step 1: Attempt image upload with live progress bar
        const fileInput = document.getElementById("payment-slip");
        let slipUrl = null;
        if (fileInput && fileInput.files.length > 0) {
          const file = fileInput.files[0];
          try {
            console.log("Starting payment slip upload:", file.name, file.size);
            // Show progress bar
            if (progressWrap) progressWrap.classList.remove("hidden");
            setProgress(0);
            msgEl.textContent = "Uploading payment slip...";

            const storageRef = ref(storage, `payment_slips/${state.user.uid}/${Date.now()}_${file.name}`);
            const uploadTask = uploadBytesResumable(storageRef, file);

            slipUrl = await new Promise((resolve, reject) => {
              // Add a timeout of 7 seconds so we don't get stuck indefinitely
              const timeoutId = setTimeout(() => {
                reject(new Error("Upload timed out (7 seconds limit reached)."));
              }, 7000);

              uploadTask.on(
                "state_changed",
                (snapshot) => {
                  // Live progress update
                  const pct = Math.round((snapshot.bytesTransferred / snapshot.totalBytes) * 100);
                  setProgress(isNaN(pct) ? 0 : pct);
                  msgEl.textContent = `Uploading payment slip... (${isNaN(pct) ? 0 : pct}%)`;
                },
                (error) => {
                  clearTimeout(timeoutId);
                  console.error("Firebase upload error callback:", error);
                  reject(error);
                },
                async () => {
                  clearTimeout(timeoutId);
                  try {
                    setProgress(100);
                    msgEl.textContent = "Upload completed! Getting link...";
                    const url = await getDownloadURL(uploadTask.snapshot.ref);
                    resolve(url);
                  } catch (err) {
                    console.error("Error getting download URL:", err);
                    reject(err);
                  }
                }
              );
            });

            // Brief pause so user sees 100% before hiding
            await new Promise(r => setTimeout(r, 600));
          } catch (uploadErr) {
            console.warn("Image upload failed:", uploadErr);
            msgEl.className = "status-message text-red";
            msgEl.textContent = `⚠️ Slip upload failed: ${uploadErr.message || uploadErr}. Submitting without image...`;
            // Keep this warning message visible for 3 seconds so the user can read it
            await new Promise(r => setTimeout(r, 3000));
          } finally {
            // Always hide progress bar after upload attempt
            if (progressWrap) progressWrap.classList.add("hidden");
            setProgress(0);
          }
        }

        // Step 2: Update Firestore — this is the critical step
        msgEl.className = "status-message text-yellow";
        msgEl.textContent = "Saving verification request...";
        const userRef = doc(db, "users", state.user.uid);
        await updateDoc(userRef, {
          premiumStatus: "pending",
          paymentTxid: txid.trim(),
          paymentRequestedAt: new Date().toISOString(),
          ...(slipUrl && { paymentSlipUrl: slipUrl })
        });

        // Step 3: Update local state and UI
        state.profile.premiumStatus = "pending";
        updatePlanBadge("pending");

        msgEl.className = "status-message text-green";
        msgEl.textContent = "✅ Request submitted! Admin will verify your payment and activate your account shortly.";

        // Reset form
        submitTxForm.reset();
        premiumCheckbox.checked = false;
        paymentDetails.classList.add("hidden");

        // Refresh account view to show pending panel
        loadAccountPage();
      } catch (err) {
        msgEl.className = "status-message text-red";
        msgEl.textContent = "Error: " + (err.message || "Could not submit request. Please try again.");
        console.error("Payment submission error:", err);
      } finally {
        // Always re-enable submit button
        if (submitBtn) { submitBtn.disabled = false; submitBtn.textContent = "Submit Verification Request"; }
        if (progressWrap) progressWrap.classList.add("hidden");
      }
    });
  }
}

// Signals Page Logic
function loadSignalsPage() {
  const container = document.getElementById("signals-list");
  container.innerHTML = `<div class="loading-spinner">Loading Crypto Signals...</div>`;

  const status = state.profile?.role === "admin" ? "admin" : state.profile?.premiumStatus || "free";

  activeUnsubscribes.signals = subscribeToSignals(status, (signals) => {
    container.innerHTML = "";
    if (signals.length === 0) {
      container.innerHTML = `<div class="empty-state">No trading signals active at the moment. Check back soon.</div>`;
      return;
    }

    signals.forEach((sig) => {
      const card = document.createElement("div");
      card.className = `signal-card ${sig.direction.toLowerCase() === "buy" ? "card-buy" : "card-sell"}`;

      const badgeClass = sig.status === "Win" ? "status-win" : sig.status === "Loss" ? "status-loss" : "status-pending";
      const targetsList = sig.targets.map((t, idx) => `<li>Target ${idx + 1}: <span class="text-white font-medium">${t}</span></li>`).join("");

      // Extra meta badges for free signals (leverage, min trade, accuracy)
      const metaBadges = (!sig.locked && (sig.leverage || sig.minTrade || sig.accuracy)) ? `
        <div class="signal-meta-row" style="display:flex;gap:8px;flex-wrap:wrap;margin-top:10px;">
          ${sig.leverage ? `<span class="meta-badge" style="background:rgba(255,198,0,0.12);border:1px solid rgba(255,198,0,0.35);color:#ffc600;padding:3px 10px;border-radius:20px;font-size:0.75rem;font-weight:700;">⚡ ${sig.leverage} Leverage</span>` : ""}
          ${sig.minTrade ? `<span class="meta-badge" style="background:rgba(0,255,136,0.10);border:1px solid rgba(0,255,136,0.3);color:#00ff88;padding:3px 10px;border-radius:20px;font-size:0.75rem;font-weight:700;">💰 Min ${sig.minTrade}</span>` : ""}
          ${sig.accuracy ? `<span class="meta-badge" style="background:rgba(99,102,241,0.12);border:1px solid rgba(99,102,241,0.35);color:#818cf8;padding:3px 10px;border-radius:20px;font-size:0.75rem;font-weight:700;">🎯 ${sig.accuracy} Accuracy</span>` : ""}
          ${sig.tier === "free" ? `<span class="meta-badge" style="background:rgba(255,255,255,0.05);border:1px solid var(--border-color);color:var(--text-muted);padding:3px 10px;border-radius:20px;font-size:0.75rem;font-weight:600;">FREE Signal</span>` : ""}
        </div>
      ` : "";

      let html = `
        <div class="signal-header">
          <div>
            <h3 class="signal-pair">${sig.pair}</h3>
            <span class="signal-direction badge-${sig.direction.toLowerCase()}">${sig.direction}</span>
            <span class="signal-timeframe">${sig.timeframe}</span>
          </div>
          <span class="signal-status-badge ${badgeClass}">${sig.status}</span>
        </div>
        <div class="signal-body">
          <div class="signal-detail">
            <span>Entry Target</span>
            <strong>${sig.entry}</strong>
          </div>
          <div class="signal-detail">
            <span>Stop Loss</span>
            <strong class="text-red">${sig.stopLoss}</strong>
          </div>
          <div class="signal-targets">
            <span>Take Profit Targets</span>
            <ul>${targetsList}</ul>
          </div>
        </div>
        ${metaBadges}
      `;

      if (sig.locked) {
        card.classList.add("locked-card");
        html = `
          <div class="lock-overlay">
            <svg class="lock-icon" fill="currentColor" viewBox="0 0 20 20"><path d="M10 2a5 5 0 00-5 5v2a2 2 0 00-2 2v5a2 2 0 002 2h10a2 2 0 002-2v-5a2 2 0 00-2-2V7a5 5 0 00-5-5zM7 7a3 3 0 016 0v2H7V7z"></path></svg>
            <h4 class="lock-title">VIP Premium Signal – ${sig.pair}</h4>
            <p class="lock-desc">High-leverage entry with up to 91% accuracy. Upgrade to unlock all signals + auto-bot.</p>
            <a href="#account" class="btn btn-primary btn-sm">Unlock with Premium</a>
          </div>
          <div class="signal-header blurred">
            <div>
              <h3 class="signal-pair">${sig.pair}</h3>
              <span class="signal-direction">${sig.direction}</span>
              <span class="signal-timeframe">${sig.timeframe}</span>
            </div>
            <span class="signal-status-badge">🔒 VIP</span>
          </div>
          <div class="signal-body blurred">
            <div class="signal-detail"><span>Entry Target</span><strong>•••</strong></div>
            <div class="signal-detail"><span>Stop Loss</span><strong>•••</strong></div>
          </div>
        `;
      }

      card.innerHTML = html;
      container.appendChild(card);
    });
  });
}


// Bot Page Logic
async function loadBotPage() {
  const status = state.profile?.premiumStatus;
  const role = state.profile?.role;
  const botLockSection = document.getElementById("bot-lock-section");
  const botContentSection = document.getElementById("bot-content-section");
  const activeTradesList = document.getElementById("bot-trades-list");
  const botLogEl = document.getElementById("bot-log");
  const botToggleBtn = document.getElementById("bot-toggle-btn");

  if (status !== "paid" && role !== "admin") {
    botLockSection.classList.remove("hidden");
    botContentSection.classList.add("hidden");
    return;
  }

  // Premium user authenticated - show bot controls
  botLockSection.classList.add("hidden");
  botContentSection.classList.remove("hidden");

  // Populate API key settings inputs if keys already set
  const apiKeys = state.profile.binanceApi;
  if (apiKeys) {
    document.getElementById("binance-api-key").value = apiKeys.apiKey.substring(0, 8) + "••••••••••••••••••••••••";
    document.getElementById("binance-api-secret").value = "••••••••••••••••••••••••••••••••";
  }

  // Sync Toggle button
  const savedToggleState = localStorage.getItem(`bot_enabled_${state.user.uid}`) === "true";
  botToggleBtn.checked = savedToggleState;
  
  updateBotStatusText(savedToggleState);

  // Subscribe to real-time trades executed by the bot
  activeTradesList.innerHTML = `<tr><td colspan="5" class="text-center py-4 text-gray">Loading execution logs...</td></tr>`;
  
  activeUnsubscribes.trades = subscribeToTrades(state.user.uid, (trades) => {
    activeTradesList.innerHTML = "";
    if (trades.length === 0) {
      activeTradesList.innerHTML = `<tr><td colspan="7" class="text-center py-4 text-gray">No trades executed yet. Run the bot to auto-trade signals.</td></tr>`;
      updateBotStats(0, 0, 0);
      return;
    }

    let winsCount = 0;
    let lossesCount = 0;
    let totalPnl = 0;

    trades.forEach(trade => {
      if (trade.status === "WIN") {
        winsCount++;
        totalPnl += trade.pnl;
      } else if (trade.status === "LOSS") {
        lossesCount++;
        totalPnl += trade.pnl;
      }

      const statusClass = trade.status === "WIN" ? "text-green" : trade.status === "LOSS" ? "text-red" : "text-yellow";
      const pnlSign = trade.pnl > 0 ? "+" : "";
      
      const amt = trade.amount !== undefined ? trade.amount : 0.50;
      const dollarPnl = trade.pnlAmount !== undefined ? trade.pnlAmount : (amt * (trade.pnl / 100));
      const pnlText = trade.status !== "OPEN" ? `${pnlSign}$${Math.abs(dollarPnl).toFixed(2)} (${pnlSign}${trade.pnl.toFixed(2)}%)` : "Trading...";
      const lev = trade.leverage || "15x";
      const marginRisk = `$${amt.toFixed(2)}`;

      const tr = document.createElement("tr");
      tr.innerHTML = `
        <td class="py-3 px-4 font-medium">${trade.pair}</td>
        <td class="py-3 px-4"><span class="badge-${trade.direction.toLowerCase()}">${trade.direction}</span></td>
        <td class="py-3 px-4 font-bold text-yellow">${lev}</td>
        <td class="py-3 px-4 text-gray font-mono">${marginRisk}</td>
        <td class="py-3 px-4 font-mono">$${trade.entry}</td>
        <td class="py-3 px-4 ${statusClass}">${trade.status}</td>
        <td class="py-3 px-4 ${statusClass} font-medium font-mono">${pnlText}</td>
      `;
      activeTradesList.appendChild(tr);
    });

    updateBotStats(winsCount, lossesCount, totalPnl);
  });
}

function updateBotStats(wins, losses, totalPnl) {
  document.getElementById("bot-wins").textContent = wins;
  document.getElementById("bot-losses").textContent = losses;
  
  const pnlEl = document.getElementById("bot-total-pnl");
  pnlEl.textContent = (totalPnl >= 0 ? "+" : "") + totalPnl.toFixed(2) + "%";
  
  if (totalPnl > 0) {
    pnlEl.className = "metric-value text-green";
  } else if (totalPnl < 0) {
    pnlEl.className = "metric-value text-red";
  } else {
    pnlEl.className = "metric-value text-gray";
  }
}

function updateBotStatusText(running) {
  const statusIndicator = document.getElementById("bot-status-indicator");
  const statusText = document.getElementById("bot-status-text");

  if (running) {
    statusIndicator.className = "status-dot dot-active";
    statusText.textContent = "AUTO TRADING BOT ACTIVE";
    statusText.className = "text-green font-bold text-sm tracking-wide";
    addBotLog("Bot started. Listening for high-accuracy VIP signals...");
  } else {
    statusIndicator.className = "status-dot dot-inactive";
    statusText.textContent = "BOT INACTIVE";
    statusText.className = "text-red font-bold text-sm tracking-wide";
    addBotLog("Bot stopped.");
  }
}

function addBotLog(text) {
  const botLogEl = document.getElementById("bot-log");
  if (!botLogEl) return;
  const time = new Date().toLocaleTimeString();
  botLogEl.innerHTML += `<div>[${time}] ${text}</div>`;
  botLogEl.scrollTop = botLogEl.scrollHeight;
}

// Bot Execution Trigger
function startBotExecution() {
  if (!state.user) return;
  
  state.botRunning = true;
  localStorage.setItem(`bot_enabled_${state.user.uid}`, "true");
  
  const status = state.profile?.role === "admin" ? "admin" : state.profile?.premiumStatus;
  
  startAutoTrading(state.user.uid, status, (logMsg) => {
    addBotLog(logMsg);
  });

  updateBotStatusText(true);
}

function stopBotExecution() {
  if (!state.user) return;

  state.botRunning = false;
  localStorage.setItem(`bot_enabled_${state.user.uid}`, "false");
  
  stopAutoTrading();
  updateBotStatusText(false);
}

// Account / Subscription Details Page Logic
function loadAccountPage() {
  const normalPanel = document.getElementById("account-normal-panel");
  const pendingPanel = document.getElementById("account-pending-panel");
  const vipActivePanel = document.getElementById("account-vip-panel");

  const status = state.profile?.premiumStatus;
  const role = state.profile?.role;

  if (role === "admin" || status === "paid") {
    vipActivePanel.classList.remove("hidden");
    normalPanel.classList.add("hidden");
    pendingPanel.classList.add("hidden");
  } else if (status === "pending") {
    pendingPanel.classList.remove("hidden");
    vipActivePanel.classList.add("hidden");
    normalPanel.classList.add("hidden");
  } else {
    normalPanel.classList.remove("hidden");
    pendingPanel.classList.add("hidden");
    vipActivePanel.classList.add("hidden");
  }
}

// Admin Panel Page Logic
function loadAdminPage() {
  const pendingList = document.getElementById("admin-pending-payments");
  const userList = document.getElementById("admin-users-list");
  const adminSignalsList = document.getElementById("admin-signals-table");

  // Load Pending Payments and Users Directories
  activeUnsubscribes.users = subscribeToAllUsers((users) => {
    pendingList.innerHTML = "";
    userList.innerHTML = "";

    const pendingUsers = users.filter(u => u.premiumStatus === "pending");
    
    // 1. Pending Payments List
    if (pendingUsers.length === 0) {
      pendingList.innerHTML = `<div class="empty-state">No pending premium upgrade requests.</div>`;
    } else {
      pendingUsers.forEach(u => {
        const div = document.createElement("div");
        div.className = "payment-request-card";
         div.innerHTML = `
           <div>
             <h4 class="text-white font-medium">${u.displayName || u.email}</h4>
             <p class="text-sm text-gray mt-1">TxID/Ref: <span class="text-yellow font-mono">${u.paymentTxid}</span></p>
             <p class="text-xs text-gray mt-1">Requested: ${new Date(u.paymentRequestedAt).toLocaleString()}</p>
             ${u.paymentSlipUrl ? `<img src="${u.paymentSlipUrl}" class="payment-slip-thumb cursor-pointer" style="max-width:100px; margin-top:8px; border:1px solid var(--border-color);" onclick="openSlipModal('${u.paymentSlipUrl}')"/>` : ''}
           </div>
           <div class="action-buttons flex gap-2">
             <button class="btn btn-primary btn-sm btn-approve" data-id="${u.uid}">Accept</button>
             <button class="btn btn-secondary btn-sm btn-reject" data-id="${u.uid}">Reject</button>
           </div>
         `;
        pendingList.appendChild(div);
      });

      // Attach event listeners for Accept/Reject buttons
      document.querySelectorAll(".btn-approve").forEach(btn => {
        btn.addEventListener("click", async (e) => {
          const uid = e.target.getAttribute("data-id");
          e.target.disabled = true;
          e.target.textContent = "Approving...";
          await approvePremium(uid);
        });
      });

      document.querySelectorAll(".btn-reject").forEach(btn => {
        btn.addEventListener("click", async (e) => {
          const uid = e.target.getAttribute("data-id");
          e.target.disabled = true;
          e.target.textContent = "Rejecting...";
          await rejectPremium(uid);
        });
      });
    }

    // 2. User Accounts win/loss listing
    if (users.length === 0) {
      userList.innerHTML = `<tr><td colspan="4" class="text-center py-3 text-gray">No users registered in system.</td></tr>`;
    } else {
      users.forEach(u => {
        const winLoss = u.winLoss || { wins: 0, losses: 0 };
        const total = winLoss.wins + winLoss.losses;
        const winrate = total > 0 ? ((winLoss.wins / total) * 100).toFixed(1) + "%" : "0%";
        
        const tr = document.createElement("tr");
        tr.innerHTML = `
          <td class="py-3 px-4 text-white font-medium">${u.displayName || "No Name"}</td>
          <td class="py-3 px-4">${u.email}</td>
          <td class="py-3 px-4"><span class="badge-${u.premiumStatus === 'paid' ? 'buy' : u.premiumStatus === 'pending' ? 'pending' : 'sell'}">${u.premiumStatus.toUpperCase()}</span></td>
          <td class="py-3 px-4 font-mono text-green">${winLoss.wins}W <span class="text-red">${winLoss.losses}L</span> (${winrate})</td>
        `;
        userList.appendChild(tr);
      });
    }
  });

  // 3. Admin signals list to update status or delete
  activeUnsubscribes.signals = subscribeToSignals("admin", (signals) => {
    adminSignalsList.innerHTML = "";
    if (signals.length === 0) {
      adminSignalsList.innerHTML = `<tr><td colspan="5" class="text-center py-3 text-gray">No signals created. Create one below.</td></tr>`;
      return;
    }

    signals.forEach(sig => {
      const tr = document.createElement("tr");
      
      let actionsHtml = "";
      if (sig.status === "Pending") {
        actionsHtml = `
          <button class="btn btn-primary btn-xs btn-win" data-id="${sig.id}">Win</button>
          <button class="btn btn-secondary btn-xs btn-loss" data-id="${sig.id}">Loss</button>
        `;
      }
      actionsHtml += `<button class="btn btn-danger btn-xs btn-delete ml-1" data-id="${sig.id}">Delete</button>`;

      tr.innerHTML = `
        <td class="py-3 px-4 text-white font-medium">${sig.pair}</td>
        <td class="py-3 px-4"><span class="badge-${sig.direction.toLowerCase()}">${sig.direction}</span></td>
        <td class="py-3 px-4 font-mono">${sig.entry}</td>
        <td class="py-3 px-4"><span class="status-badge ${sig.status === 'Win' ? 'status-win' : sig.status === 'Loss' ? 'status-loss' : 'status-pending'}">${sig.status}</span></td>
        <td class="py-3 px-4">${actionsHtml}</td>
      `;
      adminSignalsList.appendChild(tr);
    });

    // Attach actions
    document.querySelectorAll(".btn-win").forEach(btn => {
      btn.addEventListener("click", async (e) => {
        const id = e.target.getAttribute("data-id");
        await updateSignalStatus(id, "Win");
      });
    });

    document.querySelectorAll(".btn-loss").forEach(btn => {
      btn.addEventListener("click", async (e) => {
        const id = e.target.getAttribute("data-id");
        await updateSignalStatus(id, "Loss");
      });
    });

    document.querySelectorAll(".btn-delete").forEach(btn => {
      btn.addEventListener("click", async (e) => {
        const id = e.target.getAttribute("data-id");
        if (confirm("Are you sure you want to delete this signal?")) {
          await deleteSignal(id);
        }
      });
    });
  });
}

function openSlipModal(url) {
  const modal = document.getElementById('slip-modal');
  const img = document.getElementById('slip-modal-img');
  if (modal && img) {
    img.src = url;
    modal.classList.remove('hidden');
  }
}

function closeSlipModal() {
  const modal = document.getElementById('slip-modal');
  if (modal) modal.classList.add('hidden');
}

function showLoading(show) {
  const loader = document.getElementById("global-loader");
  if (loader) {
    if (show) loader.classList.remove("hidden");
    else loader.classList.add("hidden");
  }
}

// Expose modal functions globally for inline onclick handlers
window.openSlipModal = openSlipModal;
window.closeSlipModal = closeSlipModal;

