import { initializeApp } from "https://www.gstatic.com/firebasejs/12.15.0/firebase-app.js";
import { getAuth } from "https://www.gstatic.com/firebasejs/12.15.0/firebase-auth.js";
import { getFirestore } from "https://www.gstatic.com/firebasejs/12.15.0/firebase-firestore.js";
import { getStorage } from "https://www.gstatic.com/firebasejs/12.15.0/firebase-storage.js";

const firebaseConfig = {
  apiKey: "AIzaSyCaoR5TAdV5ZfAdbuCpzJ8GmyOdrXhvhrY",
  authDomain: "lkaweesha.firebaseapp.com",
  projectId: "lkaweesha",
  storageBucket: "lkaweesha.firebasestorage.app",
  messagingSenderId: "973163882066",
  appId: "1:973163882066:web:07e64a89760c5c2037a18b",
  measurementId: "G-H814TBXDT8"
};

// Initialize Firebase
const app = initializeApp(firebaseConfig);
const auth = getAuth(app);
const db = getFirestore(app);

const storage = getStorage(app);
export { auth, db, storage };
