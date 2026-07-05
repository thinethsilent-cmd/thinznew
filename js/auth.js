import { auth, db } from "./firebase-config.js";
import { 
  createUserWithEmailAndPassword, 
  signInWithEmailAndPassword, 
  signOut, 
  onAuthStateChanged,
  updateProfile,
  GoogleAuthProvider,
  signInWithPopup
} from "https://www.gstatic.com/firebasejs/12.15.0/firebase-auth.js";
import { doc, setDoc, getDoc, updateDoc } from "https://www.gstatic.com/firebasejs/12.15.0/firebase-firestore.js";
import { sendWelcomeEmail } from "./email.js";

// Check if user is logged in and listen for state changes
export function observeAuthState(callback) {
  return onAuthStateChanged(auth, async (user) => {
    if (user) {
      try {
        const userDoc = await getUserDoc(user.uid);
        callback(user, userDoc ? userDoc.data() : null);
      } catch (err) {
        console.error("Error fetching user data on auth state change:", err);
        callback(user, null);
      }
    } else {
      callback(null, null);
    }
  });
}

// Get user profile document from Firestore
export async function getUserDoc(uid) {
  const docRef = doc(db, "users", uid);
  const docSnap = await getDoc(docRef);
  if (docSnap.exists()) {
    return docSnap;
  }
  return null;
}

// Sign up function
export async function signUp(email, password, displayName, referredBy = null) {
  try {
    // Device Registration Limit Check
    const deviceAccounts = JSON.parse(localStorage.getItem("device_accounts") || "[]");
    const cleanEmail = email.toLowerCase().trim();
    if (deviceAccounts.length >= 2 && !deviceAccounts.includes(cleanEmail)) {
      throw new Error("Device Registration Limit: You can create a maximum of 2 accounts on this device.");
    }

    const userCredential = await createUserWithEmailAndPassword(auth, email, password);
    const user = userCredential.user;

    // Save to device accounts list
    if (!deviceAccounts.includes(cleanEmail)) {
      deviceAccounts.push(cleanEmail);
      localStorage.setItem("device_accounts", JSON.stringify(deviceAccounts));
    }

    // Set display name in Auth profile
    await updateProfile(user, { displayName });

    // Determine role (Bootstrap admin if email has 'admin')
    const role = email.toLowerCase().includes("admin") ? "admin" : "user";

    // Create user record in Firestore
    const userData = {
      uid: user.uid,
      email: user.email,
      displayName: displayName || email.split('@')[0],
      role: role,
      premiumStatus: "free",
      winLoss: { wins: 0, losses: 0 },
      walletBalance: 0.00,
      totalReferralEarnings: 0.00,
      successfulReferrals: 0,
      purchasedSignals: [],
      createdAt: new Date().toISOString(),
      ...(referredBy && { referredBy })
    };

    try {
      await setDoc(doc(db, "users", user.uid), userData);
      
      // Credit referrer $0.20 instantly
      if (referredBy) {
        try {
          const referrerRef = doc(db, "users", referredBy);
          const referrerSnap = await getDoc(referrerRef);
          if (referrerSnap.exists()) {
            const refData = referrerSnap.data();
            await updateDoc(referrerRef, {
              walletBalance: parseFloat(((refData.walletBalance || 0) + 0.20).toFixed(2)),
              totalReferralEarnings: parseFloat(((refData.totalReferralEarnings || 0) + 0.20).toFixed(2)),
              successfulReferrals: (refData.successfulReferrals || 0) + 1
            });
            console.log(`Successfully credited referrer ${referredBy} with $0.20`);
          }
        } catch (refErr) {
          console.error("Error crediting referrer signup bonus:", refErr);
        }
      }
    } catch (fsError) {
      console.error("Firestore write failed:", fsError);
      throw new Error("Account created, but Firestore database is offline. Please make sure you have clicked 'Create Database' in your Firebase Console under 'Firestore Database'.");
    }

    // Trigger welcome email asynchronously
    sendWelcomeEmail(userData).catch(err => console.error("Error sending welcome email:", err));
    
    return { user, userData };
  } catch (error) {
    console.error("Error in signUp:", error);
    throw error;
  }
}

