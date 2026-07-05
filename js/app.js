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
  deleteSignal,
  analyseSymbol
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
  rejectPremium,
  checkAndExpireMembership,
  approveTopup,
  rejectTopup
} from "./admin.js";
import { db, storage } from "./firebase-config.js";
import { ref, uploadBytesResumable, getDownloadURL } from "https://www.gstatic.com/firebasejs/12.15.0/firebase-storage.js";
import { doc, updateDoc, collection, query, where, getDocs, getDoc } from "https://www.gstatic.com/firebasejs/12.15.0/firebase-firestore.js";

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
  // Check URL for referral code
  const urlParams = new URLSearchParams(window.location.search);
  const refCode = urlParams.get("ref");
  if (refCode) {
    localStorage.setItem("referred_by", refCode.trim());
    // Clean up URL parameter to make it look clean
    window.history.replaceState({}, document.title, window.location.pathname + window.location.hash);
  }

  initRouter();
  initAuthListeners();
  initFormListeners();
  initMobileMenu();
});

// Mobile Navigation Menu Toggle
function initMobileMenu() {
  const menuToggle = document.getElementById("mobile-menu-toggle");
  const navMenuContainer = document.getElementById("nav-menu-container");

  if (menuToggle && navMenuContainer) {
    menuToggle.addEventListener("click", () => {
      menuToggle.classList.toggle("active");
      navMenuContainer.classList.toggle("active");
    });

    // Close menu when clicking navigation links or buttons
    const links = navMenuContainer.querySelectorAll("a, button");
    links.forEach(link => {
      link.addEventListener("click", () => {
        menuToggle.classList.remove("active");
        navMenuContainer.classList.remove("active");
      });
    });
  }
}

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
      window.location.hash = "#signals"; // redirect to signals if not admin
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
  observeAuthState(async (user, profile) => {
    state.user = user;
    state.profile = profile;

    if (user) {
      // Auto-expire check: downgrade if membership has passed expiry date
      if (profile?.premiumStatus === "paid" && profile?.premiumExpiresAt) {
        const wasExpired = await checkAndExpireMembership(user.uid, profile);
        if (wasExpired) {
          // Update local profile state to reflect expiry
          state.profile = { ...profile, premiumStatus: "expired", activePlan: null, premiumExpiresAt: null };
          profile = state.profile;
        }
      }

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

      // Update Wallet Balance displays
      const balance = profile?.walletBalance !== undefined ? profile.walletBalance : 0.00;
      const navWallet = document.getElementById("nav-wallet-balance");
      if (navWallet) navWallet.textContent = `$${balance.toFixed(2)}`;

      const walletDisplay = document.getElementById("wallet-balance-display");
      if (walletDisplay) walletDisplay.textContent = `$${balance.toFixed(2)}`;

      // Update Top-Up pending notice
      const activeTopupNotice = document.getElementById("active-topup-notice");
      const pendingTopupAmtText = document.getElementById("pending-topup-amount-text");
      if (activeTopupNotice && pendingTopupAmtText) {
        if (profile?.topupStatus === "pending") {
          activeTopupNotice.classList.remove("hidden");
          pendingTopupAmtText.textContent = `$${(profile.topupAmount || 0).toFixed(2)}`;
        } else {
          activeTopupNotice.classList.add("hidden");
        }
      }

      // Render Badge
      updatePlanBadge(profile?.premiumStatus, profile?.premiumExpiresAt);

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

      const navWallet = document.getElementById("nav-wallet-balance");
      if (navWallet) navWallet.textContent = "$0.00";
      
      stopBotExecution();
      cleanupSubscriptions("");
    }
  });
}

