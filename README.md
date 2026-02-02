# 🏎️ Formula 1 Watch Party Live

A high-performance, real-time Formula 1 streaming dashboard. This project features a sleek, dark-themed user interface with live race status, weekend schedules, championship standings, and a dedicated administrative control panel powered by Firebase.

## 🌟 Key Features

* **Real-time Race Dashboard:** Dynamic live-stream switching with support for multiple sources.
* **Theater Mode:** Immersive viewing experience that hides distractions.
* **Live Status & Weather:** Real-time track conditions (Air/Track temp) and session status (Live/Offline).
* **Weekend Schedule:** Interactive timeline of sessions with countdown timers for upcoming events.
* **Live Standings:** Driver championship standings with an expandable view.
* **Maintenance Mode:** A custom "Off-season" or maintenance overlay featuring 2026 season countdowns and World Champion spotlights.
* **Full Admin Panel:** Secure login to manage stream links, update schedules, modify standings, and toggle site-wide maintenance settings instantly via Firestore.

## 🛠️ Tech Stack

* **Frontend:** AngularJS (1.8.2) for two-way data binding and state management.
* **Backend/Database:** Firebase Firestore for real-time data synchronization.
* **Authentication:** Firebase Auth for securing the Admin Control Center.
* **Styling:** Modern CSS3 with Custom Variables, Glassmorphism, and Responsive Design.
* **Icons & Fonts:** FontAwesome and Google Fonts (Titillium Web).

## 🚀 Getting Started

### 1. Prerequisites
You will need a Firebase project. Create one at the [Firebase Console](https://console.firebase.google.com/).

### 2. Database Setup
Create a collection named `app_data` with two primary documents:
* `live_config`: Stores race data, stream links, schedule, and standings.
* `maintenance_config`: Stores maintenance status, winner profiles, and countdown dates.

### 3. Configuration
Update the `firebaseConfig` object in both `index.html` and `admin.html` with your project credentials:

```javascript
const firebaseConfig = {
    apiKey: "YOUR_API_KEY",
    authDomain: "YOUR_PROJECT.firebaseapp.com",
    projectId: "YOUR_PROJECT_ID",
    storageBucket: "YOUR_PROJECT.firebasestorage.app",
    messagingSenderId: "YOUR_ID",
    appId: "YOUR_APP_ID"
};
4. Deployment
The project is client-side only and can be hosted for free on:
GitHub Pages
Vercel
Firebase Hosting

📸 UI Components
User Dashboard
The main interface features a responsive video player followed by an "Engineered with Gemini" footer. It uses a custom mouse-tracking radial gradient for a high-tech "glow" effect.

Admin Control Center
A secure, tabbed interface that allows the admin to:
Stream Control: Change live sources and update Grand Prix details.
Session Management: Add/Remove sessions with ISO-formatted timers.
Standings: Update points and driver images on the fly.

⚖️ Disclaimer
This website does not host or share any video content. All video streams are embedded from external websites that are freely available online.
