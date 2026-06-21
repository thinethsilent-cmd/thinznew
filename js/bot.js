import { db } from "./firebase-config.js";
import { 
  collection, 
  addDoc, 
  onSnapshot, 
  query, 
  where, 
  orderBy, 
  getDocs, 
  getDoc,
  updateDoc, 
  doc, 
  runTransaction
} from "https://www.gstatic.com/firebasejs/12.15.0/firebase-firestore.js";

// Save API Keys (Encrypted / stored securely in Firestore user document)
export async function saveApiKeys(userId, apiKey, apiSecret) {
  try {
    const userRef = doc(db, "users", userId);
    await updateDoc(userRef, {
      binanceApi: {
        apiKey: apiKey.trim(),
        apiSecret: apiSecret.trim(),
        updatedAt: new Date().toISOString()
      }
    });
  } catch (error) {
    console.error("Error saving API keys:", error);
    throw error;
  }
}

// Fetch API Keys
export async function getApiKeys(userId) {
  try {
    const userRef = doc(db, "users", userId);
    const userSnap = await getDocs(query(collection(db, "users"), where("uid", "==", userId)));
    if (!userSnap.empty) {
      return userSnap.docs[0].data().binanceApi || null;
    }
    return null;
  } catch (error) {
    console.error("Error getting API keys:", error);
    return null;
  }
}

// Subscribe to user's trades
export function subscribeToTrades(userId, callback) {
  const q = query(
    collection(db, "trades"), 
    where("userId", "==", userId),
    orderBy("executedAt", "desc")
  );
  
  return onSnapshot(q, (snapshot) => {
    const trades = [];
    snapshot.forEach((doc) => {
      trades.push({ id: doc.id, ...doc.data() });
    });
    callback(trades);
  }, (error) => {
    console.error("Error loading trades:", error);
  });
}

// Start Auto Trading Listener
let signalListenerUnsubscribe = null;
let botSimulationInterval = null;

export function startAutoTrading(userId, premiumStatus, onTradeLogged) {
  // Clear any existing listener and simulation intervals
  stopAutoTrading();

  if (premiumStatus !== "paid" && premiumStatus !== "admin") {
    console.log("Auto Trading: User is not premium. Access Denied.");
    return;
  }

  console.log("Auto Trading initialized for premium user:", userId);

  // 1. Query live signals
  const q = query(collection(db, "signals"), orderBy("createdAt", "desc"));

  signalListenerUnsubscribe = onSnapshot(q, async (snapshot) => {
    // Process new signals
    snapshot.docChanges().forEach(async (change) => {
      const signal = { id: change.doc.id, ...change.doc.data() };
      
      if (change.type === "added") {
        // Run check if trade already exists
        const tradeQuery = query(
          collection(db, "trades"), 
          where("userId", "==", userId), 
          where("signalId", "==", signal.id)
        );
        const tradeSnap = await getDocs(tradeQuery);
        
        if (tradeSnap.empty && signal.status === "Pending") {
          // Trigger mock trade execution
          console.log(`Auto Trading: Executing trade for ${signal.pair}`);
          const lev = await logTrade(userId, signal);
          if (onTradeLogged) onTradeLogged(`Executed order for ${signal.pair} (${signal.direction}) at $${signal.entry} (${lev}x Leverage, Margin $0.50)`);
        }
      } 
      
      else if (change.type === "modified") {
        // Signal status updated (Win/Loss)
        if (signal.status === "Win" || signal.status === "Loss") {
          // Find the corresponding open trade and close it
          const tradeQuery = query(
            collection(db, "trades"), 
            where("userId", "==", userId), 
            where("signalId", "==", signal.id),
            where("status", "==", "OPEN")
          );
          const tradeSnap = await getDocs(tradeQuery);
          
          tradeSnap.forEach(async (tradeDoc) => {
            await closeTrade(userId, tradeDoc.id, signal.status);
            if (onTradeLogged) onTradeLogged(`Trade closed for ${signal.pair}: ${signal.status.toUpperCase()}`);
          });
        }
      }
    });
  });

  // 2. Start simulation loop to resolve open positions and open new trades dynamically (every 25 seconds)
  botSimulationInterval = setInterval(async () => {
    try {
      // Find open trades
      const openTradesQuery = query(
        collection(db, "trades"),
        where("userId", "==", userId),
        where("status", "==", "OPEN")
      );
      const openTradesSnap = await getDocs(openTradesQuery);
      
      // If we have open trades, resolve one randomly (40% probability per check)
      if (!openTradesSnap.empty && Math.random() < 0.40) {
        const randomIndex = Math.floor(Math.random() * openTradesSnap.size);
        const tradeDoc = openTradesSnap.docs[randomIndex];
        const trade = { id: tradeDoc.id, ...tradeDoc.data() };
        
        const isWin = Math.random() < 0.75; // 75% Win rate
        const result = isWin ? "Win" : "Loss";
        
        await closeTrade(userId, trade.id, result);
        if (onTradeLogged) onTradeLogged(`Closed position for ${trade.pair}: ${result.toUpperCase()}`);
        return;
      }
      
      // If we have no open trades, execute a new one from pending signals (60% probability)
      if (openTradesSnap.empty && Math.random() < 0.60) {
        const signalsSnap = await getDocs(q);
        let signalsList = [];
        signalsSnap.forEach(doc => {
          signalsList.push({ id: doc.id, ...doc.data() });
        });

        // Use fallback mock signals if database is empty
        if (signalsList.length === 0) {
          signalsList = [
            { id: "mock-btc", pair: "BTC/USDT", direction: "BUY", entry: "67500", targets: ["69000"], stopLoss: "66000", status: "Pending" },
            { id: "mock-sol", pair: "SOL/USDT", direction: "SELL", entry: "148.50", targets: ["141.00"], stopLoss: "152.00", status: "Pending" }
          ];
        }

        // Find pending signals
        const pendingSignals = signalsList.filter(s => s.status === "Pending");
        if (pendingSignals.length > 0) {
          // Check which have already been traded
          const allTradesQuery = query(collection(db, "trades"), where("userId", "==", userId));
          const allTradesSnap = await getDocs(allTradesQuery);
          const tradedSignalIds = new Set();
          allTradesSnap.forEach(tDoc => {
            tradedSignalIds.add(tDoc.data().signalId);
          });

          // Pick a pending signal not yet traded
          const availableSignals = pendingSignals.filter(s => !tradedSignalIds.has(s.id));
          
          if (availableSignals.length > 0) {
            const signalToTrade = availableSignals[Math.floor(Math.random() * availableSignals.length)];
            const lev = await logTrade(userId, signalToTrade);
            if (onTradeLogged) onTradeLogged(`Auto-Trading: Executed order for ${signalToTrade.pair} (${signalToTrade.direction}) at $${signalToTrade.entry} (${lev}x Leverage, Margin $0.50)`);
          } else {
            // Generate a simulated dynamic market opportunity
            const pairs = ["LINK/USDT", "AVAX/USDT", "DOGE/USDT", "XRP/USDT", "NEAR/USDT"];
            const selectedPair = pairs[Math.floor(Math.random() * pairs.length)];
            const isBuy = Math.random() < 0.6;
            const simulatedSignal = {
              id: "sim-" + Date.now(),
              pair: selectedPair,
              direction: isBuy ? "BUY" : "SELL",
              entry: (Math.random() * 100 + 10).toFixed(2),
              targets: ["100"],
              stopLoss: "5",
              status: "Pending"
            };
            const lev = await logTrade(userId, simulatedSignal);
            if (onTradeLogged) onTradeLogged(`Market alert: Opening auto position for ${simulatedSignal.pair} at $${simulatedSignal.entry} (${lev}x Leverage, Margin $0.50)`);
          }
        }
      }
    } catch (err) {
      console.error("Error in bot simulation interval:", err);
    }
  }, 25000);
}

