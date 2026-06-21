import { db } from "./firebase-config.js";
import { 
  collection, 
  onSnapshot, 
  query, 
  doc, 
  updateDoc 
} from "https://www.gstatic.com/firebasejs/12.15.0/firebase-firestore.js";

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

// Approve payment and upgrade user to paid/premium status
export async function approvePremium(userId) {
  try {
    const userRef = doc(db, "users", userId);
    await updateDoc(userRef, {
      premiumStatus: "paid"
    });
    console.log(`User ${userId} premium status approved.`);
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
      paymentTxid: null // clear transaction hash
    });
    console.log(`User ${userId} premium status rejected/reset.`);
  } catch (error) {
    console.error("Error rejecting premium:", error);
    throw error;
  }
}
