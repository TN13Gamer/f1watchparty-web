const { app, BrowserWindow } = require('electron');
const path = require('path');

function createWindow() {
  const win = new BrowserWindow({
    width: 1200,
    height: 800,
    minWidth: 900,
    minHeight: 650,
    title: "WatchF1.Live Desktop",
    backgroundColor: "#050505",
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false,
      webSecurity: false, // Disabling web security allows loading third-party embeds (Twitch, pushembdz) and bypassing CORS for APIs.
      preload: path.join(__dirname, 'preload.js'),
      nodeIntegrationInSubFrames: true
    }

  });

  win.loadFile(path.join(__dirname, 'index.html'));

  // Allow iframe embedded players to open popup ad windows normally so the user can close them to trigger video playback.
  win.webContents.setWindowOpenHandler(({ url }) => {
    console.log('Allowing popup window to open for URL:', url);
    return { action: 'allow' };
  });

  // Hide default menu bar for a premium, native feel
  win.setMenuBarVisibility(false);
}

app.whenReady().then(() => {
  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });

});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});
