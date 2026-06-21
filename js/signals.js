import { db } from "./firebase-config.js";
import { 
  collection, 
  addDoc, 
  onSnapshot, 
  query, 
  orderBy, 
  deleteDoc, 
  doc, 
  updateDoc 
} from "https://www.gstatic.com/firebasejs/12.15.0/firebase-firestore.js";

// ─── FREE SIGNAL POOL ────────────────────────────────────────────────────────
// Low-cost coins, low leverage (2x-5x), conservative entry, high-accuracy picks
// These are always fully visible to FREE users – no locking, no blurring.
const FREE_SIGNALS = [
  {
    id: "free-doge",
    pair: "DOGE/USDT",
    direction: "BUY",
    timeframe: "1H",
    entry: "0.1215",
    targets: ["0.1255", "0.1290", "0.1320"],
    stopLoss: "0.1175",
    leverage: "2x",
    minTrade: "$5",
    accuracy: "87%",
    status: "Pending",
    tier: "free",
    createdAt: new Date(Date.now() - 1000 * 60 * 8).toISOString()
  },
  {
    id: "free-xrp",
    pair: "XRP/USDT",
    direction: "BUY",
    timeframe: "4H",
    entry: "0.5820",
    targets: ["0.6050", "0.6250", "0.6500"],
    stopLoss: "0.5600",
    leverage: "3x",
    minTrade: "$5",
    accuracy: "84%",
    status: "Pending",
    tier: "free",
    createdAt: new Date(Date.now() - 1000 * 60 * 25).toISOString()
  },
  {
    id: "free-ada",
    pair: "ADA/USDT",
    direction: "BUY",
    timeframe: "1H",
    entry: "0.4450",
    targets: ["0.4620", "0.4780", "0.4950"],
    stopLoss: "0.4300",
    leverage: "2x",
    minTrade: "$5",
    accuracy: "82%",
    status: "Win",
    tier: "free",
    createdAt: new Date(Date.now() - 1000 * 60 * 90).toISOString()
  },
  {
    id: "free-matic",
    pair: "MATIC/USDT",
    direction: "SELL",
    timeframe: "15M",
    entry: "0.8920",
    targets: ["0.8700", "0.8500", "0.8300"],
    stopLoss: "0.9150",
    leverage: "2x",
    minTrade: "$5",
    accuracy: "80%",
    status: "Pending",
    tier: "free",
    createdAt: new Date(Date.now() - 1000 * 60 * 45).toISOString()
  },
  {
    id: "free-trx",
    pair: "TRX/USDT",
    direction: "BUY",
    timeframe: "4H",
    entry: "0.1085",
    targets: ["0.1130", "0.1175", "0.1220"],
    stopLoss: "0.1040",
    leverage: "3x",
    minTrade: "$5",
    accuracy: "85%",
    status: "Win",
    tier: "free",
    createdAt: new Date(Date.now() - 1000 * 60 * 180).toISOString()
  }
];

// ─── VIP PREMIUM SIGNAL FALLBACKS ────────────────────────────────────────────
// High-value coins, higher leverage, bigger profit targets – VIP only
const VIP_SIGNALS = [
  {
    id: "vip-btc",
    pair: "BTC/USDT",
    direction: "BUY",
    timeframe: "1H",
    entry: "67500",
    targets: ["68500", "69200", "70500"],
    stopLoss: "66000",
    leverage: "10x",
    minTrade: "$50",
    accuracy: "91%",
    status: "Pending",
    tier: "vip",
    createdAt: new Date(Date.now() - 1000 * 60 * 10).toISOString()
  },
  {
    id: "vip-eth",
    pair: "ETH/USDT",
    direction: "BUY",
    timeframe: "4H",
    entry: "3520",
    targets: ["3650", "3780", "3900"],
    stopLoss: "3400",
    leverage: "8x",
    minTrade: "$30",
    accuracy: "89%",
    status: "Win",
    tier: "vip",
    createdAt: new Date(Date.now() - 1000 * 60 * 120).toISOString()
  },
  {
    id: "vip-sol",
    pair: "SOL/USDT",
    direction: "SELL",
    timeframe: "15M",
    entry: "148.50",
    targets: ["144.00", "141.20", "138.00"],
    stopLoss: "152.00",
    leverage: "5x",
    minTrade: "$20",
    accuracy: "88%",
    status: "Pending",
    tier: "vip",
    createdAt: new Date(Date.now() - 1000 * 60 * 30).toISOString()
  },
  {
    id: "vip-bnb",
    pair: "BNB/USDT",
    direction: "BUY",
    timeframe: "1H",
    entry: "585.00",
    targets: ["602.00", "615.00", "630.00"],
    stopLoss: "572.00",
    leverage: "7x",
    minTrade: "$30",
    accuracy: "86%",
    status: "Pending",
    tier: "vip",
    createdAt: new Date(Date.now() - 1000 * 60 * 240).toISOString()
  }
];

