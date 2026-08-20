import SwiftUI
import UserNotifications

@main
struct WhatspopularMobileApp: App {
    init() {
        UNUserNotificationCenter.current().delegate = MobileNotificationDelegate.shared
        BackgroundRefreshScheduler.register()
    }

    var body: some Scene {
        WindowGroup {
            ContentView()
        }
    }
}
