const admin = require('firebase-admin');
const serviceAccount = process.env.FIREBASE_SERVICE_ACCOUNT ? JSON.parse(Buffer.from(process.env.FIREBASE_SERVICE_ACCOUNT, 'base64').toString()) : null;

if (!serviceAccount) {
  console.log('? FIREBASE_SERVICE_ACCOUNT not set. Using interactive setup...');
  console.log('?? To set admin status, please run in your browser console:');
  console.log('   window.setupAdmin("bradster8@yahoo.com")');
  process.exit(0);
}

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
  projectId: 'pmdek-c2c21',
});

const db = admin.firestore();

(async () => {
  try {
    const usersRef = db.collection('users');
    const snapshot = await usersRef.where('email', '==', 'bradster8@yahoo.com').limit(1).get();
    
    if (snapshot.empty) {
      console.log('? User not found. Make sure you sign in first.');
      process.exit(1);
    }

    const userDoc = snapshot.docs[0];
    await userDoc.ref.update({ isAdmin: true });
    
    console.log(`? Admin status granted to ${userDoc.data().email} (UID: ${userDoc.id})`);
    process.exit(0);
  } catch (error) {
    console.error('? Error:', error.message);
    process.exit(1);
  }
})();
