🏎️ WatchF1 Live — Real-Time Formula 1 Streaming Dashboard

WatchF1 Live is a real-time Formula 1 streaming dashboard built with AngularJS and Firebase, featuring a cinematic live-race viewer, automatic session timers, standings, weather data, and a powerful admin control panel for live updates and maintenance mode.

🌐 Live Site: https://watchf1.live/

✨ Features
🎥 Live Streaming Viewer

Multiple stream sources with instant switching

Theater Mode for distraction-free viewing

Responsive video player (desktop & mobile)

External embeds only (no hosting of video content)

⏱️ Smart Session Timing

Automatic LIVE / UPCOMING / ENDED session detection

Real-time countdown timers

Weekend schedule with visual status indicators

🌦️ Race Context

Air & track temperature display

Dynamic weather icons

Race metadata (round, circuit, laps, date)

🏆 Championship Standings

Live driver standings

Expandable list (Top 3 → Full Grid)

Driver photos, teams, points

Auto-sorted via admin panel

🔧 Maintenance Mode

Full-screen maintenance overlay

Custom title, message, theme color

Countdown timer to next season/event

Optional “World Champion” showcase

🧠 Tech Stack

Frontend

AngularJS 1.8

Vanilla HTML / CSS

Google Fonts (Titillium Web)

Backend / Realtime Data

Firebase Firestore (live sync)

Firebase Authentication (admin login)

Firebase Hosting (optional)

🗂️ Project Structure
/
├── index.html          # Public live streaming site
├── admin.html          # Admin control panel
└── README.md

🔥 Firebase Data Model

All app data is stored in Firestore under:

app_data/
├── live_config
│   ├── raceData
│   ├── streamLinks
│   ├── schedule
│   ├── standings
│   ├── weather
│   └── nextRace
│
└── maintenance_config
    ├── isActive
    ├── msgTitle
    ├── msgSub
    ├── timerTitle
    ├── targetDate
    ├── themeColor
    ├── showWinner
    ├── winnerName
    ├── winnerTeam
    ├── winnerImage


All updates are live — no refresh required.

🛠️ Admin Panel

The admin dashboard (admin.html) allows authorized users to:

🎛️ Stream Control

Add / remove stream sources

Edit race metadata

Control weather display

Manage weekend schedule

Reorder sessions & drivers

🏁 Standings Editor

Add drivers

Upload images

Sort by points

Reorder manually

🚧 Maintenance Mode

Enable / disable site lock

Customize maintenance messaging

Set season countdown

Highlight championship winner

🔐 Authentication

Firebase Email/Password login

Protected admin access

Live save status & toast notifications

⚠️ Disclaimer

This website does not create, host, or distribute any video content.
All streams are embedded from third-party sources that are publicly available online.

🚀 Setup Instructions

Clone the repository

Create a Firebase project

Enable:

Firestore

Email/Password Authentication

Replace Firebase config in:

index.html

admin.html

Deploy or open locally

git clone https://github.com/yourusername/watchf1-live

🧪 Local Development

This project does not require a build step.

Simply open:

index.html for the public site

admin.html for the admin panel

⚠️ Firebase Auth will not work via file:// URLs — use a local server.

📸 Screenshots (Optional)

Add screenshots here if you want:

/screenshots/home.png
/screenshots/admin.png

🏁 Credits

UI & Engineering: WatchF1

Backend: Firebase

Fonts: Google Fonts

Icons: Font Awesome