// ─── SUBSCRIBE TO SIGNALS ─────────────────────────────────────────────────────
export function subscribeToSignals(premiumStatus, callback) {
  const q = query(collection(db, "signals"), orderBy("createdAt", "desc"));

  return onSnapshot(q, (snapshot) => {
    let dbSignals = [];
    snapshot.forEach((docSnap) => {
      dbSignals.push({ id: docSnap.id, ...docSnap.data() });
    });

    let processedSignals = [];

    if (premiumStatus === "paid" || premiumStatus === "admin") {
      // ── VIP / Admin: show ALL signals, fully unlocked ──
      const allSignals = dbSignals.length > 0 ? dbSignals : [...FREE_SIGNALS, ...VIP_SIGNALS];
      processedSignals = allSignals.map(sig => ({ ...sig, locked: false }));

    } else {
      // ── Free user: show free signals fully + lock VIP signals ──

      // Split db signals by tier if admin tagged them, else treat all as unlocked
      const dbFree = dbSignals.filter(s => s.tier === "free");
      const dbVip  = dbSignals.filter(s => s.tier === "vip" || !s.tier);

      // Filter signals to only show those created within the last 24 hours (1 day)
      const oneDayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
      const activeFreeDb = dbFree.filter(s => s.createdAt >= oneDayAgo);
      const activeFreeStatic = FREE_SIGNALS.filter(s => s.createdAt >= oneDayAgo);

      // Use real DB free signals (filtered), fallback to static FREE_SIGNALS pool (filtered), limited to exactly 2 signals per day
      const freeToShow = (dbFree.length > 0 ? activeFreeDb : activeFreeStatic).slice(0, 2);

      // Lock VIP signals (show pair/direction but hide entry/targets/stoploss)
      const vipToShow = (dbVip.length > 0 ? dbVip : VIP_SIGNALS).map(sig => ({
        id: sig.id,
        pair: sig.pair,
        direction: sig.direction,
        timeframe: sig.timeframe,
        status: sig.status,
        tier: "vip",
        locked: true,
        entry: "•••",
        targets: ["•••", "•••", "•••"],
        stopLoss: "•••",
        leverage: "VIP",
        minTrade: "VIP",
        accuracy: "90%+",
        createdAt: sig.createdAt
      }));

      // Free signals appear first (fully visible), then locked VIP below
      processedSignals = [
        ...freeToShow.map(sig => ({ ...sig, locked: false })),
        ...vipToShow
      ];
    }

    callback(processedSignals);
  }, (error) => {
    console.error("Error subscribing to signals:", error);
  });
}

// ─── ADMIN: Add a new signal ──────────────────────────────────────────────────
// When creating from admin panel, set tier: "free" or tier: "vip"
export async function createSignal(signalData) {
  try {
    const docRef = await addDoc(collection(db, "signals"), {
      ...signalData,
      createdAt: new Date().toISOString(),
      status: "Pending"
    });
    return docRef.id;
  } catch (error) {
    console.error("Error creating signal:", error);
    throw error;
  }
}

// ─── ADMIN: Update signal status (Win / Loss) ─────────────────────────────────
export async function updateSignalStatus(signalId, status) {
  try {
    await updateDoc(doc(db, "signals", signalId), { status });
  } catch (error) {
    console.error("Error updating signal status:", error);
    throw error;
  }
}

// ─── ADMIN: Delete a signal ───────────────────────────────────────────────────
export async function deleteSignal(signalId) {
  try {
    await deleteDoc(doc(db, "signals", signalId));
  } catch (error) {
    console.error("Error deleting signal:", error);
    throw error;
  }
}

