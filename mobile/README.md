# what’s popular? mobile

This folder contains the native SwiftUI iOS companion to the website. It is a
single, scrollable briefing screen designed for one-handed reading:

- a compact five-question quiz sits at the top;
- a horizontal Standout rail surfaces the top entry from each board;
- all eight website leaderboards follow below on the same page;
- entries open their existing source URLs, including Spotify tracks;
- the Customize sheet persists board order, board colors, card density,
  description length, expanded-entry behavior, alert selections, and
  light/dark/system mode.

The app is snapshot-driven. `BundleData/trends.json` and `BundleData/culture/`
are bundled into the app, so the first launch works without a content API or
remote image requests. When connected, the app checks the published `/api/brief`
snapshot at most every 12 hours and keeps a local copy for offline launches.
Users can enable local alerts for selected leaderboard updates and for tracked
entries that are newly added or removed. iOS background refresh is best effort;
the system controls when it runs, so alerts are not a guaranteed real-time push
channel.

## Run in Xcode

The `.app` inside `DerivedData` is an iOS Simulator bundle, not a macOS
application. Do not double-click it in Finder; macOS will show “cannot be
opened because of a problem.” Open the project in Xcode, select an iOS
simulator or a connected iPhone, and press Run.

1. Open `WhatspopularMobile.xcodeproj`.
2. Choose the `WhatspopularMobile` scheme and an iOS 17 or newer simulator.
3. Set your Apple Development Team under the app target’s Signing settings.
4. Press Run. Archive the same scheme for TestFlight or App Store Connect.

The command-line simulator build used for local verification is:

```bash
xcodebuild \
  -project mobile/WhatspopularMobile.xcodeproj \
  -scheme WhatspopularMobile \
  -sdk iphonesimulator \
  -configuration Debug \
  -derivedDataPath mobile/DerivedData \
  CODE_SIGNING_ALLOWED=NO \
  build
```

## Refreshing bundled content

After the website ingestion produces a new snapshot, run this from the
repository root before making a mobile release:

```bash
./mobile/sync-content.sh
```

Then build and archive again in Xcode. The script intentionally copies the
validated website snapshot and local WebP art; it does not fetch new content or
change the website’s source data.
