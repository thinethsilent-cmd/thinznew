// Common core logic for the multi‑page site
// Derived from the original js/app.js with hash‑router removed.
// Provides global state, Firebase auth handling, UI helpers, and page‑specific loaders.

import { observeAuthState, signIn, signUp, signOutUser, getUserDoc, signInWithGoogle } from "./auth.js";
import { subscribeToSignals, createSignal, updateSignalStatus, deleteSignal, analyseSymbol } from "./signals.js";
import { subscribeToTrades, startAutoTrading, stopAutoTrading, saveApiKeys } from "./bot.js";
import { subscribeToAllUsers, approvePremium, rejectPremium, approveTopup, rejectTopup } from "./admin.js";
import { auth, db, storage } from "./firebase-config.js";
import { doc, updateDoc, collection, query, where, getDocs, getDoc } from "https://www.gstatic.com/firebasejs/12.15.0/firebase-firestore.js";
import { ref, uploadBytesResumable, getDownloadURL } from "https://www.gstatic.com/firebasejs/12.15.0/firebase-storage.js";

// Global app state
export let state = {
  user: null,
  profile: null,
  botRunning: false,
};

// Active listeners for cleanup when navigating between pages
export let activeUnsubscribes = {
  signals: null,
  trades: null,
  users: null,
  messages: null,
};

// DOM elements that exist on every page (navigation, profile, badge)
export const navLinks = document.querySelectorAll("[data-target]");
export const authLinks = document.querySelectorAll(".auth-link");
export const guestLinks = document.querySelectorAll(".guest-link");
export const adminLink = document.getElementById("nav-admin-link");
export const profileSection = document.getElementById("nav-profile");
export const profileName = document.getElementById("nav-profile-name");
export const premiumBadge = document.getElementById("nav-premium-badge");

// ------------------------------------------------------------------
// UI Helper functions
export function showLoading(show) {
  const loader = document.getElementById("global-loader");
  if (loader) loader.classList.toggle("hidden", !show);
}

