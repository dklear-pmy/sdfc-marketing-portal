import { initializeApp } from "firebase/app"
import { getAuth } from "firebase/auth"

// Config values are public identifiers, not secrets; still injected via env so
// dev/prod Firebase projects can differ without a code change.
const firebaseConfig = {
  apiKey: import.meta.env.VITE_FIREBASE_API_KEY,
  authDomain: import.meta.env.VITE_FIREBASE_AUTH_DOMAIN ?? "sdfc-udp-dev.firebaseapp.com",
  projectId: import.meta.env.VITE_FIREBASE_PROJECT_ID ?? "sdfc-udp-dev",
}

export const firebaseApp = initializeApp(firebaseConfig)
export const auth = getAuth(firebaseApp)