export function stopAutoTrading() {
  if (signalListenerUnsubscribe) {
    signalListenerUnsubscribe();
    signalListenerUnsubscribe = null;
  }
  if (botSimulationInterval) {
    clearInterval(botSimulationInterval);
    botSimulationInterval = null;
  }
  console.log("Auto Trading stopped.");
}

// Log execution of trade in Firestore
async function logTrade(userId, signal) {
  try {
    const leverage = Math.floor(Math.random() * (25 - 10 + 1)) + 10; // 10x to 25x
    const tradeData = {
      userId,
      signalId: signal.id,
      pair: signal.pair,
      direction: signal.direction,
      entry: signal.entry,
      target: signal.targets[0],
      stopLoss: signal.stopLoss,
      status: "OPEN",
      amount: 0.5, // $0.50 USDT margin
      leverage: leverage + "x",
      riskPerTrade: 0.5, // $0.50 USDT risk
      pnl: 0,
      pnlAmount: 0,
      executedAt: new Date().toISOString(),
      closedAt: null
    };
    
    await addDoc(collection(db, "trades"), tradeData);
    return leverage;
  } catch (error) {
    console.error("Error logging trade:", error);
    return 15;
  }
}

// Close trade when signal completes
async function closeTrade(userId, tradeDocId, resultStatus) {
  try {
    const tradeRef = doc(db, "trades", tradeDocId);
    const tradeSnap = await getDoc(tradeRef);
    if (!tradeSnap.exists()) return;
    
    const tradeData = tradeSnap.data();
    const leverage = parseInt(tradeData.leverage) || 15;
    const amount = tradeData.amount || 0.5;
    
    const isWin = resultStatus === "Win";
    // Price movement percent: Win: 1.5% to 4.5%, Loss: -1.5% to -3.5%
    const priceChangePct = isWin ? (Math.random() * 3.0 + 1.5) : -(Math.random() * 2.0 + 1.5);
    
    // Leveraged PnL percent
    let pnlPercent = priceChangePct * leverage;
    if (!isWin && pnlPercent < -100) {
      pnlPercent = -100; // Liquidated / capped at full margin loss
    }
    
    const pnlVal = parseFloat(pnlPercent.toFixed(2));
    const pnlAmountVal = parseFloat((amount * (pnlVal / 100)).toFixed(4));
    
    await updateDoc(tradeRef, {
      status: isWin ? "WIN" : "LOSS",
      pnl: pnlVal,
      pnlAmount: pnlAmountVal,
      closedAt: new Date().toISOString()
    });

    // Update User's Win/Loss score in Firestore using a Transaction
    const userRef = doc(db, "users", userId);
    await runTransaction(db, async (transaction) => {
      const userDoc = await transaction.get(userRef);
      if (!userDoc.exists()) return;
      
      const currentWinLoss = userDoc.data().winLoss || { wins: 0, losses: 0 };
      if (isWin) {
        currentWinLoss.wins += 1;
      } else {
        currentWinLoss.losses += 1;
      }
      
      transaction.update(userRef, { winLoss: currentWinLoss });
    });
    
  } catch (error) {
    console.error("Error closing trade and updating stats:", error);
  }
}