function updatePlanBadge(status, expiresAt) {
  premiumBadge.className = "plan-badge";
  if (status === "paid") {
    let label = "VIP Premium";
    if (expiresAt) {
      const d = new Date(expiresAt);
      label = `VIP · Expires ${d.toLocaleDateString("en-GB", { day: "2-digit", month: "short", year: "numeric" })}`;
    }
    premiumBadge.textContent = label;
    premiumBadge.classList.add("badge-vip");
  } else if (status === "pending") {
    premiumBadge.textContent = "Pending VIP";
    premiumBadge.classList.add("badge-pending");
  } else if (status === "expired") {
    premiumBadge.textContent = "Expired";
    premiumBadge.classList.add("badge-expired");
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
        const referredBy = localStorage.getItem("referred_by");
        await signUp(email, pass, name, referredBy);
        localStorage.removeItem("referred_by");
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
        const referredBy = localStorage.getItem("referred_by");
        const { userData } = await signInWithGoogle(referredBy);
        localStorage.removeItem("referred_by");
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
      const method = document.getElementById("payment-method-field").value;
      const plan = document.getElementById("payment-plan").value;
      const msgEl = document.getElementById("payment-msg");
      const submitBtn = document.getElementById("btn-submit-upgrade");
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

      if (!plan) {
        msgEl.className = "status-message text-red";
        msgEl.textContent = "Please select a subscription plan from the cards above first.";
        return;
      }

      const getPriceUSD = (pName) => {
        switch (pName) {
          case "7 Days": return 5.00;
          case "2 Weeks": return 9.67;
          case "1 Month": return 16.67;
          case "3 Months": return 36.67;
          case "Lifetime": return 66.67;
          default: return 16.67;
        }
      };
      const usdPrice = getPriceUSD(plan);

      if (method === "wallet") {
        // WALLET PAYMENT METHOD
        const userBalance = state.profile?.walletBalance || 0;
        if (userBalance < usdPrice) {
          msgEl.className = "status-message text-red";
          msgEl.textContent = `Insufficient balance. This upgrade costs $${usdPrice.toFixed(2)}, but you only have $${userBalance.toFixed(2)}. Please top up your wallet.`;
          return;
        }

        if (submitBtn) { submitBtn.disabled = true; submitBtn.textContent = "Processing payment..."; }
        msgEl.className = "status-message text-yellow";
        msgEl.textContent = "Processing wallet checkout...";

        try {
          const newBalance = parseFloat((userBalance - usdPrice).toFixed(2));
          const getPlanExpiryDate = (pName) => {
            const now = new Date();
            switch (pName) {
              case "7 Days":    now.setDate(now.getDate() + 7);   break;
              case "2 Weeks":   now.setDate(now.getDate() + 14);  break;
              case "1 Month":   now.setMonth(now.getMonth() + 1); break;
              case "3 Months":  now.setMonth(now.getMonth() + 3); break;
              case "Lifetime":  return null;
              default:          now.setMonth(now.getMonth() + 1);
            }
            return now.toISOString();
          };
          const expiresAt = getPlanExpiryDate(plan);

          const userRef = doc(db, "users", state.user.uid);
          const userUpdates = {
            premiumStatus: "paid",
            activePlan: plan,
            premiumActivatedAt: new Date().toISOString(),
            premiumExpiresAt: expiresAt,
            walletBalance: newBalance
          };

          // Crediting referrer 15% commission instantly
          if (state.profile?.referredBy && !state.profile?.referralBonusProcessed) {
            try {
              const referrerId = state.profile.referredBy;
              const referrerRef = doc(db, "users", referrerId);
              const referrerSnap = await getDoc(referrerRef);
              if (referrerSnap.exists()) {
                const referrerData = referrerSnap.data();
                const commission = parseFloat((usdPrice * 0.15).toFixed(2));
                await updateDoc(referrerRef, {
                  walletBalance: parseFloat(((referrerData.walletBalance || 0) + commission).toFixed(2)),
                  totalReferralEarnings: parseFloat(((referrerData.totalReferralEarnings || 0) + commission).toFixed(2))
                });
                console.log(`Referrer ${referrerId} awarded 15% instant commission: $${commission}`);
                userUpdates.referralBonusProcessed = true;
              }
            } catch (err) {
              console.error("Error crediting commission on wallet upgrade:", err);
            }
          }

          await updateDoc(userRef, userUpdates);

          // Update local state
          state.profile = { ...state.profile, ...userUpdates };
          updatePlanBadge("paid", expiresAt);

          msgEl.className = "status-message text-green";
          msgEl.textContent = "✅ VIP Subscription Activated Successfully using wallet balance!";

          // Reset forms and hide panels
          submitTxForm.reset();
          premiumCheckbox.checked = false;
          paymentDetails.classList.add("hidden");

          setTimeout(() => {
            msgEl.textContent = "";
            loadAccountPage();
          }, 2000);
        } catch (err) {
          msgEl.className = "status-message text-red";
          msgEl.textContent = "Payment failed: " + err.message;
        } finally {
          if (submitBtn) { submitBtn.disabled = false; submitBtn.textContent = `Pay $${usdPrice.toFixed(2)} with Wallet`; }
        }
      } else {
        // BANK PAYMENT METHOD
        const txid = document.getElementById("payment-txid").value;
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
          const selectedPlan = document.getElementById("payment-plan")?.value || "";
          await updateDoc(userRef, {
            premiumStatus: "pending",
            paymentTxid: txid.trim(),
            paymentPlan: selectedPlan, // e.g. "7 Days", "1 Month", "Lifetime"
            paymentRequestedAt: new Date().toISOString(),
            ...(slipUrl && { paymentSlipUrl: slipUrl })
          });

          // Step 3: Update local state and UI
          if (state.profile) state.profile.premiumStatus = "pending";
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
      }
    });
  }

  // Plan Selection Globals
  window.selectPlan = function(cardEl) {
    document.querySelectorAll(".plan-card").forEach(c => {
      c.style.borderColor = "var(--border-color)";
      c.style.background = "";
    });

    cardEl.style.borderColor = "var(--color-primary)";
    cardEl.style.background = "rgba(46, 196, 160, 0.05)";

    const planName = cardEl.getAttribute("data-plan");
    const priceLkr = cardEl.getAttribute("data-price");
    document.getElementById("payment-plan").value = planName;
    document.getElementById("selected-plan-label").textContent = `${planName} Plan — Rs. ${priceLkr}/=`;

    const getPriceUSD = (p) => {
      switch (p) {
        case "7 Days": return 5.00;
        case "2 Weeks": return 9.67;
        case "1 Month": return 16.67;
        case "3 Months": return 36.67;
        case "Lifetime": return 66.67;
        default: return 16.67;
      }
    };
    const usdPrice = getPriceUSD(planName);
    document.getElementById("wallet-plan-price-usd").textContent = `$${usdPrice.toFixed(2)}`;

    const userBalance = state.profile?.walletBalance || 0;
    document.getElementById("wallet-user-balance-usd").textContent = `$${userBalance.toFixed(2)}`;

    document.getElementById("payment-instructions-panel").classList.remove("hidden");
    document.getElementById("premium-opt-in").checked = true;

    window.setPayMethod("bank");
  };

  window.setPayMethod = function(method) {
    document.getElementById("payment-method-field").value = method;
    const btnBank = document.getElementById("pay-method-bank");
    const btnWallet = document.getElementById("pay-method-wallet");
    
    const bankView = document.getElementById("checkout-bank-view");
    const bankFields = document.getElementById("checkout-bank-form-fields");
    const walletView = document.getElementById("checkout-wallet-view");
    const submitBtn = document.getElementById("btn-submit-upgrade");

    if (method === "bank") {
      btnBank.style.borderColor = "var(--color-primary)";
      btnBank.style.background = "rgba(46, 196, 160, 0.08)";
      btnWallet.style.borderColor = "";
      btnWallet.style.background = "";

      bankView.classList.remove("hidden");
      bankFields.classList.remove("hidden");
      walletView.classList.add("hidden");

      document.getElementById("payment-txid").setAttribute("required", "");
      document.getElementById("payment-slip").setAttribute("required", "");
      submitBtn.textContent = "Submit Verification Request";
    } else {
      btnWallet.style.borderColor = "var(--color-primary)";
      btnWallet.style.background = "rgba(46, 196, 160, 0.08)";
      btnBank.style.borderColor = "";
      btnBank.style.background = "";

      bankView.classList.add("hidden");
      bankFields.classList.add("hidden");
      walletView.classList.remove("hidden");

      document.getElementById("payment-txid").removeAttribute("required");
      document.getElementById("payment-slip").removeAttribute("required");

      const plan = document.getElementById("payment-plan").value;
      const getPriceUSD = (p) => {
        switch (p) {
          case "7 Days": return 5.00;
          case "2 Weeks": return 9.67;
          case "1 Month": return 16.67;
          case "3 Months": return 36.67;
          case "Lifetime": return 66.67;
          default: return 16.67;
        }
      };
      submitBtn.textContent = `Pay $${getPriceUSD(plan).toFixed(2)} with Wallet`;
    }
  };

  // Deposit input conversions
  const depositAmtUSD = document.getElementById("deposit-amount-usd");
  const depositAmtLKR = document.getElementById("deposit-amount-lkr");
  if (depositAmtUSD && depositAmtLKR) {
    depositAmtUSD.addEventListener("input", (e) => {
      const usdVal = parseFloat(e.target.value) || 0;
      const lkrVal = Math.round(usdVal * 300);
      depositAmtLKR.textContent = `Rs. ${lkrVal.toLocaleString()}/=`;
    });
  }

  // Wallet Deposit form submission
  const walletDepositForm = document.getElementById("wallet-deposit-form");
  if (walletDepositForm) {
    walletDepositForm.addEventListener("submit", async (e) => {
      e.preventDefault();
      const usdAmount = parseFloat(document.getElementById("deposit-amount-usd").value);
      const txid = document.getElementById("deposit-txid").value.trim();
      const msgEl = document.getElementById("deposit-msg");
      const submitBtn = document.getElementById("btn-submit-deposit");
      const progressWrap = document.getElementById("deposit-upload-progress-wrap");
      const progressBar = document.getElementById("deposit-upload-progress-bar");
      const progressPct = document.getElementById("deposit-upload-progress-pct");
      
      const setProgress = (pct) => {
        if (progressBar) progressBar.style.width = pct + "%";
        if (progressPct) progressPct.textContent = pct + "%";
      };

      if (!state.user) {
        msgEl.className = "status-message text-red";
        msgEl.textContent = "Error: You must be logged in to deposit.";
        return;
      }

      if (isNaN(usdAmount) || usdAmount <= 0) {
        msgEl.className = "status-message text-red";
        msgEl.textContent = "Please enter a valid amount.";
        return;
      }

      if (submitBtn) { submitBtn.disabled = true; submitBtn.textContent = "Submitting Request..."; }
      msgEl.className = "status-message text-yellow";
      msgEl.textContent = "Uploading slip...";

      try {
        const fileInput = document.getElementById("deposit-slip");
        let slipUrl = null;
        if (fileInput && fileInput.files.length > 0) {
          const file = fileInput.files[0];
          try {
            if (progressWrap) progressWrap.classList.remove("hidden");
            setProgress(0);
            
            const storageRef = ref(storage, `deposit_slips/${state.user.uid}/${Date.now()}_${file.name}`);
            const uploadTask = uploadBytesResumable(storageRef, file);
            
            slipUrl = await new Promise((resolve, reject) => {
              const timeoutId = setTimeout(() => {
                reject(new Error("Upload timed out (7 seconds limit)."));
              }, 7000);
              
              uploadTask.on("state_changed", 
                (snapshot) => {
                  const pct = Math.round((snapshot.bytesTransferred / snapshot.totalBytes) * 100);
                  setProgress(isNaN(pct) ? 0 : pct);
                },
                (error) => {
                  clearTimeout(timeoutId);
                  reject(error);
                },
                async () => {
                  clearTimeout(timeoutId);
                  try {
                    setProgress(100);
                    const url = await getDownloadURL(uploadTask.snapshot.ref);
                    resolve(url);
                  } catch (err) {
                    reject(err);
                  }
                }
              );
            });
            await new Promise(r => setTimeout(r, 600));
          } catch (uploadErr) {
            console.error("Slip upload failed:", uploadErr);
            msgEl.className = "status-message text-red";
            msgEl.textContent = `⚠️ receipt upload failed: ${uploadErr.message}.`;
            throw uploadErr;
          } finally {
            if (progressWrap) progressWrap.classList.add("hidden");
            setProgress(0);
          }
        }

        const userRef = doc(db, "users", state.user.uid);
        await updateDoc(userRef, {
          topupStatus: "pending",
          topupAmount: usdAmount,
          topupTxid: txid,
          topupSlipUrl: slipUrl,
          topupRequestedAt: new Date().toISOString()
        });

        if (state.profile) {
          state.profile.topupStatus = "pending";
          state.profile.topupAmount = usdAmount;
        }

        msgEl.className = "status-message text-green";
        msgEl.textContent = "✅ Top-Up request submitted! Wallet will be credited shortly.";
        walletDepositForm.reset();
        if (depositAmtLKR) depositAmtLKR.textContent = "Rs. 0/=";

        loadAccountPage();
      } catch (err) {
        msgEl.className = "status-message text-red";
        msgEl.textContent = "Error: " + err.message;
      } finally {
        if (submitBtn) { submitBtn.disabled = false; submitBtn.textContent = "Submit Top-Up Request"; }
      }
    });
  }
}