// Sign in function
export async function signIn(email, password) {
  try {
    const userCredential = await signInWithEmailAndPassword(auth, email, password);
    const user = userCredential.user;
    
    let docSnap = null;
    try {
      docSnap = await getUserDoc(user.uid);
    } catch (fsError) {
      console.error("Firestore read failed:", fsError);
      throw new Error("Login succeeded, but Firestore database is offline. Please verify you have created the 'Firestore Database' in your Firebase Console.");
    }
    
    return { user, userData: docSnap ? docSnap.data() : null };
  } catch (error) {
    console.error("Error in signIn:", error);
    throw error;
  }
}

// Sign out function
export async function signOutUser() {
  try {
    await signOut(auth);
  } catch (error) {
    console.error("Error in signOut:", error);
    throw error;
  }
}

// Sign in with Google function
export async function signInWithGoogle(referredBy = null) {
  const provider = new GoogleAuthProvider();
  try {
    const result = await signInWithPopup(auth, provider);
    const user = result.user;
    
    // Check if user already exists in Firestore
    let docSnap = null;
    try {
      docSnap = await getUserDoc(user.uid);
    } catch (fsError) {
      console.error("Firestore read failed:", fsError);
      throw new Error("Google Login succeeded, but Firestore database is offline. Please make sure you have clicked 'Create Database' in your Firebase Console under 'Firestore Database'.");
    }
    
    let userData = null;
    if (!docSnap) {
      // New user registration
      const deviceAccounts = JSON.parse(localStorage.getItem("device_accounts") || "[]");
      const userEmail = user.email.toLowerCase().trim();
      
      if (deviceAccounts.length >= 2 && !deviceAccounts.includes(userEmail)) {
        // Sign out user
        await signOut(auth);
        try {
          await user.delete();
        } catch (e) {
          console.warn("Could not delete user credential:", e);
        }
        throw new Error("Device Registration Limit: You can create a maximum of 2 accounts on this device.");
      }

      // Save to device accounts list
      if (!deviceAccounts.includes(userEmail)) {
        deviceAccounts.push(userEmail);
        localStorage.setItem("device_accounts", JSON.stringify(deviceAccounts));
      }

      // Determine role (Bootstrap admin if email has 'admin')
      const role = user.email.toLowerCase().includes("admin") ? "admin" : "user";
      
      userData = {
        uid: user.uid,
        email: user.email,
        displayName: user.displayName || user.email.split('@')[0],
        role: role,
        premiumStatus: "free",
        winLoss: { wins: 0, losses: 0 },
        walletBalance: 0.00,
        totalReferralEarnings: 0.00,
        successfulReferrals: 0,
        purchasedSignals: [],
        createdAt: new Date().toISOString(),
        ...(referredBy && { referredBy })
      };
      
      try {
        await setDoc(doc(db, "users", user.uid), userData);

        // Credit referrer $0.20 instantly
        if (referredBy) {
          try {
            const referrerRef = doc(db, "users", referredBy);
            const referrerSnap = await getDoc(referrerRef);
            if (referrerSnap.exists()) {
              const refData = referrerSnap.data();
              await updateDoc(referrerRef, {
                walletBalance: parseFloat(((refData.walletBalance || 0) + 0.20).toFixed(2)),
                totalReferralEarnings: parseFloat(((refData.totalReferralEarnings || 0) + 0.20).toFixed(2)),
                successfulReferrals: (refData.successfulReferrals || 0) + 1
              });
              console.log(`Successfully credited referrer ${referredBy} with $0.20`);
            }
          } catch (refErr) {
            console.error("Error crediting referrer signup bonus:", refErr);
          }
        }
      } catch (fsError) {
        console.error("Firestore write failed:", fsError);
        throw new Error("Google Login succeeded, but failed to write profile doc because Firestore is offline. Verify that your database is created in the Firebase Console.");
      }

      // Send welcome email for new Google registration
      sendWelcomeEmail(userData).catch(err => console.error("Error sending welcome email:", err));
    } else {
      userData = docSnap.data();
    }
    
    return { user, userData };
  } catch (error) {
    console.error("Error in signInWithGoogle:", error);
    throw error;
  }
}
