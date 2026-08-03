# Laemthong DISPLAY Android TV

Android TV WebView app for the DISPLAY wall.

Build debug APKs:

```powershell
& "C:\Users\WINDOWS\.gradle\wrapper\dists\gradle-8.12-all\ejduaidbjup3bmmkhw3rie4zb\gradle-8.12\bin\gradle.bat" -p "D:\code\DISplay\android-tv" assembleDebug --offline
```

Build release APKs:

```powershell
& "C:\Users\WINDOWS\.gradle\wrapper\dists\gradle-8.12-all\ejduaidbjup3bmmkhw3rie4zb\gradle-8.12\bin\gradle.bat" -p "D:\code\DISplay\android-tv" assembleRelease --offline
```

Release signing:

- `release-keystore.jks` and `keystore.properties` stay local and are ignored by Git.
- Keep `release-keystore.jks`; Android will only update an installed release app when future APKs are signed with the same key.
- Use `keystore.properties.example` as the template if the signing config needs to be recreated.

Install:

- Use `app-screen1-debug.apk` on the left TV.
- Use `app-screen2-debug.apk` on the right TV.
- Use `app-screen1-release.apk` and `app-screen2-release.apk` for production installs.

Runtime stability:

- Reloads automatically every 30 minutes.
- Reloads if the page is still loading after 2 minutes.
- Reloads if the last successful page render is older than 45 minutes.
- Retries every 10 seconds when the TV is offline.

Remote keys:

- Left or 1: set this TV to screen 1.
- Right or 2: set this TV to screen 2.
- Menu/R: reload.
