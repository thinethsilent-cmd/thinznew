// Common core logic for the multi‑page site
// Derived from the original js/app.js with hash‑router removed.
// Provides global state, Firebase auth handling, UI helpers, and page‑specific loaders.

import { observeAuthState, signIn, signUp, signOutUser, getUserDoc, signInWithGoogle } from "./auth.js";
import { subscribeToSignals, createSignal, updateSignalStatus, deleteSignal } from "./signals.js";
import { subscribeToTrades, startAutoTrading, stopAutoTrading, saveApiKeys } from "./bot.js";
import { subscribeToAllUsers, approvePremium, rejectPremium } from "./admin.js";
import { auth, db, storage } from "./firebase-config.js";
import { doc, updateDoc } from "https://www.gstatic.com/firebasejs/12.15.0/firebase-firestore.js";
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
      updatePlanBadge(profile?.premiumStatus);
    } else {
      // Logged‑out UI
      authLinks.forEach(el => el.classList.add('hidden'));
      guestLinks.forEach(el => el.classList.remove('hidden'));
      if (profileSection) profileSection.classList.add('hidden');
      if (adminLink) adminLink.classList.add('hidden');
      updatePlanBadge('free');
    }
  });
}

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
        await signUp(email, pass, name);
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
        const { userData } = await signInWithGoogle();
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
      const txid = document.getElementById('payment-txid').value.trim();
      const msgEl = document.getElementById('payment-msg');
      const submitBtn = paymentForm.querySelector("button[type='submit']");
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
        // Step 1: Try uploading image with live progress bar
        const fileInput = document.getElementById('payment-slip');
        let slipUrl = null;
        if (fileInput && fileInput.files.length > 0) {
          const file = fileInput.files[0];
          try {
            console.log("Starting payment slip upload:", file.name, file.size);
            if (progressWrap) progressWrap.classList.remove('hidden');
            setProgress(0);
            msgEl.textContent = 'Uploading payment slip...';

            const storageRef = ref(storage, `payment_slips/${state.user.uid}/${Date.now()}_${file.name}`);
            const uploadTask = uploadBytesResumable(storageRef, file);
            slipUrl = await new Promise((resolve, reject) => {
              // Add a timeout of 7 seconds so we don't get stuck indefinitely
              const timeoutId = setTimeout(() => {
                reject(new Error("Upload timed out (7 seconds limit reached)."));
              }, 7000);

              uploadTask.on('state_changed',
                (snapshot) => {
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
            // Brief pause so user sees 100% 
            await new Promise(r => setTimeout(r, 600));
          } catch (uploadErr) {
            console.warn('Image upload failed:', uploadErr);
            msgEl.className = 'status-message text-red';
            msgEl.textContent = `⚠️ Slip upload failed: ${uploadErr.message || uploadErr}. Submitting without image...`;
            // Keep this warning message visible for 3 seconds so the user can read it
            await new Promise(r => setTimeout(r, 3000));
          } finally {
            if (progressWrap) progressWrap.classList.add('hidden');
            setProgress(0);
          }
        }

        // Step 2: Save to Firestore
        msgEl.className = 'status-message text-yellow';
        msgEl.textContent = 'Saving verification request...';
        const userRef = doc(db, 'users', state.user.uid);
        await updateDoc(userRef, {
          premiumStatus: 'pending',
          paymentTxid: txid,
          paymentRequestedAt: new Date().toISOString(),
          ...(slipUrl && { paymentSlipUrl: slipUrl })
        });

        // Step 3: Update UI
        state.profile.premiumStatus = 'pending';
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
        if (progressWrap) progressWrap.classList.add('hidden');
      }
    });
  }
}

