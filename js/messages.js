// ══════════════════════════════════════════════════════════════════════════════
//  MESSAGES SYSTEM  –  Admin → User in-app messaging + wallet gifting
//  Firestore collection: messages/{messageId}
//  Document shape: {
//    userId: string | "all",       // specific uid or "all" for broadcast
//    userEmail: string,
//    displayName: string,
//    from: "admin",
//    subject: string,
//    body: string,
//    giftAmount: number,           // 0 if no gift
//    giftCredited: boolean,        // true once wallet is credited
//    read: boolean,
//    createdAt: string (ISO)
//  }
// ══════════════════════════════════════════════════════════════════════════════

import { db } from "./firebase-config.js";
import {
  collection,
  addDoc,
  getDocs,
  getDoc,
  updateDoc,
  onSnapshot,
  query,
  where,
  orderBy,
  doc,
  limit
} from "https://www.gstatic.com/firebasejs/12.15.0/firebase-firestore.js";
import { sendGiftEmail } from "./email.js";

// ── Send message (admin only) ─────────────────────────────────────────────────
/**
 * Send a message to one user or broadcast to all.
 * @param {string} targetUserId  - uid of specific user OR "all" for broadcast
 * @param {string} targetEmail   - email (used for single-user send)
 * @param {string} targetName    - display name (used for single-user send)
 * @param {string} subject       - message subject
 * @param {string} body          - message body text
 * @param {number} giftAmount    - optional USD amount to gift (0 = no gift)
 * @param {Array}  allUsers      - required when targetUserId === "all"
 */
export async function sendAdminMessage({ targetUserId, targetEmail, targetName, subject, body, giftAmount = 0, allUsers = [] }) {
  const isBroadcast = targetUserId === "all";
  const usersToSend = isBroadcast ? allUsers.filter(u => u.role !== "admin") : [{ uid: targetUserId, email: targetEmail, displayName: targetName }];

  const results = [];
  for (const user of usersToSend) {
    try {
      // Write message doc to Firestore
      const msgRef = await addDoc(collection(db, "messages"), {
        userId:       user.uid,
        userEmail:    user.email || "",
        displayName:  user.displayName || "",
        from:         "admin",
        subject,
        body,
        giftAmount:   parseFloat(giftAmount) || 0,
        giftCredited: false,
        read:         false,
        broadcast:    isBroadcast,
        createdAt:    new Date().toISOString()
      });

      // Credit gift wallet balance immediately if non-zero
      if (giftAmount > 0) {
        try {
          const userRef  = doc(db, "users", user.uid);
          const userSnap = await getDoc(userRef);
          if (userSnap.exists()) {
            const data       = userSnap.data();
            const newBalance = parseFloat(((data.walletBalance || 0) + parseFloat(giftAmount)).toFixed(2));
            await updateDoc(userRef, { walletBalance: newBalance });
            await updateDoc(doc(db, "messages", msgRef.id), { giftCredited: true });
          }
        } catch (walletErr) {
          console.error(`[Messages] Failed to credit wallet for ${user.uid}:`, walletErr);
        }
      }

      // Send email notification
      try {
        await sendGiftEmail(user.email, user.displayName, subject, body, giftAmount);
      } catch (mailErr) {
        console.warn(`[Messages] Email failed for ${user.email}:`, mailErr);
      }

      results.push({ uid: user.uid, success: true });
    } catch (err) {
      console.error(`[Messages] Failed to send to ${user.uid}:`, err);
      results.push({ uid: user.uid, success: false, error: err.message });
    }
  }

  const sent    = results.filter(r => r.success).length;
  const failed  = results.filter(r => !r.success).length;
  console.log(`[Messages] Sent: ${sent}, Failed: ${failed}`);
  return { sent, failed };
}

// ── Subscribe to a user's inbox (real-time) ───────────────────────────────────
export function subscribeToUserMessages(userId, callback) {
  const q = query(
    collection(db, "messages"),
    where("userId", "in", [userId, "all"]),
    orderBy("createdAt", "desc"),
    limit(50)
  );
  return onSnapshot(q, snapshot => {
    const msgs = [];
    snapshot.forEach(d => msgs.push({ id: d.id, ...d.data() }));
    callback(msgs);
  }, err => {
    console.error("[Messages] Inbox subscription error:", err);
  });
}

// ── Get all sent messages (admin view) ────────────────────────────────────────
export async function getAdminSentMessages(limitCount = 30) {
  const q = query(
    collection(db, "messages"),
    orderBy("createdAt", "desc"),
    limit(limitCount)
  );
  const snap = await getDocs(q);
  const msgs = [];
  snap.forEach(d => msgs.push({ id: d.id, ...d.data() }));
  return msgs;
}

// ── Mark message as read ──────────────────────────────────────────────────────
export async function markMessageRead(messageId) {
  try {
    await updateDoc(doc(db, "messages", messageId), { read: true });
  } catch (err) {
    console.error("[Messages] markMessageRead error:", err);
  }
}

// ── Count unread messages for a user ─────────────────────────────────────────
export async function getUnreadCount(userId) {
  try {
    const q = query(
      collection(db, "messages"),
      where("userId", "in", [userId, "all"]),
      where("read", "==", false)
    );
    const snap = await getDocs(q);
    return snap.size;
  } catch {
    return 0;
  }
}