// Signals Page Logic
let signalsPageState = {
  allSignals: [],
  searchQuery: "",
  directionFilter: "all",
  tierFilter: "all",
  statusFilter: "all",
  sortBy: "confluence",
  currentPage: 1,
  pageSize: 12,
  onDemandSignal: null,
  onDemandScanning: false,
  onDemandSymbol: ""
};

function loadSignalsPage() {
  const container = document.getElementById("signals-list");
  if (!container) return;
  
  container.innerHTML = `<div class="loading-spinner">Loading Crypto Signals...</div>`;

  const status = state.profile?.role === "admin" ? "admin" : state.profile?.premiumStatus || "free";

  // Setup Scanner Status Bar hook
  const progressContainer = document.getElementById("scanner-progress-container");
  const progressText = document.getElementById("scanner-progress-text");
  const progressFill = document.getElementById("scanner-progress-fill");
  const progressDetail = document.getElementById("scanner-status-detail");
  const progressSignalsFound = document.getElementById("scanner-signals-found");

  window.onScanProgress = (current, total, signalsFound) => {
    if (progressContainer) {
      progressContainer.classList.remove("hidden");
    }
    const pct = Math.round((current / total) * 100);
    if (progressText) progressText.textContent = `${current}/${total} Coins`;
    if (progressFill) progressFill.style.width = `${pct}%`;
    if (progressDetail) progressDetail.textContent = `Analyzing indicators for confluence setups... (${pct}%)`;
    if (progressSignalsFound) progressSignalsFound.textContent = `${signalsFound} active setups discovered`;

    if (current === total) {
      if (progressDetail) progressDetail.textContent = "Market scan complete!";
      setTimeout(() => {
        if (progressContainer) progressContainer.classList.add("hidden");
      }, 3000);
    }
  };

  // Wire up filter controls (once)
  const searchInput = document.getElementById("signals-search");
  const directionFilter = document.getElementById("signals-direction-filter");
  const tierFilter = document.getElementById("signals-tier-filter");
  const statusFilter = document.getElementById("signals-status-filter");
  const sortBySelect = document.getElementById("signals-sort-by");

  if (searchInput && !searchInput.dataset.listenerWired) {
    searchInput.dataset.listenerWired = "true";
    searchInput.addEventListener("input", (e) => {
      signalsPageState.searchQuery = e.target.value;
      signalsPageState.currentPage = 1; // Reset to page 1 on search
      signalsPageState.onDemandSignal = null; // Clear old dynamic scan on query change
      signalsPageState.onDemandSymbol = "";
      renderFilteredSignals();
    });
  }

  if (directionFilter && !directionFilter.dataset.listenerWired) {
    directionFilter.dataset.listenerWired = "true";
    directionFilter.addEventListener("change", (e) => {
      signalsPageState.directionFilter = e.target.value;
      signalsPageState.currentPage = 1;
      renderFilteredSignals();
    });
  }

  if (tierFilter && !tierFilter.dataset.listenerWired) {
    tierFilter.dataset.listenerWired = "true";
    tierFilter.addEventListener("change", (e) => {
      signalsPageState.tierFilter = e.target.value;
      signalsPageState.currentPage = 1;
      renderFilteredSignals();
    });
  }

  if (statusFilter && !statusFilter.dataset.listenerWired) {
    statusFilter.dataset.listenerWired = "true";
    statusFilter.addEventListener("change", (e) => {
      signalsPageState.statusFilter = e.target.value;
      signalsPageState.currentPage = 1;
      renderFilteredSignals();
    });
  }

  if (sortBySelect && !sortBySelect.dataset.listenerWired) {
    sortBySelect.dataset.listenerWired = "true";
    sortBySelect.addEventListener("change", (e) => {
      signalsPageState.sortBy = e.target.value;
      renderFilteredSignals();
    });
  }

  activeUnsubscribes.signals = subscribeToSignals(status, (signals) => {
    signalsPageState.allSignals = signals;
    renderFilteredSignals();
  });
}

