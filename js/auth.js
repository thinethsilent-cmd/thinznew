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
import { doc, setDoc, getDoc } from "https://www.gstatic.com/firebasejs/12.15.0/firebase-firestore.js";

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
    const userCredential = await createUserWithEmailAndPassword(auth, email, password);
    const user = userCredential.user;

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
      createdAt: new Date().toISOString(),
      ...(referredBy && { referredBy })
    };

    try {
      await setDoc(doc(db, "users", user.uid), userData);
    } catch (fsError) {
      console.error("Firestore write failed:", fsError);
      throw new Error("Account created, but Firestore database is offline. Please make sure you have clicked 'Create Database' in your Firebase Console under 'Firestore Database'.");
    }
    
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
      // Determine role (Bootstrap admin if email has 'admin')
      const role = user.email.toLowerCase().includes("admin") ? "admin" : "user";
      
      userData = {
        uid: user.uid,
        email: user.email,
        displayName: user.displayName || user.email.split('@')[0],
        role: role,
        premiumStatus: "free",
        winLoss: { wins: 0, losses: 0 },
        createdAt: new Date().toISOString(),
        ...(referredBy && { referredBy })
      };
      
      try {
        await setDoc(doc(db, "users", user.uid), userData);
      } catch (fsError) {
        console.error("Firestore write failed:", fsError);
        throw new Error("Google Login succeeded, but failed to write profile doc because Firestore is offline. Verify that your database is created in the Firebase Console.");
      }
    } else {
      userData = docSnap.data();
    }
    
    return { user, userData };
  } catch (error) {
    console.error("Error in signInWithGoogle:", error);
    throw error;
  }
}
