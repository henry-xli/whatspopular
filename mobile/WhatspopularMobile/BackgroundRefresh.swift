import BackgroundTasks

enum BackgroundRefreshScheduler {
    static let identifier = "com.whatspopular.mobile.refresh"
    private static let refreshInterval: TimeInterval = 12 * 60 * 60

    static func register() {
        BGTaskScheduler.shared.register(forTaskWithIdentifier: identifier, using: nil) { task in
            guard let refreshTask = task as? BGAppRefreshTask else {
                task.setTaskCompleted(success: false)
                return
            }
            handle(refreshTask)
        }
    }

    static func schedule() {
        let request = BGAppRefreshTaskRequest(identifier: identifier)
        request.earliestBeginDate = Date(timeIntervalSinceNow: refreshInterval)
        try? BGTaskScheduler.shared.submit(request)
    }

    private static func handle(_ task: BGAppRefreshTask) {
        schedule()
        let operation = Task { @MainActor in
            let store = BriefStore()
            let alerts = AlertPreferences()
            if let cachedBrief = store.brief {
                alerts.seed(brief: cachedBrief)
            }

            await store.refreshIfNeeded(force: true)
            if let refreshedBrief = store.brief {
                alerts.process(brief: refreshedBrief)
            }
            task.setTaskCompleted(success: store.errorMessage == nil)
        }
        task.expirationHandler = {
            operation.cancel()
        }
    }
}