function renderFilteredSignals() {
  const container = document.getElementById("signals-list");
  const paginationContainer = document.getElementById("signals-pagination");
  if (!container) return;

  let filtered = [...signalsPageState.allSignals];

  // 1. Filter by Search Query (coin name)
  const q = signalsPageState.searchQuery.trim().toLowerCase();
  if (q) {
    filtered = filtered.filter(sig => 
      sig.pair.toLowerCase().includes(q) || 
      sig.symbol?.toLowerCase().includes(q)
    );
  }

  // 2. Filter by Direction
  if (signalsPageState.directionFilter !== "all") {
    filtered = filtered.filter(sig => 
      sig.direction.toLowerCase() === signalsPageState.directionFilter
    );
  }

  // 3. Filter by Tier
  if (signalsPageState.tierFilter !== "all") {
    filtered = filtered.filter(sig => 
      sig.tier?.toLowerCase() === signalsPageState.tierFilter
    );
  }

  // 4. Filter by Status
  if (signalsPageState.statusFilter !== "all") {
    filtered = filtered.filter(sig => 
      sig.status?.toLowerCase() === signalsPageState.statusFilter
    );
  }

  // 5. Apply Sorting
  if (signalsPageState.sortBy === "confluence") {
    filtered.sort((a, b) => (b.confluenceScore || 0) - (a.confluenceScore || 0));
  } else if (signalsPageState.sortBy === "accuracy") {
    filtered.sort((a, b) => parseFloat(b.accuracy || 0) - parseFloat(a.accuracy || 0));
  } else if (signalsPageState.sortBy === "newest") {
    filtered.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
  }

  // 6. Handle dynamic on-demand dynamic scanning if no signal matches search query
  if (filtered.length === 0 && q.length >= 2) {
    const cleanQ = q.toUpperCase().replace("/", "");
    // Find matching symbol in the 550+ global list
    const matchedSymbol = window.allBinanceUsdtPairs?.find(sym => 
      sym === cleanQ || 
      sym === cleanQ + "USDT" || 
      sym.replace("USDT", "") === cleanQ
    );

    if (matchedSymbol) {
      if (signalsPageState.onDemandSymbol !== matchedSymbol) {
        // Trigger scan!
        signalsPageState.onDemandSymbol = matchedSymbol;
        signalsPageState.onDemandScanning = true;
        signalsPageState.onDemandSignal = null;
        
        container.innerHTML = `
          <div class="empty-state" style="grid-column: 1 / -1; padding: 40px; text-align: center;">
            <div class="loading-spinner" style="margin-bottom: 15px; border-top-color: var(--color-primary);"></div>
            <p style="font-weight: 700; color: #fff;">Running real-time TA analysis for ${matchedSymbol}...</p>
            <p class="text-gray" style="font-size:0.85rem; margin-top:5px;">Checking RSI, MACD, EMA alignments, and Bollinger Bands across 150 candles.</p>
          </div>
        `;
        
        analyseSymbol(matchedSymbol, "1h", true).then(result => {
          signalsPageState.onDemandScanning = false;
          if (result) {
            signalsPageState.onDemandSignal = result;
          } else {
            signalsPageState.onDemandSignal = "failed";
          }
          renderFilteredSignals();
        }).catch(err => {
          console.error("On-demand scan failed:", err);
          signalsPageState.onDemandScanning = false;
          signalsPageState.onDemandSignal = "failed";
          renderFilteredSignals();
        });
        return;
      }
    }
  }

  // Clear grid
  container.innerHTML = "";

  // Render on-demand card if available
  let displayList = [...filtered];
  if (signalsPageState.onDemandSignal && signalsPageState.onDemandSignal !== "failed" && signalsPageState.onDemandSignal !== "scanning") {
    displayList.unshift(signalsPageState.onDemandSignal);
  }

  if (displayList.length === 0) {
    container.innerHTML = `<div class="empty-state" style="grid-column: 1 / -1;">No setups match your filters. Try searching for a different symbol.</div>`;
    if (paginationContainer) paginationContainer.innerHTML = "";
    return;
  }

  // 7. Apply Pagination
  const totalItems = displayList.length;
  const totalPages = Math.ceil(totalItems / signalsPageState.pageSize);
  const startIdx = (signalsPageState.currentPage - 1) * signalsPageState.pageSize;
  const endIdx = startIdx + signalsPageState.pageSize;
  const paginatedList = displayList.slice(startIdx, endIdx);

  // Render Signals Grid
  paginatedList.forEach((sig, renderIdx) => {
    const card = document.createElement("div");
    
    let cardClass = "signal-card";
    let sideBadgeClass = "badge-neutral";
    let statusClass = "status-pending";

    if (sig.direction.toLowerCase() === "buy") {
      cardClass += " card-buy";
      sideBadgeClass = "badge-buy";
    } else if (sig.direction.toLowerCase() === "sell") {
      cardClass += " card-sell";
      sideBadgeClass = "badge-sell";
    } else {
      cardClass += " card-neutral";
      sideBadgeClass = "badge-neutral";
    }

    if (sig.status === "Win") {
      statusClass = "status-win";
    } else if (sig.status === "Loss") {
      statusClass = "status-loss";
    } else if (sig.direction === "NEUTRAL") {
      statusClass = "status-neutral";
    }

    const targetsList = sig.targets.map((t, idx) => `<li>Target ${idx + 1}: <span class="text-white font-medium">${t}</span></li>`).join("");
    const purchasedSignals = state.profile?.purchasedSignals || [];
    const isPurchased = purchasedSignals.includes(sig.id);
    const isLocked = sig.locked && !isPurchased;
    
    // Generate TradingView chart link for the pair
    const tvSymbol = sig.symbol ? sig.symbol.replace("USDT", "") + "USDT" : sig.pair.replace("/", "");
    const tvLink = `https://www.tradingview.com/chart/?symbol=BINANCE:${tvSymbol}`;

    // Time ago formatting
    const timeAgo = sig.createdAt ? (() => {
      const diff = Date.now() - new Date(sig.createdAt).getTime();
      const m = Math.floor(diff / 60000);
      const h = Math.floor(m / 60);
      if (h > 0) return `${h}h ago`;
      if (m > 0) return `${m}m ago`;
      return 'Just now';
    })() : '';
    
    let html = "";
    if (isLocked) {
      const getPrice = (score) => {
        const parsed = parseInt(score) || 6;
        const calculated = 0.10 + (parsed - 5) * 0.15;
        return parseFloat(Math.min(1.00, Math.max(0.10, calculated)).toFixed(2));
      };
      const price = getPrice(sig.confluenceScore);

      card.className = "signal-card locked-card";
      html = `
        <div class="signal-card-top-bar"></div>
        <div class="signal-card-inner">
          <div class="lock-overlay">
            <svg class="lock-icon" fill="currentColor" viewBox="0 0 20 20"><path d="M10 2a5 5 0 00-5 5v2a2 2 0 00-2 2v5a2 2 0 002 2h10a2 2 0 002-2v-5a2 2 0 00-2-2V7a5 5 0 00-5-5zM7 7a3 3 0 016 0v2H7V7z"></path></svg>
            <h4 class="lock-title">VIP Premium Signal – ${sig.pair}</h4>
            <p class="lock-desc">TA-Verified signal with up to 98% accuracy. Unlock with Premium or buy individually.</p>
            <div style="display:flex; gap:10px; flex-wrap:wrap; justify-content:center; margin-top:8px;">
              <a href="#account" class="btn btn-primary btn-sm">Unlock with Premium</a>
              <button class="btn btn-secondary btn-sm btn-buy-signal" data-id="${sig.id}" data-pair="${sig.pair}" data-confluence="${sig.confluenceScore || 6}">
                Buy Signal ($${price.toFixed(2)})
              </button>
            </div>
          </div>
          <div class="signal-header blurred">
            <div>
              <h3 class="signal-pair">${sig.pair}</h3>
              <div class="signal-pair-sub">
                <span class="signal-direction">${sig.direction}</span>
                <span class="signal-timeframe">${sig.timeframe || '1H'}</span>
              </div>
            </div>
            <span class="signal-status-badge">🔒 VIP</span>
          </div>
          <div class="signal-body blurred">
            <div class="signal-detail"><span>Entry Target</span><strong>•••</strong></div>
            <div class="signal-detail"><span>Stop Loss</span><strong>•••</strong></div>
          </div>
        </div>
      `;
    } else {
      card.className = cardClass;
      card.style.animationDelay = `${renderIdx * 0.06}s`;
      
      const leverageLabel = sig.direction === "NEUTRAL" ? "Dynamic" : `${sig.leverage || "10x"}`;
      const statusLabel = sig.direction === "NEUTRAL" ? "Monitoring" : `${sig.status || "Pending"}`;
      
      const metaBadges = `
        <div class="signal-meta-row">
          <span class="meta-badge leverage-badge">⚡ ${leverageLabel}</span>
          ${sig.rrr ? `<span class="meta-badge rrr-badge">⚖️ R:R ${sig.rrr}</span>` : ""}
          ${sig.rsi ? `<span class="meta-badge rsi-badge">📊 RSI ${sig.rsi}</span>` : ""}
          ${sig.confluenceScore !== undefined ? `<span class="meta-badge confluence-badge">✨ Score ${sig.confluenceScore}</span>` : ""}
          ${sig.accuracy ? `<span class="meta-badge accuracy-badge">🎯 ${sig.accuracy}</span>` : ""}
          ${sig.direction === "NEUTRAL" ? `<span class="meta-badge free-badge" style="color:#ffaa00;">DYNAMIC SCAN</span>` : (sig.tier === "free" ? `<span class="meta-badge free-badge">FREE Signal</span>` : `<span class="meta-badge vip-badge">⭐ VIP</span>`)}
        </div>
      `;

      html = `
        <div class="signal-card-top-bar"></div>
        <div class="signal-card-inner">
          <div class="signal-header">
            <div>
              <h3 class="signal-pair">${sig.pair}</h3>
              <div class="signal-pair-sub">
                <span class="signal-direction ${sideBadgeClass}">${sig.direction}</span>
                <span class="signal-timeframe">${sig.timeframe || '1H'}</span>
              </div>
            </div>
            <span class="signal-status-badge ${statusClass}">${statusLabel}</span>
          </div>
          <div class="signal-body">
            <div class="signal-detail">
              <span>Entry Target</span>
              <strong>${sig.entry}</strong>
            </div>
            <div class="signal-detail">
              <span>Stop Loss</span>
              <strong style="color: var(--color-sell);">${sig.stopLoss}</strong>
            </div>
            <div class="signal-targets">
              <span>Take Profit Targets</span>
              <ul>${targetsList}</ul>
            </div>
          </div>
          <div class="signal-analysis">
            <div class="analysis-title">🔬 Confluence Analysis</div>
            <div class="analysis-text">${sig.analysisText || 'Multi-indicator real-time market analysis'}</div>
          </div>
          ${metaBadges}
        </div>
        <div class="signal-card-footer">
          <span class="signal-timestamp">${timeAgo}</span>
          <a href="${tvLink}" target="_blank" rel="noopener" class="btn-tradingview" title="View ${sig.pair} chart on TradingView">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor">
              <path d="M4.459 4.208c.746.606 1.026.56 2.428.466l13.215-.793c.28 0 .047-.28-.046-.326L17.86 1.968c-.42-.326-.981-.7-2.055-.607L3.01 2.295c-.466.046-.56.28-.374.466zm.793 3.08v13.904c0 .747.373 1.027 1.214.98l14.523-.84c.841-.046.935-.56.935-1.167V6.354c0-.606-.233-.933-.748-.887l-15.177.887c-.56.047-.747.327-.747.933zm14.337.745c.093.42 0 .84-.42.888l-.7.14v10.264c-.608.327-1.168.514-1.635.514-.748 0-.935-.234-1.495-.933l-4.577-7.186v6.952L12.21 19s0 .84-1.168.84l-3.222.186c-.093-.186 0-.653.327-.746l.84-.233V9.854L7.822 9.76c-.094-.42.14-1.026.793-1.073l3.456-.233 4.764 7.279v-6.44l-1.215-.14c-.093-.514.28-.887.747-.933zM1.936 1.035l13.31-.98c1.634-.14 2.055-.047 3.082.7l4.249 2.986c.7.513.934.653.934 1.213v16.378c0 1.026-.373 1.634-1.68 1.726l-15.458.934c-.98.047-1.448-.093-1.962-.747l-3.129-4.06c-.56-.747-.793-1.306-.793-1.96V2.667c0-.839.374-1.54 1.447-1.632z"/>
            </svg>
            Chart on TradingView
          </a>
        </div>
      `;
    }

    card.innerHTML = html;
    container.appendChild(card);
  });

  // Attach Buy Signal click listeners
  document.querySelectorAll(".btn-buy-signal").forEach(btn => {
    btn.addEventListener("click", async (e) => {
      const sigId = e.currentTarget.getAttribute("data-id");
      const pair = e.currentTarget.getAttribute("data-pair");
      const confluence = parseFloat(e.currentTarget.getAttribute("data-confluence"));
      const getPrice = (score) => {
        const parsed = parseInt(score) || 6;
        const calculated = 0.10 + (parsed - 5) * 0.15;
        return parseFloat(Math.min(1.00, Math.max(0.10, calculated)).toFixed(2));
      };
      const price = getPrice(confluence);

      if (!state.user) {
        alert("Please login first to purchase signals.");
        window.location.hash = "#auth";
        return;
      }

      const balance = state.profile?.walletBalance || 0;
      if (balance < price) {
        alert(`Insufficient balance. This signal costs $${price.toFixed(2)}, but you only have $${balance.toFixed(2)}. Please top up your wallet.`);
        window.location.hash = "#account";
        setTimeout(() => {
          const panel = document.getElementById("wallet-topup-panel");
          if (panel) panel.scrollIntoView({ behavior: "smooth" });
        }, 300);
        return;
      }

      if (confirm(`Are you sure you want to purchase the ${pair} premium signal for $${price.toFixed(2)} from your wallet balance?`)) {
        try {
          showLoading(true);
          const newBalance = parseFloat((balance - price).toFixed(2));
          const currentPurchased = state.profile.purchasedSignals || [];
          
          const userRef = doc(db, "users", state.user.uid);
          await updateDoc(userRef, {
            walletBalance: newBalance,
            purchasedSignals: [...currentPurchased, sigId]
          });

          // Update local state
          state.profile.walletBalance = newBalance;
          state.profile.purchasedSignals = [...currentPurchased, sigId];

          alert(`✅ Signal for ${pair} purchased successfully!`);
          
          // Refresh navbar & signals view
          const navWallet = document.getElementById("nav-wallet-balance");
          if (navWallet) navWallet.textContent = `$${newBalance.toFixed(2)}`;
          renderFilteredSignals();
        } catch (err) {
          alert("Error purchasing signal: " + err.message);
        } finally {
          showLoading(false);
        }
      }
    });
  });

  // Render Pagination Buttons
  if (paginationContainer) {
    if (totalPages <= 1) {
      paginationContainer.innerHTML = "";
    } else {
      paginationContainer.innerHTML = `
        <button class="pagination-btn" id="pagination-prev" ${signalsPageState.currentPage === 1 ? "disabled" : ""}>
          <svg width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><polyline points="15 18 9 12 15 6"/></svg>
          Previous
        </button>
        <span class="pagination-info">Page ${signalsPageState.currentPage} of ${totalPages}</span>
        <button class="pagination-btn" id="pagination-next" ${signalsPageState.currentPage === totalPages ? "disabled" : ""}>
          Next
          <svg width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><polyline points="9 18 15 12 9 6"/></svg>
        </button>
      `;

      const prevBtn = document.getElementById("pagination-prev");
      const nextBtn = document.getElementById("pagination-next");

      if (prevBtn) {
        prevBtn.addEventListener("click", () => {
          if (signalsPageState.currentPage > 1) {
            signalsPageState.currentPage--;
            renderFilteredSignals();
            container.scrollIntoView({ behavior: "smooth" });
          }
        });
      }

      if (nextBtn) {
        nextBtn.addEventListener("click", () => {
          if (signalsPageState.currentPage < totalPages) {
            signalsPageState.currentPage++;
            renderFilteredSignals();
            container.scrollIntoView({ behavior: "smooth" });
          }
        });
      }
    }
  }
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

      const analysisHtml = trade.analysisMethod ? `
        <div style="font-size:0.75rem; color:var(--text-muted); font-weight:normal; margin-top:4px; line-height:1.2; max-width: 280px; word-break: break-word;">
          <span style="color:var(--color-primary); font-weight:700;">AI Analysis:</span> ${trade.analysisMethod}
        </div>
      ` : "";

      const tr = document.createElement("tr");
      tr.innerHTML = `
        <td class="py-3 px-4 font-medium">
          <div>${trade.pair}</div>
          ${analysisHtml}
        </td>
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
  
  // Update win rate
  const total = wins + losses;
  const winRate = total > 0 ? ((wins / total) * 100).toFixed(1) : "0.0";
  const winRateEl = document.getElementById("bot-winrate");
  if (winRateEl) {
    winRateEl.textContent = winRate + "%";
    winRateEl.style.color = parseFloat(winRate) >= 70 ? "var(--color-buy)" : parseFloat(winRate) >= 50 ? "var(--color-gold)" : "var(--color-sell)";
  }

  const pnlEl = document.getElementById("bot-total-pnl");
  pnlEl.textContent = (totalPnl >= 0 ? "+" : "") + totalPnl.toFixed(2) + "%";
  
  if (totalPnl > 0) {
    pnlEl.style.color = "var(--color-buy)";
  } else if (totalPnl < 0) {
    pnlEl.style.color = "var(--color-sell)";
  } else {
    pnlEl.style.color = "var(--text-secondary)";
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
  
  // Color-code log entries
  let cssClass = 'log-info';
  const lowerText = text.toLowerCase();
  if (lowerText.includes('win') || lowerText.includes('take-profit') || lowerText.includes('closed') && lowerText.includes('win')) cssClass = 'log-success';
  else if (lowerText.includes('loss') || lowerText.includes('stop-loss') || lowerText.includes('error')) cssClass = 'log-error';
  else if (lowerText.includes('executing') || lowerText.includes('executed') || lowerText.includes('opened') || lowerText.includes('auto-trading')) cssClass = 'log-warn';
  else if (lowerText.includes('system') || lowerText.includes('initialized') || lowerText.includes('started') || lowerText.includes('analysis')) cssClass = 'log-system';
  
  botLogEl.innerHTML += `<div class="${cssClass}">[${time}] ${text}</div>`;
  botLogEl.scrollTop = botLogEl.scrollHeight;
  
  // Keep log to last 100 entries
  const entries = botLogEl.querySelectorAll('div');
  if (entries.length > 100) entries[0].remove();
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
  const expiresAt = state.profile?.premiumExpiresAt;
  const activePlan = state.profile?.activePlan;

  if (role === "admin" || status === "paid") {
    vipActivePanel.classList.remove("hidden");
    normalPanel.classList.add("hidden");
    pendingPanel.classList.add("hidden");

    // Inject plan + expiry info into VIP panel
    const expiryInfoEl = document.getElementById("vip-expiry-info");
    if (expiryInfoEl) {
      if (role === "admin") {
        expiryInfoEl.innerHTML = `<span class="text-yellow font-bold">🛡️ Admin Account — Lifetime Access</span>`;
      } else if (!expiresAt) {
        expiryInfoEl.innerHTML = `<span class="text-green font-bold">♾️ ${activePlan || "Lifetime"} — Lifetime Access (Never Expires)</span>`;
      } else {
        const expiry = new Date(expiresAt);
        const now = new Date();
        const daysLeft = Math.max(0, Math.ceil((expiry - now) / (1000 * 60 * 60 * 24)));
        const expiryStr = expiry.toLocaleDateString("en-GB", { weekday: "long", day: "numeric", month: "long", year: "numeric" });
        const color = daysLeft <= 3 ? "text-red" : daysLeft <= 7 ? "text-yellow" : "text-green";
        expiryInfoEl.innerHTML = `
          <div style="background: rgba(255,255,255,0.04); border: 1px solid var(--border-color); border-radius:10px; padding:14px 18px; text-align:center;">
            <div style="font-size:0.8rem; color:var(--text-muted); text-transform:uppercase; letter-spacing:.08em; margin-bottom:6px;">Active Plan</div>
            <div style="font-size:1.2rem; font-weight:800; color:var(--color-primary);">${activePlan || "VIP Premium"}</div>
            <div style="margin-top:8px; font-size:0.85rem;">Expires: <strong class="${color}">${expiryStr}</strong></div>
            <div class="${color}" style="font-size:0.8rem; margin-top:4px; font-weight:700;">${daysLeft === 0 ? "⚠️ Expires today" : `${daysLeft} day${daysLeft === 1 ? "" : "s"} remaining`}</div>
          </div>
        `;
      }
    }
  } else if (status === "pending") {
    pendingPanel.classList.remove("hidden");
    vipActivePanel.classList.add("hidden");
    normalPanel.classList.add("hidden");
  } else {
    // Covers 'free' and 'expired' — show normal upgrade panel
    normalPanel.classList.remove("hidden");
    pendingPanel.classList.add("hidden");
    vipActivePanel.classList.add("hidden");

    // Show expiry notice if account just expired
    if (status === "expired") {
      const expiredBanner = document.getElementById("expired-notice-banner");
      if (expiredBanner) expiredBanner.classList.remove("hidden");
    }
  }

  // Populate referral UI elements
  const refLinkInput = document.getElementById("referral-link-input");
  if (refLinkInput && state.user) {
    refLinkInput.value = `${window.location.origin}${window.location.pathname}?ref=${state.user.uid}`;
  }

  // Setup Clipboard Copy listener
  const copyBtn = document.getElementById("btn-copy-ref");
  const copyMsg = document.getElementById("copy-ref-msg");
  if (copyBtn && !copyBtn.dataset.listenerWired) {
    copyBtn.dataset.listenerWired = "true";
    copyBtn.addEventListener("click", () => {
      if (refLinkInput) {
        refLinkInput.select();
        navigator.clipboard.writeText(refLinkInput.value)
          .then(() => {
            copyBtn.textContent = "Copied!";
            if (copyMsg) copyMsg.textContent = "Referral link copied to clipboard!";
            setTimeout(() => {
              copyBtn.innerHTML = `
                <svg width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24" style="margin-right: 6px;">
                  <path stroke-linecap="round" stroke-linejoin="round" d="M8 5H6a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2v-1M8 5a2 2 0 002 2h2a2 2 0 002-2M8 5a2 2 0 012-2h2a2 2 0 012 2m0 0h2a2 2 0 012 2v3m2 4H10m0 0l3-3m-3 3l3 3"></path>
                </svg>Copy Link`;
              if (copyMsg) copyMsg.textContent = "";
            }, 2000);
          })
          .catch(err => {
            console.error("Failed to copy referral link:", err);
          });
      }
    });
  }

  // Helper function to mask name/email for privacy
  const maskNameOrEmail = (str) => {
    if (!str) return "User";
    if (str.includes("@")) {
      const [local, domain] = str.split("@");
      if (local.length <= 3) return `${local[0]}***@${domain}`;
      return `${local.slice(0, 3)}***@${domain}`;
    }
    if (str.length <= 3) return str;
    return `${str.slice(0, 2)}***${str.slice(-1)}`;
  };

  // Fetch referrals from Firestore
  const historyList = document.getElementById("referral-history-list");
  if (historyList && state.user) {
    historyList.innerHTML = `<tr><td colspan="4" class="text-center py-4 text-gray">Loading referrals...</td></tr>`;
    
    const referralsQuery = query(collection(db, "users"), where("referredBy", "==", state.user.uid));
    getDocs(referralsQuery)
      .then(snapshot => {
        historyList.innerHTML = "";
        let invitedCount = snapshot.size;
        let successfulCount = 0;

        if (invitedCount === 0) {
          historyList.innerHTML = `<tr><td colspan="4" class="text-center py-4 text-gray">No referrals yet. Share your link to start earning!</td></tr>`;
        } else {
          snapshot.forEach(docSnap => {
            const u = docSnap.data();
            const isProcessed = u.referralBonusProcessed || false;
            if (isProcessed) {
              successfulCount++;
            }

            const nameDisplay = maskNameOrEmail(u.displayName || u.email);
            const joinedDate = u.createdAt ? new Date(u.createdAt).toLocaleDateString("en-GB") : "—";
            
            // Status badges
            let statusLabel = "Registered (Free)";
            let badgeClass = "badge-free";
            if (u.premiumStatus === "paid") {
              statusLabel = "VIP Premium Active";
              badgeClass = "badge-vip";
            } else if (u.premiumStatus === "pending") {
              statusLabel = "Pending VIP";
              badgeClass = "badge-pending";
            } else if (u.premiumStatus === "expired") {
              statusLabel = "VIP Expired";
              badgeClass = "badge-expired";
            }

            const tr = document.createElement("tr");
            tr.innerHTML = `
              <td class="py-3 px-4 text-white font-medium">${nameDisplay}</td>
              <td class="py-3 px-4 text-gray">${joinedDate}</td>
              <td class="py-3 px-4"><span class="badge-${badgeClass}">${statusLabel}</span></td>
              <td class="py-3 px-4 ${isProcessed ? 'text-green font-medium' : 'text-gray'}">${isProcessed ? '✅ 3 Days VIP' : '—'}</td>
            `;
            historyList.appendChild(tr);
          });
        }

        // Update stats counters
        const totalEl = document.getElementById("ref-count-total");
        const successfulEl = document.getElementById("ref-count-successful");
        const earnedEl = document.getElementById("ref-total-earned");

        if (totalEl) totalEl.textContent = invitedCount;
        if (successfulEl) successfulEl.textContent = successfulCount;
        if (earnedEl) {
          const totalEarned = state.profile?.totalReferralEarnings || 0;
          earnedEl.textContent = `$${totalEarned.toFixed(2)}`;
        }
      })
      .catch(err => {
        console.error("Error loading referrals list:", err);
        historyList.innerHTML = `<tr><td colspan="4" class="text-center py-4 text-red">Error loading referrals list.</td></tr>`;
      });
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
        // Extract requested plan from paymentPlan field or default
        const requestedPlan = u.paymentPlan || "1 Month";
        div.innerHTML = `
          <div>
            <h4 class="text-white font-medium">${u.displayName || u.email}</h4>
            <p class="text-sm text-gray mt-1">TxID/Ref: <span class="text-yellow font-mono">${u.paymentTxid}</span></p>
            <p class="text-sm text-gray mt-1">Plan Requested: <span class="text-green font-bold">${requestedPlan}</span></p>
            <p class="text-xs text-gray mt-1">Requested: ${new Date(u.paymentRequestedAt).toLocaleString()}</p>
            ${u.paymentSlipUrl ? `<img src="${u.paymentSlipUrl}" class="payment-slip-thumb cursor-pointer" style="max-width:100px; margin-top:8px; border:1px solid var(--border-color);" onclick="openSlipModal('${u.paymentSlipUrl}')"/>` : ''}
          </div>
          <div class="action-buttons" style="display:flex;flex-direction:column;gap:8px;min-width:160px;">
            <select class="form-control plan-select" data-id="${u.uid}" style="font-size:0.8rem;padding:6px 10px;">
              <option value="7 Days" ${requestedPlan === '7 Days' ? 'selected' : ''}>7 Days</option>
              <option value="2 Weeks" ${requestedPlan === '2 Weeks' ? 'selected' : ''}>2 Weeks</option>
              <option value="1 Month" ${requestedPlan === '1 Month' ? 'selected' : ''}>1 Month</option>
              <option value="3 Months" ${requestedPlan === '3 Months' ? 'selected' : ''}>3 Months</option>
              <option value="Lifetime" ${requestedPlan === 'Lifetime' ? 'selected' : ''}>Lifetime</option>
            </select>
            <div style="display:flex;gap:6px;">
              <button class="btn btn-primary btn-sm btn-approve" data-id="${u.uid}">✅ Accept</button>
              <button class="btn btn-secondary btn-sm btn-reject" data-id="${u.uid}">❌ Reject</button>
            </div>
          </div>
        `;
        pendingList.appendChild(div);
      });

      // Attach event listeners for Accept/Reject buttons
      document.querySelectorAll(".btn-approve").forEach(btn => {
        btn.addEventListener("click", async (e) => {
          const uid = e.target.getAttribute("data-id");
          // Get the plan from the sibling select
          const card = e.target.closest(".payment-request-card");
          const planSelect = card ? card.querySelector(".plan-select") : null;
          const chosenPlan = planSelect ? planSelect.value : "1 Month";
          e.target.disabled = true;
          e.target.textContent = "Activating...";
          await approvePremium(uid, chosenPlan);
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

    // 1b. Pending Top-Up Approvals
    const pendingTopupsList = document.getElementById("admin-pending-topups");
    if (pendingTopupsList) {
      pendingTopupsList.innerHTML = "";
      const pendingTopupUsers = users.filter(u => u.topupStatus === "pending");
      
      if (pendingTopupUsers.length === 0) {
        pendingTopupsList.innerHTML = `<div class="empty-state">No pending top-up verification requests.</div>`;
      } else {
        pendingTopupUsers.forEach(u => {
          const div = document.createElement("div");
          div.className = "payment-request-card";
          div.innerHTML = `
            <div>
              <h4 class="text-white font-medium">${u.displayName || u.email}</h4>
              <p class="text-sm text-gray mt-1">TxID/Ref: <span class="text-yellow font-mono">${u.topupTxid}</span></p>
              <p class="text-sm text-gray mt-1">Deposit Amount: <span class="text-green font-bold">$${(u.topupAmount || 0).toFixed(2)}</span></p>
              <p class="text-xs text-gray mt-1">Requested: ${new Date(u.topupRequestedAt).toLocaleString()}</p>
              ${u.topupSlipUrl ? `<img src="${u.topupSlipUrl}" class="payment-slip-thumb cursor-pointer" style="max-width:100px; margin-top:8px; border:1px solid var(--border-color);" onclick="openSlipModal('${u.topupSlipUrl}')"/>` : ''}
            </div>
            <div class="action-buttons" style="display:flex;gap:6px;align-items:center;">
              <button class="btn btn-primary btn-sm btn-approve-topup" data-id="${u.uid}">✅ Accept</button>
              <button class="btn btn-secondary btn-sm btn-reject-topup" data-id="${u.uid}">❌ Reject</button>
            </div>
          `;
          pendingTopupsList.appendChild(div);
        });

        document.querySelectorAll(".btn-approve-topup").forEach(btn => {
          btn.addEventListener("click", async (e) => {
            const uid = e.target.getAttribute("data-id");
            e.target.disabled = true;
            e.target.textContent = "Crediting...";
            await approveTopup(uid);
          });
        });

        document.querySelectorAll(".btn-reject-topup").forEach(btn => {
          btn.addEventListener("click", async (e) => {
            const uid = e.target.getAttribute("data-id");
            e.target.disabled = true;
            e.target.textContent = "Rejecting...";
            await rejectTopup(uid);
          });
        });
      }
    }

    // 2. User Accounts win/loss listing
    if (users.length === 0) {
      userList.innerHTML = `<tr><td colspan="5" class="text-center py-3 text-gray">No users registered in system.</td></tr>`;
    } else {
      users.forEach(u => {
        const winLoss = u.winLoss || { wins: 0, losses: 0 };
        const total = winLoss.wins + winLoss.losses;
        const winrate = total > 0 ? ((winLoss.wins / total) * 100).toFixed(1) + "%" : "0%";

        // Compute expiry display
        let expiryDisplay = "—";
        if (u.premiumStatus === "paid") {
          if (!u.premiumExpiresAt) {
            expiryDisplay = `<span class="text-green font-bold">♾️ Lifetime</span>`;
          } else {
            const exp = new Date(u.premiumExpiresAt);
            const now = new Date();
            const daysLeft = Math.max(0, Math.ceil((exp - now) / (1000 * 60 * 60 * 24)));
            const color = daysLeft <= 3 ? "text-red" : daysLeft <= 7 ? "text-yellow" : "text-green";
            expiryDisplay = `<span class="${color} font-bold">${exp.toLocaleDateString("en-GB")} (${daysLeft}d left)</span>`;
          }
        } else if (u.premiumStatus === "expired") {
          expiryDisplay = `<span class="text-red">Expired</span>`;
        }
        
        const statusBadgeClass = u.premiumStatus === 'paid' ? 'buy' : u.premiumStatus === 'pending' ? 'pending' : 'sell';
        const tr = document.createElement("tr");
        tr.innerHTML = `
          <td class="py-3 px-4 text-white font-medium">${u.displayName || "No Name"}</td>
          <td class="py-3 px-4">${u.email}</td>
          <td class="py-3 px-4"><span class="badge-${statusBadgeClass}">${(u.premiumStatus || "free").toUpperCase()}</span></td>
          <td class="py-3 px-4">${u.activePlan ? `<span class="text-yellow font-bold">${u.activePlan}</span>` : "—"} ${expiryDisplay}</td>
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