export function updatePlanBadge(status) {
  if (!premiumBadge) return;
  premiumBadge.className = "plan-badge";
  premiumBadge.classList.remove("badge-vip", "badge-pending", "badge-free");
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

export function openSlipModal(url) {
  const modal = document.getElementById('slip-modal');
  const img = document.getElementById('slip-modal-img');
  if (modal && img) {
    img.src = url;
    modal.classList.remove('hidden');
  }
}
export function closeSlipModal() {
  const modal = document.getElementById('slip-modal');
  if (modal) modal.classList.add('hidden');
}
window.openSlipModal = openSlipModal;
window.closeSlipModal = closeSlipModal;

// ------------------------------------------------------------------
// Authentication listener – updates UI and global state
export function initAuthListeners() {
  observeAuthState((user, profile) => {
    state.user = user;
    state.profile = profile;
    if (user) {
      // Authenticated UI
      authLinks.forEach(el => el.classList.remove('hidden'));
      guestLinks.forEach(el => el.classList.add('hidden'));
      if (profileSection) profileSection.classList.remove('hidden');
      if (profileName) profileName.textContent = profile?.displayName || user.email.split('@')[0];
      if (adminLink) {
        if (profile?.role === 'admin') adminLink.classList.remove('hidden');
        else adminLink.classList.add('hidden');
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

      updatePlanBadge(profile?.premiumStatus);

      // Real-time user inbox listener
      import("./messages.js").then(({ subscribeToUserMessages, markMessageRead }) => {
        if (activeUnsubscribes.messages) {
          activeUnsubscribes.messages();
        }
        activeUnsubscribes.messages = subscribeToUserMessages(user.uid, (msgs) => {
          const listEl = document.getElementById("inbox-messages-list");
          const unreadBadge = document.getElementById("inbox-unread-badge");
          const unreadLabel = document.getElementById("inbox-unread-count-label");

          const unreadCount = msgs.filter(m => !m.read).length;

          if (unreadBadge) {
            unreadBadge.textContent = unreadCount;
            unreadBadge.classList.toggle("hidden", unreadCount === 0);
          }
          if (unreadLabel) {
            unreadLabel.textContent = unreadCount;
            unreadLabel.classList.toggle("hidden", unreadCount === 0);
          }

          if (listEl) {
            listEl.innerHTML = "";
            if (msgs.length === 0) {
              listEl.innerHTML = '<div class="text-center text-gray py-4">No messages in your inbox.</div>';
              return;
            }
            msgs.forEach(m => {
              const card = document.createElement("div");
              card.className = "message-inbox-card";
              card.style.background = m.read ? "rgba(255,255,255,0.01)" : "rgba(46,196,160,0.04)";
              card.style.border = m.read ? "1px solid rgba(255,255,255,0.05)" : "1px solid rgba(46,196,160,0.2)";
              card.style.borderRadius = "12px";
              card.style.padding = "16px";
              card.style.position = "relative";
              card.style.cursor = "pointer";

              const date = new Date(m.createdAt).toLocaleDateString("en-GB") + " " + new Date(m.createdAt).toLocaleTimeString([], {hour: '2-digit', minute:'2-digit'});
              const giftMarkup = m.giftAmount > 0 ? `
                <div style="margin-top:10px;display:inline-flex;align-items:center;gap:6px;background:rgba(0,255,136,0.1);border:1px solid rgba(0,255,136,0.2);padding:4px 10px;border-radius:20px;font-size:0.75rem;color:#00e676;font-weight:700;">
                  🎁 Gift: +$${m.giftAmount.toFixed(2)}
                </div>` : "";
              
              const dotMarkup = m.read ? '' : `<span style="position:absolute;top:16px;right:16px;width:8px;height:8px;background:#00e676;border-radius:50%;box-shadow:0 0 8px #00e676;"></span>`;

              card.innerHTML = `
                ${dotMarkup}
                <div style="font-size:0.72rem;color:var(--text-muted);margin-bottom:4px;">${date}</div>
                <strong style="font-size:0.9rem;color:#fff;display:block;margin-bottom:4px;">${m.subject}</strong>
                <p style="margin:0;font-size:0.82rem;color:var(--text-secondary);line-height:1.4;white-space:pre-wrap;">${m.body}</p>
                ${giftMarkup}
              `;

              card.addEventListener("click", () => {
                if (!m.read) {
                  markMessageRead(m.id);
                }
              });

              listEl.appendChild(card);
            });
          }
        });
      });

    } else {
      // Logged‑out UI
      authLinks.forEach(el => el.classList.add('hidden'));
      guestLinks.forEach(el => el.classList.remove('hidden'));
      if (profileSection) profileSection.classList.add('hidden');
      if (adminLink) adminLink.classList.add('hidden');
      
      const navWallet = document.getElementById("nav-wallet-balance");
      if (navWallet) navWallet.textContent = "$0.00";

      updatePlanBadge('free');

      if (activeUnsubscribes.messages) {
        activeUnsubscribes.messages();
        activeUnsubscribes.messages = null;
      }
    }
  });
}

// Global toggle helper for user inbox panel
window.__openInbox = function() {
  const panel = document.getElementById("user-inbox-panel");
  if (panel) {
    panel.classList.toggle("hidden");
    if (!panel.classList.contains("hidden")) {
      panel.scrollIntoView({ behavior: "smooth" });
    }
  }
};

// ------------------------------------------------------------------
// Form listeners (sign‑in, sign‑up, Google, bot settings, premium request)
export function initFormListeners() {
  // ----- Sign‑Up -----
  const signupForm = document.getElementById('signup-form');
  if (signupForm) {
    signupForm.addEventListener('submit', async e => {
      e.preventDefault();
      const email = document.getElementById('signup-email').value;
      const pass = document.getElementById('signup-password').value;
      const name = document.getElementById('signup-name').value;
      const errEl = document.getElementById('signup-error');
      try {
        errEl.textContent = '';
        showLoading(true);
        const referredBy = localStorage.getItem('referred_by');
        await signUp(email, pass, name, referredBy);
        localStorage.removeItem('referred_by');
        window.location.href = 'signals.html';
      } catch (err) {
        errEl.textContent = err.message;
      } finally {
        showLoading(false);
      }
    });
  }

  // ----- Sign‑In -----
  const loginForm = document.getElementById('login-form');
  if (loginForm) {
    loginForm.addEventListener('submit', async e => {
      e.preventDefault();
      const email = document.getElementById('login-email').value;
      const pass = document.getElementById('login-password').value;
      const errEl = document.getElementById('login-error');
      try {
        errEl.textContent = '';
        showLoading(true);
        const { userData } = await signIn(email, pass);
        if (userData?.role === 'admin') window.location.href = 'admin.html';
        else window.location.href = 'signals.html';
      } catch (err) {
        errEl.textContent = err.message;
      } finally {
        showLoading(false);
      }
    });
  }

  // ----- Google Sign‑In -----
  const googleBtns = document.querySelectorAll('.btn-google-login');
  googleBtns.forEach(btn => {
    btn.addEventListener('click', async e => {
      e.preventDefault();
      const loginErr = document.getElementById('login-error');
      const signupErr = document.getElementById('signup-error');
      try {
        if (loginErr) loginErr.textContent = '';
        if (signupErr) signupErr.textContent = '';
        showLoading(true);
        const referredBy = localStorage.getItem('referred_by');
        const { userData } = await signInWithGoogle(referredBy);
        localStorage.removeItem('referred_by');
        if (userData?.role === 'admin') window.location.href = 'admin.html';
        else window.location.href = 'signals.html';
      } catch (err) {
        if (loginErr) loginErr.textContent = err.message;
        if (signupErr) signupErr.textContent = err.message;
      } finally {
        showLoading(false);
      }
    });
  });

  // ----- Bot API keys -----
  const botSettingsForm = document.getElementById('bot-settings-form');
  if (botSettingsForm) {
    botSettingsForm.addEventListener('submit', async e => {
      e.preventDefault();
      const apiKey = document.getElementById('binance-api-key').value;
      const apiSecret = document.getElementById('binance-api-secret').value;
      const msgEl = document.getElementById('bot-settings-msg');
      try {
        msgEl.className = 'status-message text-yellow';
        msgEl.textContent = 'Saving keys...';
        await saveApiKeys(state.user.uid, apiKey, apiSecret);
        msgEl.className = 'status-message text-green';
        msgEl.textContent = 'Binance API keys saved successfully!';
        setTimeout(() => (msgEl.textContent = ''), 3000);
      } catch (err) {
        msgEl.className = 'status-message text-red';
        msgEl.textContent = 'Error saving keys: ' + err.message;
      }
    });
  }

  // ----- Bot toggle -----
  const botToggle = document.getElementById('bot-toggle-btn');
  if (botToggle) {
    botToggle.addEventListener('change', e => {
      if (e.target.checked) startBotExecution();
      else stopBotExecution();
    });
  }

  // ----- Admin signal creation -----
  const addSignalForm = document.getElementById('admin-signal-form');
  if (addSignalForm) {
    addSignalForm.addEventListener('submit', async e => {
      e.preventDefault();
      const pair = document.getElementById('sig-pair').value.toUpperCase();
      const direction = document.getElementById('sig-direction').value;
      const timeframe = document.getElementById('sig-timeframe').value;
      const entry = document.getElementById('sig-entry').value;
      const targets = document.getElementById('sig-targets').value.split(',').map(t => t.trim());
      const stopLoss = document.getElementById('sig-stoploss').value;
      const msgEl = document.getElementById('admin-signal-msg');
      const signalData = { pair, direction, timeframe, entry, targets, stopLoss };
      try {
        msgEl.className = 'status-message text-yellow';
        msgEl.textContent = 'Publishing signal...';
        await createSignal(signalData);
        msgEl.className = 'status-message text-green';
        msgEl.textContent = 'Signal published successfully!';
        addSignalForm.reset();
        setTimeout(() => (msgEl.textContent = ''), 3000);
      } catch (err) {
        msgEl.className = 'status-message text-red';
        msgEl.textContent = 'Error: ' + err.message;
      }
    });
  }

  // ----- Premium upgrade UI -----
  const premiumCheckbox = document.getElementById('premium-opt-in');
  const paymentPanel = document.getElementById('payment-instructions-panel');
  const paymentForm = document.getElementById('premium-payment-form');
  if (premiumCheckbox) {
    premiumCheckbox.addEventListener('change', e => {
      if (e.target.checked) paymentPanel.classList.remove('hidden');
      else paymentPanel.classList.add('hidden');
    });
  }
  if (paymentForm) {
    paymentForm.addEventListener('submit', async e => {
      e.preventDefault();
      const method = document.getElementById('payment-method-field').value;
      const plan = document.getElementById('payment-plan').value;
      const msgEl = document.getElementById('payment-msg');
      const submitBtn = document.getElementById('btn-submit-upgrade');
      const progressWrap = document.getElementById('upload-progress-wrap');
      const progressBar = document.getElementById('upload-progress-bar');
      const progressPct = document.getElementById('upload-progress-pct');

      const setProgress = (pct) => {
        if (progressBar) progressBar.style.width = pct + '%';
        if (progressPct) progressPct.textContent = pct + '%';
      };

      if (!state.user) {
        msgEl.className = 'status-message text-red';
        msgEl.textContent = 'Error: You must be logged in to submit a request.';
        return;
      }

      if (!plan) {
        msgEl.className = 'status-message text-red';
        msgEl.textContent = 'Please select a subscription plan from the cards above first.';
        return;
      }

      const getPriceUSD = (pName) => {
        switch (pName) {
          case '7 Days': return 5.00;
          case '2 Weeks': return 9.67;
          case '1 Month': return 16.67;
          case '3 Months': return 36.67;
          case 'Lifetime': return 66.67;
          default: return 16.67;
        }
      };
      const usdPrice = getPriceUSD(plan);

      if (method === 'wallet') {
        // WALLET VIP UPGRADE FLOW
        const userBalance = state.profile?.walletBalance || 0;
        if (userBalance < usdPrice) {
          msgEl.className = 'status-message text-red';
          msgEl.textContent = `Insufficient balance. This upgrade costs $${usdPrice.toFixed(2)}, but you only have $${userBalance.toFixed(2)}. Please top up your wallet.`;
          return;
        }

        if (submitBtn) { submitBtn.disabled = true; submitBtn.textContent = 'Processing payment...'; }
        msgEl.className = 'status-message text-yellow';
        msgEl.textContent = 'Processing wallet checkout...';

        try {
          const newBalance = parseFloat((userBalance - usdPrice).toFixed(2));
          const getPlanExpiryDate = (pName) => {
            const now = new Date();
            switch (pName) {
              case '7 Days':    now.setDate(now.getDate() + 7);   break;
              case '2 Weeks':   now.setDate(now.getDate() + 14);  break;
              case '1 Month':   now.setMonth(now.getMonth() + 1); break;
              case '3 Months':  now.setMonth(now.getMonth() + 3); break;
              case 'Lifetime':  return null;
              default:          now.setMonth(now.getMonth() + 1);
            }
            return now.toISOString();
          };
          const expiresAt = getPlanExpiryDate(plan);

          const userRef = doc(db, 'users', state.user.uid);
          const userUpdates = {
            premiumStatus: 'paid',
            activePlan: plan,
            premiumActivatedAt: new Date().toISOString(),
            premiumExpiresAt: expiresAt,
            walletBalance: newBalance
          };

          // Crediting referrer 15% commission instantly
          if (state.profile?.referredBy && !state.profile?.referralBonusProcessed) {
            try {
              const referrerId = state.profile.referredBy;
              const referrerRef = doc(db, 'users', referrerId);
              const referrerSnap = await getDoc(referrerRef);
              if (referrerSnap.exists()) {
                const referrerData = referrerSnap.data();
                const commission = parseFloat((usdPrice * 0.15).toFixed(2));
                await updateDoc(referrerRef, {
                  walletBalance: parseFloat(((referrerData.walletBalance || 0) + commission).toFixed(2)),
                  totalReferralEarnings: parseFloat(((referrerData.totalReferralEarnings || 0) + commission).toFixed(2))
                });
                console.log(`Referrer ${referrerId} awarded 15% commission: $${commission}`);
                userUpdates.referralBonusProcessed = true;
              }
            } catch (err) {
              console.error('Error crediting commission in common.js:', err);
            }
          }

          await updateDoc(userRef, userUpdates);

          // Update local state
          state.profile = { ...state.profile, ...userUpdates };
          updatePlanBadge('paid');

          msgEl.className = 'status-message text-green';
          msgEl.textContent = '✅ VIP Subscription Activated Successfully using wallet balance!';

          paymentForm.reset();
          premiumCheckbox.checked = false;
          paymentPanel.classList.add('hidden');

          setTimeout(() => {
            msgEl.textContent = '';
            loadAccountPage();
          }, 2000);
        } catch (err) {
          msgEl.className = 'status-message text-red';
          msgEl.textContent = 'Payment failed: ' + err.message;
        } finally {
          if (submitBtn) { submitBtn.disabled = false; submitBtn.textContent = `Pay $${usdPrice.toFixed(2)} with Wallet`; }
        }
      } else {
        // BANK PAYMENT FLOW
        const txid = document.getElementById('payment-txid').value.trim();
        if (!txid) {
          msgEl.className = 'status-message text-red';
          msgEl.textContent = 'Please enter a valid Reference ID / TxID.';
          return;
        }

        // Disable to prevent double-submits
        if (submitBtn) { submitBtn.disabled = true; submitBtn.textContent = 'Submitting...'; }
        msgEl.className = 'status-message text-yellow';
        msgEl.textContent = 'Submitting payment details...';

        try {
          // Save to Firestore (no slip upload required)
          const userRef = doc(db, 'users', state.user.uid);
          const selectedPlan = document.getElementById('payment-plan')?.value || '';
          await updateDoc(userRef, {
            premiumStatus: 'pending',
            paymentTxid: txid,
            paymentPlan: selectedPlan,
            paymentRequestedAt: new Date().toISOString(),
            paymentSlipUrl: null
          });

          // Update UI
          if (state.profile) state.profile.premiumStatus = 'pending';
          updatePlanBadge('pending');
          msgEl.className = 'status-message text-green';
          msgEl.textContent = '✅ Request submitted! Admin will verify your payment and activate your account shortly.';
          paymentForm.reset();
          premiumCheckbox.checked = false;
          if (paymentPanel) paymentPanel.classList.add('hidden');
          loadAccountPage();
        } catch (err) {
          msgEl.className = 'status-message text-red';
          msgEl.textContent = 'Error: ' + (err.message || 'Could not submit request. Please try again.');
          console.error('Payment submission error:', err);
        } finally {
          if (submitBtn) { submitBtn.disabled = false; submitBtn.textContent = 'Submit Verification Request'; }
        }
      }
    });
  }

  // Plan Selection Globals
  window.selectPlan = function(cardEl) {
    const planName = cardEl.getAttribute("data-plan");
    const priceLkr = cardEl.getAttribute("data-price");
    
    const planInput = document.getElementById("payment-plan");
    const planLabel = document.getElementById("selected-plan-label");
    const modal = document.getElementById("checkout-modal-overlay");

    if (planInput) planInput.value = planName;
    if (planLabel) planLabel.textContent = `${planName} Plan — Rs. ${priceLkr}/=`;

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
    const planPriceUsdEl = document.getElementById("wallet-plan-price-usd");
    if (planPriceUsdEl) planPriceUsdEl.textContent = `$${usdPrice.toFixed(2)}`;

    const userBalance = state.profile?.walletBalance || 0;
    const userBalanceUsdEl = document.getElementById("wallet-user-balance-usd");
    if (userBalanceUsdEl) userBalanceUsdEl.textContent = `$${userBalance.toFixed(2)}`;

    // Set pay button text
    const submitBtn = document.getElementById("btn-submit-upgrade");
    if (submitBtn) submitBtn.textContent = `Pay $${usdPrice.toFixed(2)} with Wallet`;

    if (modal) modal.classList.remove("hidden");

    window.setPayMethod("bank");
  };

  window.closeCheckoutModal = function() {
    const modal = document.getElementById("checkout-modal-overlay");
    if (modal) modal.classList.add("hidden");
    const msgEl = document.getElementById("payment-msg");
    if (msgEl) msgEl.textContent = "";
  };

  window.setPayMethod = function(method) {
    const paymentMethodField = document.getElementById("payment-method-field");
    if (paymentMethodField) paymentMethodField.value = method;
    
    const btnBank = document.getElementById("pay-method-bank");
    const btnWallet = document.getElementById("pay-method-wallet");
    
    const bankView = document.getElementById("checkout-bank-view");
    const walletView = document.getElementById("checkout-wallet-view");
    const submitBtn = document.getElementById("btn-submit-upgrade");

    if (method === "bank") {
      if (btnBank) btnBank.classList.add("active");
      if (btnWallet) btnWallet.classList.remove("active");

      if (bankView) bankView.classList.remove("hidden");
      if (walletView) walletView.classList.add("hidden");

      const txidInput = document.getElementById("payment-txid");
      if (txidInput) txidInput.setAttribute("required", "");
      if (submitBtn) submitBtn.textContent = "Submit Verification Request";
    } else {
      if (btnWallet) btnWallet.classList.add("active");
      if (btnBank) btnBank.classList.remove("active");

      if (bankView) bankView.classList.add("hidden");
      if (walletView) walletView.classList.remove("hidden");

      const txidInput = document.getElementById("payment-txid");
      if (txidInput) txidInput.removeAttribute("required");

      const planInput = document.getElementById("payment-plan");
      const plan = planInput ? planInput.value : "";
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
      if (submitBtn) submitBtn.textContent = `Pay $${getPriceUSD(plan).toFixed(2)} with Wallet`;
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
        const conversionEl = document.getElementById("deposit-amount-lkr");
        if (conversionEl) conversionEl.textContent = "Rs. 0/=";

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

// ------------------------------------------------------------------
// Page‑specific loader functions (extracted from original app.js)
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

export function loadSignalsPage() {
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
              <a href="account.html" class="btn btn-primary btn-sm">Unlock with Premium</a>
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
        window.location.href = "auth.html";
        return;
      }

      const balance = state.profile?.walletBalance || 0;
      if (balance < price) {
        alert(`Insufficient balance. This signal costs $${price.toFixed(2)}, but you only have $${balance.toFixed(2)}. Please top up your wallet.`);
        window.location.href = "account.html";
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

export function loadBotPage() {
  const lockSection = document.getElementById('bot-lock-section');
  const contentSection = document.getElementById('bot-content-section');
  if (!lockSection || !contentSection) return;
  const status = state.profile?.premiumStatus;
  const role = state.profile?.role;
  if (status !== 'paid' && role !== 'admin') {
    lockSection.classList.remove('hidden');
    contentSection.classList.add('hidden');
    return;
  }
  lockSection.classList.add('hidden');
  contentSection.classList.remove('hidden');
  // Populate API keys preview
  const apiKeys = state.profile?.binanceApi;
  if (apiKeys) {
    const keyField = document.getElementById('binance-api-key');
    const secretField = document.getElementById('binance-api-secret');
    if (keyField) keyField.value = apiKeys.apiKey.substring(0, 8) + '••••••••••••••••••••••••';
    if (secretField) secretField.value = '••••••••••••••••••••••••••••••••';
  }
  const toggle = document.getElementById('bot-toggle-btn');
  if (toggle) {
    const saved = localStorage.getItem(`bot_enabled_${state.user.uid}`) === 'true';
    toggle.checked = saved;
    updateBotStatusText(saved);
  }
  const tradesList = document.getElementById('bot-trades-list');
  if (tradesList) tradesList.innerHTML = `<tr><td colspan="7" class="text-center py-4 text-gray">Loading execution logs...</td></tr>`;
  activeUnsubscribes.trades = subscribeToTrades(state.user.uid, trades => {
    if (!tradesList) return;
    tradesList.innerHTML = '';
    if (trades.length === 0) {
      tradesList.innerHTML = `<tr><td colspan="7" class="text-center py-4 text-gray">No trades executed yet.</td></tr>`;
      updateBotStats(0, 0, 0);
      return;
    }
    let wins = 0, losses = 0, totalPnl = 0;
    trades.forEach(trade => {
      if (trade.status === 'WIN') { wins++; totalPnl += trade.pnl; }
      else if (trade.status === 'LOSS') { losses++; totalPnl += trade.pnl; }
      const statusClass = trade.status === 'WIN' ? 'text-green' : trade.status === 'LOSS' ? 'text-red' : 'text-yellow';
      const pnlSign = trade.pnl > 0 ? '+' : '';
      
      const amt = trade.amount !== undefined ? trade.amount : 0.50;
      const dollarPnl = trade.pnlAmount !== undefined ? trade.pnlAmount : (amt * (trade.pnl / 100));
      const pnlText = trade.status !== 'OPEN' ? `${pnlSign}$${Math.abs(dollarPnl).toFixed(2)} (${pnlSign}${trade.pnl.toFixed(2)}%)` : 'Trading...';
      const lev = trade.leverage || '15x';
      const marginRisk = `$${amt.toFixed(2)}`;

      const row = document.createElement('tr');
      row.innerHTML = `
        <td class="py-3 px-4 font-medium">${trade.pair}</td>
        <td class="py-3 px-4"><span class="badge-${trade.direction.toLowerCase()}">${trade.direction}</span></td>
        <td class="py-3 px-4 font-bold text-yellow">${lev}</td>
        <td class="py-3 px-4 text-gray font-mono">${marginRisk}</td>
        <td class="py-3 px-4 font-mono">$${trade.entry}</td>
        <td class="py-3 px-4 ${statusClass}">${trade.status}</td>
        <td class="py-3 px-4 ${statusClass} font-medium font-mono">${pnlText}</td>
      `;
      tradesList.appendChild(row);
    });
    updateBotStats(wins, losses, totalPnl);
  });
}

export function loadAccountPage() {
  const normalPanel = document.getElementById('account-normal-panel');
  const pendingPanel = document.getElementById('account-pending-panel');
  const vipPanel = document.getElementById('account-vip-panel');
  if (!normalPanel || !pendingPanel || !vipPanel) return;
  const status = state.profile?.premiumStatus;
  const role = state.profile?.role;
  if (role === 'admin' || status === 'paid') {
    vipPanel.classList.remove('hidden');
    normalPanel.classList.add('hidden');
    pendingPanel.classList.add('hidden');
  } else if (status === 'pending') {
    pendingPanel.classList.remove('hidden');
    vipPanel.classList.add('hidden');
    normalPanel.classList.add('hidden');
  } else {
    normalPanel.classList.remove('hidden');
    pendingPanel.classList.add('hidden');
    vipPanel.classList.add('hidden');
  }

  // Populate referral UI elements
  const refLinkInput = document.getElementById("referral-link-input");
  if (refLinkInput && state.user) {
    refLinkInput.value = `${window.location.origin}${window.location.pathname.replace(/\/[^\/]*$/, '')}/index.html?ref=${state.user.uid}`;
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
              <td class="py-3 px-4"><span class="${badgeClass}">${statusLabel}</span></td>
              <td class="py-3 px-4 ${isProcessed ? 'text-green font-medium' : 'text-gray'}">${isProcessed ? `✅ $${((state.profile?.totalReferralEarnings || 0) > 0 ? '15% comm.' : '$0.20 credited')}` : '—'}</td>
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

export function loadAdminPage() {
  const pendingList = document.getElementById('admin-pending-payments');
  const userList = document.getElementById('admin-users-list');
  const signalsTable = document.getElementById('admin-signals-table');
  if (!pendingList || !userList || !signalsTable) return;

  let currentUsersList = [];

  // Users & pending payments
  activeUnsubscribes.users = subscribeToAllUsers(users => {
    currentUsersList = users;
    // Clear containers
    pendingList.innerHTML = '';
    userList.innerHTML = '';
    const pending = users.filter(u => u.premiumStatus === 'pending');
    if (pending.length === 0) {
      pendingList.innerHTML = `<div class="empty-state">No pending premium upgrade requests.</div>`;
    } else {
      pending.forEach(u => {
        const card = document.createElement('div');
        card.className = 'payment-request-card';
        const requestedPlan = u.paymentPlan || "1 Month";
        card.innerHTML = `
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
              <button class="btn btn-primary btn-sm btn-approve" data-id="${u.uid}">Accept</button>
              <button class="btn btn-secondary btn-sm btn-reject" data-id="${u.uid}">Reject</button>
            </div>
          </div>
        `;
        pendingList.appendChild(card);
      });
      // Approve / Reject handlers
      document.querySelectorAll('.btn-approve').forEach(btn => {
        btn.addEventListener('click', async e => {
          const uid = e.target.getAttribute('data-id');
          const card = e.target.closest(".payment-request-card");
          const planSelect = card ? card.querySelector(".plan-select") : null;
          const chosenPlan = planSelect ? planSelect.value : "1 Month";
          e.target.disabled = true;
          e.target.textContent = 'Approving...';
          await approvePremium(uid, chosenPlan);
          e.target.textContent = 'Accepted';
        });
      });
      document.querySelectorAll('.btn-reject').forEach(btn => {
        btn.addEventListener('click', async e => {
          const uid = e.target.getAttribute('data-id');
          e.target.disabled = true;
          e.target.textContent = 'Rejecting...';
          await rejectPremium(uid);
          e.target.textContent = 'Rejected';
        });
      });
    }

    // 1b. Pending Top-Up Approvals
    const pendingTopupsList = document.getElementById('admin-pending-topups');
    if (pendingTopupsList) {
      pendingTopupsList.innerHTML = '';
      const pendingTopupUsers = users.filter(u => u.topupStatus === 'pending');
      
      if (pendingTopupUsers.length === 0) {
        pendingTopupsList.innerHTML = `<div class="empty-state">No pending top-up verification requests.</div>`;
      } else {
        pendingTopupUsers.forEach(u => {
          const card = document.createElement('div');
          card.className = 'payment-request-card';
          card.innerHTML = `
            <div>
              <h4 class="text-white font-medium">${u.displayName || u.email}</h4>
              <p class="text-sm text-gray mt-1">TxID/Ref: <span class="text-yellow font-mono">${u.topupTxid}</span></p>
              <p class="text-sm text-gray mt-1">Deposit Amount: <span class="text-green font-bold">$${(u.topupAmount || 0).toFixed(2)}</span></p>
              <p class="text-xs text-gray mt-1">Requested: ${new Date(u.topupRequestedAt).toLocaleString()}</p>
              ${u.topupSlipUrl ? `<img src="${u.topupSlipUrl}" class="payment-slip-thumb cursor-pointer" style="max-width:100px; margin-top:8px; border:1px solid var(--border-color);" onclick="openSlipModal('${u.topupSlipUrl}')"/>` : ''}
            </div>
            <div class="action-buttons flex gap-2">
              <button class="btn btn-primary btn-sm btn-approve-topup" data-id="${u.uid}">Accept</button>
              <button class="btn btn-secondary btn-sm btn-reject-topup" data-id="${u.uid}">Reject</button>
            </div>
          `;
          pendingTopupsList.appendChild(card);
        });

        document.querySelectorAll('.btn-approve-topup').forEach(btn => {
          btn.addEventListener('click', async e => {
            const uid = e.target.getAttribute('data-id');
            e.target.disabled = true;
            e.target.textContent = 'Crediting...';
            await approveTopup(uid);
          });
        });

        document.querySelectorAll('.btn-reject-topup').forEach(btn => {
          btn.addEventListener('click', async e => {
            const uid = e.target.getAttribute('data-id');
            e.target.disabled = true;
            e.target.textContent = 'Rejecting...';
            await rejectTopup(uid);
          });
        });
      }
    }

    // Users list
    if (users.length === 0) {
      userList.innerHTML = `<tr><td colspan="5" class="text-center py-3 text-gray">No users registered.</td></tr>`;
    } else {
      users.forEach(u => {
        const winLoss = u.winLoss || { wins: 0, losses: 0 };
        const total = winLoss.wins + winLoss.losses;
        const winRate = total > 0 ? ((winLoss.wins / total) * 100).toFixed(1) + '%' : '0%';

        // Compute expiry display
        let expiryDisplay = '—';
        if (u.premiumStatus === 'paid') {
          if (!u.premiumExpiresAt) {
            expiryDisplay = `<span class="text-green font-bold">♾️ Lifetime</span>`;
          } else {
            const exp = new Date(u.premiumExpiresAt);
            const daysLeft = Math.max(0, Math.ceil((exp - new Date()) / (1000 * 60 * 60 * 24)));
            const color = daysLeft <= 3 ? 'text-red' : daysLeft <= 7 ? 'text-yellow' : 'text-green';
            expiryDisplay = `<span class="${color} font-bold">${exp.toLocaleDateString('en-GB')} (${daysLeft}d left)</span>`;
          }
        } else if (u.premiumStatus === 'expired') {
          expiryDisplay = `<span class="text-red">Expired</span>`;
        }

        const row = document.createElement('tr');
        row.innerHTML = `
          <td class="py-3 px-4 text-white font-medium">${u.displayName || 'No Name'}</td>
          <td class="py-3 px-4">${u.email}</td>
          <td class="py-3 px-4"><span class="badge-${u.premiumStatus === 'paid' ? 'buy' : u.premiumStatus === 'pending' ? 'pending' : 'sell'}">${(u.premiumStatus || 'free').toUpperCase()}</span></td>
          <td class="py-3 px-4">${u.activePlan ? `<span class="text-yellow font-bold">${u.activePlan}</span>` : '—'} ${expiryDisplay}</td>
          <td class="py-3 px-4 font-mono text-green">${winLoss.wins}W <span class="text-red">${winLoss.losses}L</span> (${winRate})</td>
        `;
        userList.appendChild(row);
      });

      // Populate targeted message user dropdown
      const selectEl = document.getElementById("msg-target-user");
      if (selectEl) {
        const currentVal = selectEl.value;
        selectEl.innerHTML = '<option value="all">📢 Broadcast to All Users</option>';
        users.forEach(u => {
          if (u.role !== 'admin') {
            const option = document.createElement("option");
            option.value = u.uid;
            option.dataset.email = u.email || "";
            option.dataset.name = u.displayName || u.email || "";
            option.textContent = `${u.displayName || 'No Name'} (${u.email})`;
            selectEl.appendChild(option);
          }
        });
        selectEl.value = currentVal;
      }
    }
  });

  // Signals table for admin actions
  activeUnsubscribes.signals = subscribeToSignals('admin', signals => {
    signalsTable.innerHTML = '';
    if (signals.length === 0) {
      signalsTable.innerHTML = `<tr><td colspan="5" class="text-center py-3 text-gray">No signals created.</td></tr>`;
      return;
    }
    signals.forEach(sig => {
      const row = document.createElement('tr');
      let actions = '';
      if (sig.status === 'Pending') {
        actions += `<button class="btn btn-primary btn-xs btn-win" data-id="${sig.id}">Win</button>`;
        actions += `<button class="btn btn-secondary btn-xs btn-loss" data-id="${sig.id}">Loss</button>`;
      }
      actions += `<button class="btn btn-danger btn-xs btn-delete ml-1" data-id="${sig.id}">Delete</button>`;
      row.innerHTML = `
        <td class="py-3 px-4 text-white font-medium">${sig.pair}</td>
        <td class="py-3 px-4"><span class="badge-${sig.direction.toLowerCase()}">${sig.direction}</span></td>
        <td class="py-3 px-4 font-mono">${sig.entry}</td>
        <td class="py-3 px-4"><span class="status-badge ${sig.status === 'Win' ? 'status-win' : sig.status === 'Loss' ? 'status-loss' : 'status-pending'}">${sig.status}</span></td>
        <td class="py-3 px-4">${actions}</td>
      `;
      signalsTable.appendChild(row);
    });
  });

  // Setup Admin Message & Gift Form
  const messageForm = document.getElementById("admin-message-form");
  if (messageForm && !messageForm.dataset.listenerWired) {
    messageForm.dataset.listenerWired = "true";
    messageForm.addEventListener("submit", async e => {
      e.preventDefault();
      const targetVal = document.getElementById("msg-target-user").value;
      const subject = document.getElementById("msg-subject").value.trim();
      const body = document.getElementById("msg-body").value.trim();
      const giftVal = parseFloat(document.getElementById("msg-gift").value) || 0;
      const statusEl = document.getElementById("admin-msg-status");
      const submitBtn = document.getElementById("btn-send-admin-msg");

      if (submitBtn) { submitBtn.disabled = true; submitBtn.textContent = "Sending..."; }
      if (statusEl) { statusEl.className = "status-message text-yellow"; statusEl.textContent = "Sending message(s)..."; }

      try {
        let targetEmail = "";
        let targetName = "";
        if (targetVal !== "all") {
          const selectEl = document.getElementById("msg-target-user");
          const selectedOpt = selectEl.options[selectEl.selectedIndex];
          targetEmail = selectedOpt.dataset.email;
          targetName = selectedOpt.dataset.name;
        }

        // Fetch users dynamically from current local cache in subscribeToAllUsers
        const { sendAdminMessage } = await import("./messages.js");
        
        const res = await sendAdminMessage({
          targetUserId: targetVal,
          targetEmail,
          targetName,
          subject,
          body,
          giftAmount: giftVal,
          allUsers: currentUsersList
        });

        if (statusEl) {
          statusEl.className = "status-message text-green";
          statusEl.textContent = `✅ Successfully sent to ${res.sent} user(s). Failed: ${res.failed}`;
        }
        messageForm.reset();
        _loadAdminSentMessagesLog();
      } catch (err) {
        console.error("Error sending message:", err);
        if (statusEl) { statusEl.className = "status-message text-red"; statusEl.textContent = "Error: " + err.message; }
      } finally {
        if (submitBtn) { submitBtn.disabled = false; submitBtn.innerHTML = `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="margin-right:6px;"><line x1="22" y1="2" x2="11" y2="13"/><polygon points="22 2 15 22 11 13 2 9 22 2"/></svg> Send Message`; }
      }
    });
  }

  // Load recent sent messages log
  _loadAdminSentMessagesLog();
}

async function _loadAdminSentMessagesLog() {
  const logEl = document.getElementById("admin-sent-messages-log");
  if (!logEl) return;
  logEl.innerHTML = '<div class="text-center text-gray py-4">Loading sent messages...</div>';
  try {
    const { getAdminSentMessages } = await import("./messages.js");
    const msgs = await getAdminSentMessages(30);
    logEl.innerHTML = "";
    if (msgs.length === 0) {
      logEl.innerHTML = '<div class="text-center text-gray py-4">No messages sent yet.</div>';
      return;
    }
    msgs.forEach(m => {
      const card = document.createElement("div");
      card.style.background = "rgba(255,255,255,0.02)";
      card.style.border = "1px solid rgba(255,255,255,0.05)";
      card.style.borderRadius = "10px";
      card.style.padding = "12px 14px";
      
      const date = new Date(m.createdAt).toLocaleString();
      const giftBadge = m.giftAmount > 0 ? `<span class="plan-badge" style="background:rgba(0,255,136,0.1);color:#00e676;border-color:rgba(0,255,136,0.25);margin-left:8px;font-size:0.75rem;">🎁 $${m.giftAmount.toFixed(2)}</span>` : '';
      const targetLabel = m.broadcast ? '📢 Broadcast' : `👤 ${m.displayName || m.userEmail}`;

      card.innerHTML = `
        <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:6px;">
          <span style="font-size:0.8rem;font-weight:700;color:var(--text-secondary);">${targetLabel}${giftBadge}</span>
          <span style="font-size:0.75rem;color:var(--text-muted);">${date}</span>
        </div>
        <strong style="color:#fff;font-size:0.9rem;display:block;margin-bottom:4px;">${m.subject}</strong>
        <p style="margin:0;font-size:0.82rem;color:var(--text-muted);white-space:pre-wrap;line-height:1.4;">${m.body}</p>
      `;
      logEl.appendChild(card);
    });
  } catch (err) {
    console.error("Error loading sent messages log:", err);
    logEl.innerHTML = '<div class="text-center text-red py-4">Error loading messages log.</div>';
  }
}

// ------------------------------------------------------------------
// Bot execution helpers
export function startBotExecution() {
  if (!state.user) return;
  state.botRunning = true;
  localStorage.setItem(`bot_enabled_${state.user.uid}`, 'true');
  const status = state.profile?.role === 'admin' ? 'admin' : state.profile?.premiumStatus;
  startAutoTrading(state.user.uid, status, logMsg => addBotLog(logMsg));
  updateBotStatusText(true);
}
export function stopBotExecution() {
  if (!state.user) return;
  state.botRunning = false;
  localStorage.setItem(`bot_enabled_${state.user.uid}`, 'false');
  stopAutoTrading();
  updateBotStatusText(false);
}
function updateBotStats(wins, losses, totalPnl) {
  const winEl = document.getElementById('bot-wins');
  const lossEl = document.getElementById('bot-losses');
  const pnlEl = document.getElementById('bot-total-pnl');
  if (winEl) winEl.textContent = wins;
  if (lossEl) lossEl.textContent = losses;
  
  // Update win rate
  const total = wins + losses;
  const winRate = total > 0 ? ((wins / total) * 100).toFixed(1) : "0.0";
  const winRateEl = document.getElementById("bot-winrate");
  if (winRateEl) {
    winRateEl.textContent = winRate + "%";
    winRateEl.style.color = parseFloat(winRate) >= 70 ? "var(--color-buy)" : parseFloat(winRate) >= 50 ? "var(--color-gold)" : "var(--color-sell)";
  }

  if (pnlEl) {
    pnlEl.textContent = (totalPnl >= 0 ? '+' : '') + totalPnl.toFixed(2) + '%';
    pnlEl.style.color = totalPnl > 0 ? 'var(--color-buy)' : totalPnl < 0 ? 'var(--color-sell)' : 'var(--text-secondary)';
  }
}
function updateBotStatusText(running) {
  const indicator = document.getElementById('bot-status-indicator');
  const text = document.getElementById('bot-status-text');
  if (running) {
    if (indicator) indicator.className = 'status-dot dot-active';
    if (text) { text.textContent = 'AUTO TRADING BOT ACTIVE'; text.className = 'text-green font-bold text-sm tracking-wide'; }
    addBotLog('Bot started. Listening for VIP signals...');
  } else {
    if (indicator) indicator.className = 'status-dot dot-inactive';
    if (text) { text.textContent = 'BOT INACTIVE'; text.className = 'text-red font-bold text-sm tracking-wide'; }
    addBotLog('Bot stopped.');
  }
}
function addBotLog(msg) {
  const logEl = document.getElementById('bot-log');
  if (!logEl) return;
  const time = new Date().toLocaleTimeString();
  
  // Color-code log entries
  let cssClass = 'log-info';
  const lowerText = msg.toLowerCase();
  if (lowerText.includes('win') || lowerText.includes('take-profit') || (lowerText.includes('closed') && lowerText.includes('win'))) cssClass = 'log-success';
  else if (lowerText.includes('loss') || lowerText.includes('stop-loss') || lowerText.includes('error')) cssClass = 'log-error';
  else if (lowerText.includes('executing') || lowerText.includes('executed') || lowerText.includes('opened') || lowerText.includes('auto-trading')) cssClass = 'log-warn';
  else if (lowerText.includes('system') || lowerText.includes('initialized') || lowerText.includes('started') || lowerText.includes('analysis')) cssClass = 'log-system';
  
  logEl.innerHTML += `<div class="${cssClass}">[${time}] ${msg}</div>`;
  logEl.scrollTop = logEl.scrollHeight;
  
  // Keep log to last 100 entries
  const entries = logEl.querySelectorAll('div');
  if (entries.length > 100) entries[0].remove();
}

// ------------------------------------------------------------------
// Initialise the app – called from each page's <script type="module">
export function initApp() {
  // Check URL for referral code
  const urlParams = new URLSearchParams(window.location.search);
  const refCode = urlParams.get("ref");
  if (refCode) {
    localStorage.setItem("referred_by", refCode.trim());
    // Clean up URL parameter to make it look clean
    window.history.replaceState({}, document.title, window.location.pathname + window.location.hash);
  }

  initAuthListeners();
  initFormListeners();
  initMobileMenu();
}

// Mobile Navigation Menu Toggle
export function initMobileMenu() {
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

// End of common.js

// ------------------------------------------------------------------
// Referrals Page Loader
export function loadReferralsPage() {
  const guard   = document.getElementById("auth-guard-notice");
  const content = document.getElementById("referrals-content");
  if (!guard || !content) return;

  // Poll until auth state resolves
  const tryLoad = () => {
    if (state.user && state.profile) {
      guard.classList.add("hidden");
      content.classList.remove("hidden");
      _setupReferralsUI();
    } else if (state.user === null && state.profile === null) {
      // Unauthenticated
      guard.classList.remove("hidden");
      content.classList.add("hidden");
    } else {
      // Still resolving
      setTimeout(tryLoad, 200);
    }
  };
  tryLoad();
}

function _setupReferralsUI() {
  // Referral link input
  const refLinkInput = document.getElementById("referral-link-input");
  if (refLinkInput && state.user) {
    const origin = window.location.origin;
    const path   = window.location.pathname.replace(/\/[^/]*$/, "");
    refLinkInput.value = `${origin}${path}/index.html?ref=${state.user.uid}`;
  }

  // Copy button
  const copyBtn = document.getElementById("btn-copy-ref");
  const copyMsg = document.getElementById("copy-ref-msg");
  if (copyBtn && !copyBtn.dataset.listenerWired) {
    copyBtn.dataset.listenerWired = "true";
    copyBtn.addEventListener("click", () => {
      if (!refLinkInput) return;
      refLinkInput.select();
      navigator.clipboard.writeText(refLinkInput.value)
        .then(() => {
          copyBtn.textContent = "✓ Copied!";
          if (copyMsg) { copyMsg.textContent = "Referral link copied to clipboard!"; copyMsg.style.color = "var(--color-buy)"; }
          setTimeout(() => {
            copyBtn.innerHTML = `<svg width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24" style="flex-shrink:0;"><path stroke-linecap="round" stroke-linejoin="round" d="M8 5H6a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2v-1M8 5a2 2 0 002 2h2a2 2 0 002-2M8 5a2 2 0 012-2h2a2 2 0 012 2m0 0h2a2 2 0 012 2v3m2 4H10m0 0l3-3m-3 3l3 3"/></svg> Copy Link`;
            if (copyMsg) copyMsg.textContent = "";
          }, 2200);
        })
        .catch(() => { if (copyMsg) copyMsg.textContent = "Copy failed. Please copy manually."; });
    });
  }

  // Social sharing buttons
  const shareUrl = encodeURIComponent(refLinkInput?.value || "");
  const shareMsg = encodeURIComponent("Join PRIME METRIX Trading – Get free crypto signals & AI auto-trading. Use my referral link:");
  const waBtn  = document.getElementById("share-whatsapp");
  const tgBtn  = document.getElementById("share-telegram");
  const twBtn  = document.getElementById("share-twitter");
  if (waBtn) waBtn.onclick = () => window.open(`https://wa.me/?text=${shareMsg}%20${shareUrl}`, "_blank");
  if (tgBtn) tgBtn.onclick = () => window.open(`https://t.me/share/url?url=${shareUrl}&text=${shareMsg}`, "_blank");
  if (twBtn) twBtn.onclick = () => window.open(`https://twitter.com/intent/tweet?text=${shareMsg}%20${shareUrl}`, "_blank");

  // Referral stats
  const totalEl      = document.getElementById("ref-count-total");
  const successfulEl = document.getElementById("ref-count-successful");
  const earnedEl     = document.getElementById("ref-total-earned");
  const historyList  = document.getElementById("referral-history-list");

  const earned = state.profile?.totalReferralEarnings || 0;
  if (earnedEl) earnedEl.textContent = `$${earned.toFixed(2)}`;

  // Update hero earned card
  const heroEarned = document.querySelector(".ref-earn-card .ref-stat-value");
  if (heroEarned) heroEarned.textContent = `$${earned.toFixed(2)}`;

  // Load referral history from Firestore
  if (historyList && state.user) {
    historyList.innerHTML = `<tr><td colspan="4" class="text-center py-4 text-gray">Loading referrals...</td></tr>`;
    const referralsQuery = query(collection(db, "users"), where("referredBy", "==", state.user.uid));
    getDocs(referralsQuery)
      .then(snapshot => {
        historyList.innerHTML = "";
        let invited = snapshot.size;
        let successful = 0;
        if (invited === 0) {
          historyList.innerHTML = `<tr><td colspan="4" class="text-center py-4 text-gray">No referrals yet. Share your link to start earning!</td></tr>`;
        } else {
          snapshot.forEach(docSnap => {
            const u = docSnap.data();
            if (u.referralBonusProcessed) successful++;
            const name = _maskName(u.displayName || u.email);
            const joined = u.createdAt ? new Date(u.createdAt).toLocaleDateString("en-GB") : "—";
            let badgeClass = "badge-free", statusLabel = "Registered (Free)";
            if (u.premiumStatus === "paid")     { badgeClass = "badge-vip";     statusLabel = "VIP Premium"; }
            else if (u.premiumStatus === "pending") { badgeClass = "badge-pending"; statusLabel = "Pending VIP"; }
            else if (u.premiumStatus === "expired") { badgeClass = "badge-expired"; statusLabel = "VIP Expired"; }
            const bonus = u.referralBonusProcessed ? `<span class="text-green font-medium">✅ Credited</span>` : `<span class="text-gray">—</span>`;
            const tr = document.createElement("tr");
            tr.innerHTML = `
              <td class="py-3 px-4 text-white font-medium">${name}</td>
              <td class="py-3 px-4 text-gray">${joined}</td>
              <td class="py-3 px-4"><span class="${badgeClass}">${statusLabel}</span></td>
              <td class="py-3 px-4">${bonus}</td>
            `;
            historyList.appendChild(tr);
          });
        }
        if (totalEl)      totalEl.textContent      = invited;
        if (successfulEl) successfulEl.textContent  = successful;
      })
      .catch(() => {
        historyList.innerHTML = `<tr><td colspan="4" class="text-center py-4 text-red">Error loading referrals.</td></tr>`;
      });
  }

  // Load Referral Leaderboard
  _loadLeaderboard("referral");
}

function _maskName(str) {
  if (!str) return "User";
  if (str.includes("@")) {
    const [local, domain] = str.split("@");
    return `${local.length <= 3 ? local[0] : local.slice(0, 3)}***@${domain}`;
  }
  return str.length <= 3 ? str : `${str.slice(0, 2)}***${str.slice(-1)}`;
}

// ------------------------------------------------------------------
// Top-Up / Wallet Page Loader
export function loadTopupPage() {
  const guard   = document.getElementById("auth-guard-notice");
  const content = document.getElementById("topup-content");
  if (!guard || !content) return;

  const tryLoad = () => {
    if (state.user && state.profile) {
      guard.classList.add("hidden");
      content.classList.remove("hidden");
      _setupTopupUI();
    } else if (state.user === null && state.profile === null) {
      guard.classList.remove("hidden");
      content.classList.add("hidden");
    } else {
      setTimeout(tryLoad, 200);
    }
  };
  tryLoad();
}

function _setupTopupUI() {
  // Wallet balance displays
  const balance = state.profile?.walletBalance || 0;
  const heroBal  = document.getElementById("wallet-balance-display");
  const sideBal  = document.getElementById("wallet-balance-display-2");
  const refEarned = document.getElementById("wallet-ref-earned");
  if (heroBal) heroBal.textContent = `$${balance.toFixed(2)}`;
  if (sideBal) sideBal.textContent = `$${balance.toFixed(2)}`;
  if (refEarned) refEarned.textContent = `$${(state.profile?.totalReferralEarnings || 0).toFixed(2)}`;

  // Pending top-up notice
  const pendingNotice  = document.getElementById("active-topup-notice");
  const pendingAmtText = document.getElementById("pending-topup-amount-text");
  if (pendingNotice && pendingAmtText) {
    if (state.profile?.topupStatus === "pending") {
      pendingNotice.classList.remove("hidden");
      pendingAmtText.textContent = `$${(state.profile.topupAmount || 0).toFixed(2)}`;
    } else {
      pendingNotice.classList.add("hidden");
    }
  }

  // Compute total deposited from profile (simple approximation)
  const totalDep = document.getElementById("wallet-total-deposited");
  if (totalDep) totalDep.textContent = `$${(state.profile?.lifetimeDeposited || balance).toFixed(2)}`;

  // USD → LKR conversion preview
  const usdInput = document.getElementById("deposit-amount-usd");
  const lkrOut   = document.getElementById("deposit-amount-lkr");
  const usdPreview = document.getElementById("deposit-usd-preview");
  if (usdInput) {
    usdInput.addEventListener("input", () => {
      const val = parseFloat(usdInput.value) || 0;
      if (lkrOut)    lkrOut.textContent    = `Rs. ${Math.round(val * 300).toLocaleString()}/=`;
      if (usdPreview) usdPreview.textContent = `$${val.toFixed(2)}`;
    });
  }

  // Wallet deposit form submit
  const depositForm = document.getElementById("wallet-deposit-form");
  if (depositForm && !depositForm.dataset.listenerWired) {
    depositForm.dataset.listenerWired = "true";
    depositForm.addEventListener("submit", async e => {
      e.preventDefault();
      if (!state.user) return;

      const usdAmount = parseFloat(document.getElementById("deposit-amount-usd")?.value);
      const txid      = document.getElementById("deposit-txid")?.value.trim();
      const msgEl     = document.getElementById("deposit-msg");
      const submitBtn = document.getElementById("btn-submit-deposit");

      if (isNaN(usdAmount) || usdAmount <= 0) {
        if (msgEl) { msgEl.className = "status-message text-red"; msgEl.textContent = "Please enter a valid USD amount."; }
        return;
      }
      if (!txid) {
        if (msgEl) { msgEl.className = "status-message text-red"; msgEl.textContent = "Please enter the transaction reference ID."; }
        return;
      }

      if (submitBtn) { submitBtn.disabled = true; submitBtn.textContent = "Submitting..."; }
      if (msgEl) { msgEl.className = "status-message text-yellow"; msgEl.textContent = "Saving deposit request..."; }

      // Save to Firestore user doc (for admin panel) - no slip upload required
      try {
        const userRef = doc(db, "users", state.user.uid);
        await updateDoc(userRef, {
          topupStatus: "pending",
          topupAmount: usdAmount,
          topupTxid: txid,
          topupSlipUrl: null,
          topupRequestedAt: new Date().toISOString()
        });

        // Also write a record to the deposits history collection
        const { addDoc } = await import("https://www.gstatic.com/firebasejs/12.15.0/firebase-firestore.js");
        await addDoc(collection(db, "deposits"), {
          userId:      state.user.uid,
          userEmail:   state.user.email,
          displayName: state.profile?.displayName || "",
          amount:      usdAmount,
          txid:        txid,
          slipUrl:     null,
          status:      "pending",
          requestedAt: new Date().toISOString()
        });

        if (state.profile) { state.profile.topupStatus = "pending"; state.profile.topupAmount = usdAmount; }

        if (msgEl) { msgEl.className = "status-message text-green"; msgEl.textContent = "✅ Top-Up request submitted! Wallet will be credited after admin review."; }
        depositForm.reset();
        if (lkrOut)    lkrOut.textContent    = "Rs. 0/=";
        if (usdPreview) usdPreview.textContent = "$0.00";

        // Refresh pending notice
        const pendingNotice2  = document.getElementById("active-topup-notice");
        const pendingAmtText2 = document.getElementById("pending-topup-amount-text");
        if (pendingNotice2)  pendingNotice2.classList.remove("hidden");
        if (pendingAmtText2) pendingAmtText2.textContent = `$${usdAmount.toFixed(2)}`;

        // Reload deposit history
        _loadDepositHistory();
      } catch (err) {
        console.error("Deposit submission error:", err);
        if (msgEl) { msgEl.className = "status-message text-red"; msgEl.textContent = "Error: " + err.message; }
      } finally {
        if (submitBtn) {
          submitBtn.disabled = false;
          submitBtn.innerHTML = `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="22" y1="2" x2="11" y2="13"/><polygon points="22 2 15 22 11 13 2 9 22 2"/></svg> Submit Top-Up Request`;
        }
      }
    });
  }

  // Load deposit history table
  _loadDepositHistory();

  // Load Top-Up Leaderboard
  _loadLeaderboard("topup");
}

function _updateDropZonePreview(file, labelEl, nameEl) {
  if (labelEl) labelEl.innerHTML = `<strong style="color:var(--color-primary);">✓ File selected</strong>`;
  if (nameEl)  nameEl.textContent = `${file.name} (${(file.size / 1024).toFixed(1)} KB)`;
}

function _loadDepositHistory() {
  const historyTbody = document.getElementById("deposit-history-list");
  if (!historyTbody || !state.user) return;
  historyTbody.innerHTML = `<tr><td colspan="4" class="text-center py-4 text-gray">Loading...</td></tr>`;
  const depQuery = query(
    collection(db, "deposits"),
    where("userId", "==", state.user.uid)
  );
  getDocs(depQuery)
    .then(snap => {
      historyTbody.innerHTML = "";
      if (snap.empty) {
        historyTbody.innerHTML = `<tr><td colspan="4" class="text-center py-4 text-gray">No deposits yet.</td></tr>`;
        return;
      }
      const deposits = [];
      snap.forEach(d => deposits.push({ id: d.id, ...d.data() }));
      // Sort newest first
      deposits.sort((a, b) => new Date(b.requestedAt) - new Date(a.requestedAt));
      deposits.forEach(dep => {
        const date = new Date(dep.requestedAt).toLocaleDateString("en-GB");
        const statusClass = dep.status === "approved" ? "badge-vip" : dep.status === "rejected" ? "badge-expired" : "badge-pending";
        const statusLabel = dep.status === "approved" ? "Approved" : dep.status === "rejected" ? "Rejected" : "Pending";
        const tr = document.createElement("tr");
        tr.innerHTML = `
          <td class="py-3 px-4 text-gray">${date}</td>
          <td class="py-3 px-4 text-white font-mono font-medium">$${(dep.amount || 0).toFixed(2)}</td>
          <td class="py-3 px-4"><span class="${statusClass}">${statusLabel}</span></td>
          <td class="py-3 px-4 text-gray font-mono" style="font-size:0.8rem;">${(dep.txid || "—").substring(0, 14)}…</td>
        `;
        historyTbody.appendChild(tr);
      });
    })
    .catch(() => {
      historyTbody.innerHTML = `<tr><td colspan="4" class="text-center py-4 text-red">Error loading history.</td></tr>`;
    });
}

// ─────────────────────────────────────────────────────────────────────────────
// Shared Leaderboard Renderer
// ─────────────────────────────────────────────────────────────────────────────
const MOCK_REFERRAL_LB = [
  { name: "Ra*** S.", invites: 41 },
  { name: "Da*** B.", invites: 38 },
  { name: "Ka*** W.", invites: 29 },
  { name: "Su*** P.", invites: 22 },
  { name: "Th*** N.", invites: 17 },
  { name: "Nu*** H.", invites: 14 },
  { name: "Av*** K.", invites: 11 },
  { name: "Mi*** R.", invites: 9 },
  { name: "An*** L.", invites: 7 },
  { name: "Fa*** M.", invites: 5 },
];

const MOCK_TOPUP_LB = [
  { name: "Sa*** M.", amount: 340.00 },
  { name: "Ha*** R.", amount: 280.50 },
  { name: "Du*** S.", amount: 220.00 },
  { name: "Th*** B.", amount: 195.00 },
  { name: "Ka*** P.", amount: 160.00 },
  { name: "Na*** W.", amount: 125.00 },
  { name: "Ra*** D.", amount: 98.00 },
  { name: "Av*** C.", amount: 75.50 },
  { name: "Su*** N.", amount: 60.00 },
  { name: "Mi*** A.", amount: 45.00 },
];

function _getRankBadge(rank) {
  const cls = rank === 1 ? "rank-1" : rank === 2 ? "rank-2" : rank === 3 ? "rank-3" : "rank-other";
  const emoji = rank === 1 ? "🥇" : rank === 2 ? "🥈" : rank === 3 ? "🥉" : rank;
  return `<span class="leaderboard-rank ${cls}">${emoji}</span>`;
}

function _renderLeaderboard(tbodyId, rows) {
  const tbody = document.getElementById(tbodyId);
  if (!tbody) return;
  if (!rows || rows.length === 0) {
    tbody.innerHTML = `<tr><td colspan="3" class="text-center py-4" style="color:#94a3b8;">No entries yet.</td></tr>`;
    return;
  }
  tbody.innerHTML = rows.map((row, i) => {
    const rank = i + 1;
    const initial = row.name ? row.name[0].toUpperCase() : "?";
    const value = row.invites !== undefined
      ? `<span class="leaderboard-value">${row.invites} <span style="color:#94a3b8;font-size:0.75rem;">Invites</span></span>`
      : `<span class="leaderboard-value">$${row.amount.toFixed(2)}</span>`;
    return `
      <tr>
        <td>${_getRankBadge(rank)}</td>
        <td>
          <div class="leaderboard-user">
            <div class="leaderboard-avatar">${initial}</div>
            <span class="leaderboard-name">${row.name}</span>
          </div>
        </td>
        <td style="text-align: right;">${value}</td>
      </tr>
    `;
  }).join("");
}

function _loadLeaderboard(type) {
  // Try Firestore public leaderboard collection first; fall back to mock data
  const tbodyId   = type === "topup" ? "topup-leaderboard-list" : "referral-leaderboard-list";
  const mockData  = type === "topup" ? MOCK_TOPUP_LB : MOCK_REFERRAL_LB;
  const colName   = "leaderboards";
  const docName   = type === "topup" ? "topDepositors" : "topReferrers";

  try {
    getDocs(collection(db, colName))
      .then(snap => {
        // Try to find the right doc in leaderboards collection
        let found = false;
        snap.forEach(d => {
          if (d.id === docName) {
            found = true;
            const rows = d.data()?.entries || [];
            if (rows.length > 0) {
              _renderLeaderboard(tbodyId, rows.slice(0, 10));
            } else {
              _renderLeaderboard(tbodyId, mockData);
            }
          }
        });
        if (!found) {
          _renderLeaderboard(tbodyId, mockData);
        }
      })
      .catch(() => {
        _renderLeaderboard(tbodyId, mockData);
      });
  } catch (e) {
    _renderLeaderboard(tbodyId, mockData);
  }
}
