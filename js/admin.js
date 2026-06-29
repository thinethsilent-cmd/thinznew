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
    const expiresAt = getPlanExpiryDate(planName);
    const updateData = {
      premiumStatus: "paid",
      activePlan: planName,
      premiumActivatedAt: new Date().toISOString(),
      premiumExpiresAt: expiresAt  // null = Lifetime (never expires)
    };

    // Check for referral bonus
    try {
      const userSnap = await getDoc(userRef);
      if (userSnap.exists()) {
        const userData = userSnap.data();
        if (userData.referredBy && !userData.referralBonusProcessed) {
          const referrerId = userData.referredBy;
          const referrerRef = doc(db, "users", referrerId);
          const referrerSnap = await getDoc(referrerRef);
          if (referrerSnap.exists()) {
            const referrerData = referrerSnap.data();
            
            let newStatus = "paid";
            let newExpiresAt = null;
            let activePlan = "Referral Bonus (3 Days)";
            
            const now = new Date();
            if (referrerData.premiumStatus === "paid" && referrerData.premiumExpiresAt) {
              // Existing non-lifetime subscription - extend by 3 days
              const currentExpiry = new Date(referrerData.premiumExpiresAt);
              const baseDate = currentExpiry > now ? currentExpiry : now;
              baseDate.setDate(baseDate.getDate() + 3);
              newExpiresAt = baseDate.toISOString();
              activePlan = referrerData.activePlan || "VIP Premium";
            } else if (referrerData.premiumStatus === "paid" && !referrerData.premiumExpiresAt) {
              // Existing lifetime subscription - keep as lifetime
              newStatus = "paid";
              newExpiresAt = null;
              activePlan = referrerData.activePlan || "Lifetime";
            } else {
              // Free/expired/pending user - grant 3 days VIP
              now.setDate(now.getDate() + 3);
              newExpiresAt = now.toISOString();
            }

            const referrerUpdates = {
              premiumStatus: newStatus,
              activePlan: activePlan,
              premiumExpiresAt: newExpiresAt,
              successfulReferrals: (referrerData.successfulReferrals || 0) + 1,
              vipDaysEarned: (referrerData.vipDaysEarned || 0) + 3
            };
            await updateDoc(referrerRef, referrerUpdates);
            console.log(`Referrer ${referrerId} rewarded with 3 days VIP. Expire: ${newExpiresAt}`);
            
            // Mark referral bonus as processed
            updateData.referralBonusProcessed = true;
          }
        }
      }
    } catch (refErr) {
      console.error("Error processing referral bonus in approvePremium:", refErr);
    }

    await updateDoc(userRef, updateData);
    console.log(`User ${userId} approved: Plan "${planName}", expires: ${expiresAt || "Never"}`);
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