// ------------------------------------------------------------------
// Page‑specific loader functions (extracted from original app.js)
export function loadSignalsPage() {
  const container = document.getElementById('signals-list');
  if (!container) return;
  container.innerHTML = `<div class="loading-spinner">Loading Crypto Signals...</div>`;
  const status = state.profile?.role === 'admin' ? 'admin' : state.profile?.premiumStatus || 'free';
  activeUnsubscribes.signals = subscribeToSignals(status, signals => {
    container.innerHTML = '';
    if (signals.length === 0) {
      container.innerHTML = `<div class="empty-state">No trading signals active at the moment.</div>`;
      return;
    }
    signals.forEach(sig => {
      const card = document.createElement('div');
      card.className = `signal-card ${sig.direction.toLowerCase() === 'buy' ? 'card-buy' : 'card-sell'}`;
      const badgeClass = sig.status === 'Win' ? 'status-win' : sig.status === 'Loss' ? 'status-loss' : 'status-pending';
      const targetsList = sig.targets.map((t, i) => `<li>Target ${i + 1}: <span class="text-white font-medium">${t}</span></li>`).join('');
      // Extra meta badges for unlocked signals (leverage, rrr, rsi, confluence, accuracy)
      const metaBadges = !sig.locked ? `
        <div class="signal-meta-row">
          ${sig.leverage ? `<span class="meta-badge leverage-badge">⚡ ${sig.leverage} Leverage</span>` : ""}
          ${sig.rrr ? `<span class="meta-badge rrr-badge">🔢 R:R ${sig.rrr}</span>` : ""}
          ${sig.rsi ? `<span class="meta-badge rsi-badge">📊 RSI ${sig.rsi}</span>` : ""}
          ${sig.confluenceScore ? `<span class="meta-badge confluence-badge">✨ Confluence ${sig.confluenceScore}</span>` : ""}
          ${sig.accuracy ? `<span class="meta-badge accuracy-badge">🎯 ${sig.accuracy} Acc</span>` : ""}
          ${sig.tier === 'free' ? `<span class="meta-badge free-badge">FREE Signal</span>` : `<span class="meta-badge vip-badge">⭐ VIP</span>`}
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
          <div class="signal-detail"><span>Entry Target</span><strong>${sig.entry}</strong></div>
          <div class="signal-detail"><span>Stop Loss</span><strong class="text-red">${sig.stopLoss}</strong></div>
          <div class="signal-targets"><span>Take Profit Targets</span><ul>${targetsList}</ul></div>
        </div>
        <div class="signal-analysis">
          <div class="analysis-title">🔬 Confluence Analysis</div>
          <div class="analysis-text">${sig.analysisText || 'Real-time indicators alignment check'}</div>
        </div>
        ${metaBadges}
      `;
      if (sig.locked) {
        card.classList.add('locked-card');
        html = `
          <div class="lock-overlay">
            <svg class="lock-icon" fill="currentColor" viewBox="0 0 20 20"><path d="M10 2a5 5 0 00-5 5v2a2 2 0 00-2 2v5a2 2 0 002 2h10a2 2 0 002-2v-5a2 2 0 00-2-2V7a5 5 0 00-5-5zM7 7a3 3 0 016 0v2H7V7z"/></svg>
            <h4 class="lock-title">VIP Premium Signal – ${sig.pair}</h4>
            <p class="lock-desc">Real TA-Verified VIP signal with up to 98% accuracy. Upgrade to unlock all signals + auto-bot.</p>
            <a href="account.html" class="btn btn-primary btn-sm">Upgrade</a>
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
}

export function loadAdminPage() {
  const pendingList = document.getElementById('admin-pending-payments');
  const userList = document.getElementById('admin-users-list');
  const signalsTable = document.getElementById('admin-signals-table');
  if (!pendingList || !userList || !signalsTable) return;

  // Users & pending payments
  activeUnsubscribes.users = subscribeToAllUsers(users => {
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
        card.innerHTML = `
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
        pendingList.appendChild(card);
      });
      // Approve / Reject handlers
      document.querySelectorAll('.btn-approve').forEach(btn => {
        btn.addEventListener('click', async e => {
          const uid = e.target.getAttribute('data-id');
          e.target.disabled = true;
          e.target.textContent = 'Approving...';
          await approvePremium(uid);
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

    // Users list
    if (users.length === 0) {
      userList.innerHTML = `<tr><td colspan="4" class="text-center py-3 text-gray">No users registered.</td></tr>`;
    } else {
      users.forEach(u => {
        const winLoss = u.winLoss || { wins: 0, losses: 0 };
        const total = winLoss.wins + winLoss.losses;
        const winRate = total > 0 ? ((winLoss.wins / total) * 100).toFixed(1) + '%' : '0%';
        const row = document.createElement('tr');
        row.innerHTML = `
          <td class="py-3 px-4 text-white font-medium">${u.displayName || 'No Name'}</td>
          <td class="py-3 px-4">${u.email}</td>
          <td class="py-3 px-4"><span class="badge-${u.premiumStatus === 'paid' ? 'buy' : u.premiumStatus === 'pending' ? 'pending' : 'sell'}">${u.premiumStatus.toUpperCase()}</span></td>
          <td class="py-3 px-4 font-mono text-green">${winLoss.wins}W <span class="text-red">${winLoss.losses}L</span> (${winRate})</td>
        `;
        userList.appendChild(row);
      });
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
    // (Admin actions implementation omitted for brevity)
  });
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
  if (pnlEl) {
    pnlEl.textContent = (totalPnl >= 0 ? '+' : '') + totalPnl.toFixed(2) + '%';
    pnlEl.className = totalPnl > 0 ? 'metric-value text-green' : totalPnl < 0 ? 'metric-value text-red' : 'metric-value text-gray';
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
  logEl.innerHTML += `<div>[${time}] ${msg}</div>`;
  logEl.scrollTop = logEl.scrollHeight;
}

// ------------------------------------------------------------------
// Initialise the app – called from each page's <script type="module">
export function initApp() {
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
