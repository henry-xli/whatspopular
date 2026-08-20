# what’s popular? mobile

This folder contains the native SwiftUI iOS companion to the website. It is a
single, scrollable briefing screen designed for one-handed reading:

- a compact five-question quiz sits at the top;
- a horizontal Standout rail surfaces the top entry from each board;
- all eight website leaderboards follow below on the same page;
- entries open their existing source URLs, including Spotify tracks;
- the Customize sheet persists board order, board colors, card density,
  description length, expanded-entry behavior, and light/dark/system mode.

The app is snapshot-driven. `BundleData/trends.json` and `BundleData/culture/`
are bundled into the app, so the first launch works without a content API or
remote image requests.

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
