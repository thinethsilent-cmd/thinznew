import { db } from "./firebase-config.js";
import { 
  collection, 
  onSnapshot, 
  query, 
  doc, 
  updateDoc,
  getDocs,
  getDoc
} from "https://www.gstatic.com/firebasejs/12.15.0/firebase-firestore.js";

// Calculate expiry date based on plan name
function getPlanExpiryDate(planName) {
  const now = new Date();
  switch (planName) {
    case "7 Days":    now.setDate(now.getDate() + 7);   break;
    case "2 Weeks":   now.setDate(now.getDate() + 14);  break;
    case "1 Month":   now.setMonth(now.getMonth() + 1); break;
    case "3 Months":  now.setMonth(now.getMonth() + 3); break;
    case "Lifetime":  return null; // null = never expires
    default:          now.setMonth(now.getMonth() + 1); // default 1 month
  }
  return now.toISOString();
}

// Subscribe to all users in the system (Admin only)
export function subscribeToAllUsers(callback) {
  const q = query(collection(db, "users"));
  
  return onSnapshot(q, (snapshot) => {
    const users = [];
    snapshot.forEach((doc) => {
      users.push({ id: doc.id, ...doc.data() });
    });
    callback(users);
  }, (error) => {
    console.error("Error loading users for admin:", error);
  });
}

// Approve payment and upgrade user to paid/premium status with plan-based expiry
export async function approvePremium(userId, planName = "1 Month") {
  try {
    const userRef = doc(db, "users", userId);
    const userSnap = await getDoc(userRef);
    if (!userSnap.exists()) throw new Error("User profile not found.");

    const userData = userSnap.data();
    const finalPlan = userData.paymentPlan || planName;
    const expiresAt = getPlanExpiryDate(finalPlan);

    const updateData = {
      premiumStatus: "paid",
      activePlan: finalPlan,
      premiumActivatedAt: new Date().toISOString(),
      premiumExpiresAt: expiresAt  // null = Lifetime (never expires)
    };

    // Check for referral commission (15%)
    try {
      if (userData.referredBy && !userData.referralBonusProcessed) {
        const referrerId = userData.referredBy;
        const referrerRef = doc(db, "users", referrerId);
        const referrerSnap = await getDoc(referrerRef);
        if (referrerSnap.exists()) {
          const referrerData = referrerSnap.data();
          
          // Calculate 15% commission in USD
          const getPriceUSD = (plan) => {
            switch (plan) {
              case "7 Days": return 5.00;
              case "2 Weeks": return 9.67;
              case "1 Month": return 16.67;
              case "3 Months": return 36.67;
              case "Lifetime": return 66.67;
              default: return 16.67;
            }
          };

          const packagePriceUSD = getPriceUSD(finalPlan);
          const commissionUSD = parseFloat((packagePriceUSD * 0.15).toFixed(2));
          
          const currentWallet = referrerData.walletBalance || 0;
          const currentEarnings = referrerData.totalReferralEarnings || 0;
          
          await updateDoc(referrerRef, {
            walletBalance: parseFloat((currentWallet + commissionUSD).toFixed(2)),
            totalReferralEarnings: parseFloat((currentEarnings + commissionUSD).toFixed(2))
          });

          console.log(`Referrer ${referrerId} awarded 15% commission of package price $${packagePriceUSD} = $${commissionUSD}`);
          
          // Mark referral bonus as processed
          updateData.referralBonusProcessed = true;
        }
      }
    } catch (refErr) {
      console.error("Error processing referral commission in approvePremium:", refErr);
    }

    await updateDoc(userRef, updateData);
    console.log(`User ${userId} approved: Plan "${finalPlan}", expires: ${expiresAt || "Never"}`);
  } catch (error) {
    console.error("Error approving premium:", error);
    throw error;
  }
}

// Reject/revoke payment request and reset user back to free status
export async function rejectPremium(userId) {
  try {
    const userRef = doc(db, "users", userId);
    await updateDoc(userRef, {
      premiumStatus: "free",
      paymentTxid: null,
      activePlan: null,
      premiumExpiresAt: null
    });
    console.log(`User ${userId} premium status rejected/reset.`);
  } catch (error) {
    console.error("Error rejecting premium:", error);
    throw error;
  }
}

// Approve user top-up request and credit their wallet balance
export async function approveTopup(userId) {
  try {
    const userRef = doc(db, "users", userId);
    const userSnap = await getDoc(userRef);
    if (!userSnap.exists()) throw new Error("User does not exist.");
    
    const userData = userSnap.data();
    if (userData.topupStatus !== "pending") throw new Error("No pending top-up request found.");
    
    const topupAmt = userData.topupAmount || 0;
    const newBalance = parseFloat(((userData.walletBalance || 0) + topupAmt).toFixed(2));
    
    await updateDoc(userRef, {
      walletBalance: newBalance,
      topupStatus: "approved",
      topupAmount: null,
      topupTxid: null,
      topupSlipUrl: null,
      topupRequestedAt: null
    });
    
    console.log(`Top-up of $${topupAmt} approved for user ${userId}. New balance: $${newBalance}`);
  } catch (error) {
    console.error("Error approving top-up:", error);
    throw error;
  }
}

// Reject/revoke top-up request
export async function rejectTopup(userId) {
  try {
    const userRef = doc(db, "users", userId);
    await updateDoc(userRef, {
      topupStatus: "rejected",
      topupAmount: null,
      topupTxid: null,
      topupSlipUrl: null,
      topupRequestedAt: null
    });
    console.log(`Top-up request rejected for user ${userId}.`);
  } catch (error) {
    console.error("Error rejecting top-up:", error);
    throw error;
  }
}

// Auto-expire: Check if the logged-in user's membership has passed expiry and reset if so
export async function checkAndExpireMembership(userId, userProfile) {
  try {
    if (userProfile.premiumStatus !== "paid") return false;
    if (!userProfile.premiumExpiresAt) return false; // Lifetime – never expires
    
    const now = new Date();
    const expiry = new Date(userProfile.premiumExpiresAt);
    
    if (now > expiry) {
      // Membership has expired – auto-downgrade to free
      const userRef = doc(db, "users", userId);
      await updateDoc(userRef, {
        premiumStatus: "expired",
        activePlan: null,
        premiumExpiresAt: null
      });
      console.log(`User ${userId} membership expired. Auto-downgraded to free.`);
      return true; // was expired
    }
    return false;
  } catch (error) {
    console.error("Error checking membership expiry:", error);
    return false;
  }
}
