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

// ─── DYNAMIC REAL SIGNALS FROM BINANCE ───────────────────────────────────────
let cachedRealSignals = null;

async function fetchRealSignals() {
  try {
    const response = await fetch("https://api.binance.com/api/v3/ticker/24hr");
    const data = await response.json();
    
    // Filter for USDT pairs with good volume
    const pairs = data
      .filter(d => d.symbol.endsWith("USDT") && parseFloat(d.volume) > 10000)
      .sort((a, b) => parseFloat(b.quoteVolume) - parseFloat(a.quoteVolume))
      .slice(0, 100); // Top 100 pairs for "unlimited" feel
      
    const signals = pairs.map((p, index) => {
      const currentPrice = parseFloat(p.lastPrice);
      const isBuy = parseFloat(p.priceChangePercent) > 0;
      
      const entry = currentPrice;
      const target1 = isBuy ? entry * 1.015 : entry * 0.985;
      const target2 = isBuy ? entry * 1.03 : entry * 0.97;
      const target3 = isBuy ? entry * 1.06 : entry * 0.94;
      const stopLoss = isBuy ? entry * 0.97 : entry * 1.03;
      
      const formatPrice = (price) => {
        if (price < 0.0001) return price.toFixed(8);
        if (price < 0.01) return price.toFixed(6);
        if (price < 1) return price.toFixed(4);
        if (price < 10) return price.toFixed(3);
        return price.toFixed(2);
      };

      return {
        id: `live-${p.symbol}`,
        pair: `${p.symbol.replace("USDT", "")}/USDT`,
        direction: isBuy ? "BUY" : "SELL",
        timeframe: ["15M", "1H", "4H"][Math.floor(Math.random() * 3)],
        entry: formatPrice(entry),
        targets: [formatPrice(target1), formatPrice(target2), formatPrice(target3)],
        stopLoss: formatPrice(stopLoss),
        leverage: Math.floor(Math.random() * 15 + 5) + "x",
        minTrade: "$10",
        accuracy: (Math.random() * 4 + 95).toFixed(1) + "%", // 95% - 99% high accuracy
        status: "Pending",
        tier: index < 2 ? "free" : "vip",
        createdAt: new Date(Date.now() - index * 60000).toISOString()
      };
    });
    
    return signals;
  } catch (e) {
    console.error("Error fetching real signals:", e);
    return [];
  }
}

// ─── SUBSCRIBE TO SIGNALS ─────────────────────────────────────────────────────
export function subscribeToSignals(premiumStatus, callback) {
  const q = query(collection(db, "signals"), orderBy("createdAt", "desc"));

  return onSnapshot(q, async (snapshot) => {
    let dbSignals = [];
    snapshot.forEach((docSnap) => {
      dbSignals.push({ id: docSnap.id, ...docSnap.data() });
    });

    if (!cachedRealSignals) {
       cachedRealSignals = await fetchRealSignals();
    }

    let processedSignals = [];

    // Combine DB signals and Real Binance Signals
    const allFree = dbSignals.filter(s => s.tier === "free").concat(cachedRealSignals.filter(s => s.tier === "free"));
    const allVip = dbSignals.filter(s => s.tier === "vip" || !s.tier).concat(cachedRealSignals.filter(s => s.tier === "vip"));

    if (premiumStatus === "paid" || premiumStatus === "admin") {
      // ── VIP / Admin: show ALL signals, fully unlocked ──
      const allSignals = [...allFree, ...allVip];
      processedSignals = allSignals.map(sig => ({ ...sig, locked: false }));

    } else {
      // ── Free user: show free signals fully + lock VIP signals ──

      // Filter free signals to only show those created within the last 24 hours (1 day)
      const oneDayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
      const activeFree = allFree.filter(s => s.createdAt >= oneDayAgo);

      // exactly 2 signals per day for free
      const freeToShow = activeFree.slice(0, 2);

      // Lock VIP signals (show pair/direction but hide entry/targets/stoploss)
      const vipToShow = allVip.map(sig => ({
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
        accuracy: "95%+",
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

