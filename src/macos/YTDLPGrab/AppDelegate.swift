import AppKit
import Foundation
import ServiceManagement

final class AppDelegate: NSObject, NSApplicationDelegate {
    private let statusItem = NSStatusBar.system.statusItem(withLength: NSStatusItem.variableLength)
    private let qualityDefaultsKey = "SelectedQuality"
    private let modeDefaultsKey = "SelectedDownloadMode"
    private let qualityOptions = [
        QualityOption(id: "best", title: "Best Available"),
        QualityOption(id: "2160", title: "4K / 2160p"),
        QualityOption(id: "1440", title: "1440p"),
        QualityOption(id: "1080", title: "1080p"),
        QualityOption(id: "720", title: "720p"),
        QualityOption(id: "480", title: "480p"),
        QualityOption(id: "360", title: "360p")
    ]
    private let modeOptions = [
        DownloadModeOption(id: "youtube", title: "YouTube Video"),
        DownloadModeOption(id: "audio", title: "Audio")
    ]
    private var serverProcess: Process?
    private var outputHandle: FileHandle?
    private var errorHandle: FileHandle?
    private var healthTimer: Timer?
    private var updateTimer: Timer?
    private var isHealthy = false
    private var healthSummary = "Checking..."
    private var toolSummary = ""
    private var lastError: String?
    private var restartAfterStop = false
    private var isCheckingUpdate = false
    private var isInstallingUpdate = false
    private var updateStatusLine: String?
    private var pendingUpdate: UpdateCheck?

    private var helperBaseURL: URL {
        URL(string: "http://127.0.0.1:17427")!
    }

    private var helperURL: URL {
        URL(string: "http://127.0.0.1:17427/health")!
    }

    private var resourcesURL: URL {
        Bundle.main.resourceURL ?? Bundle.main.bundleURL
    }

    private var serverScriptURL: URL {
        resourcesURL.appendingPathComponent("server/index.js")
    }

    private var bundledBinURL: URL {
        resourcesURL.appendingPathComponent("bin", isDirectory: true)
    }

    private var logsDirectoryURL: URL {
        FileManager.default.homeDirectoryForCurrentUser
            .appendingPathComponent("Library/Logs/ytdlpgrab", isDirectory: true)
    }

    private var desktopURL: URL {
        FileManager.default.urls(for: .desktopDirectory, in: .userDomainMask).first
            ?? FileManager.default.homeDirectoryForCurrentUser
                .appendingPathComponent("Desktop", isDirectory: true)
    }

    private var selectedQualityId: String {
        get {
            let stored = UserDefaults.standard.string(forKey: qualityDefaultsKey) ?? "best"
            return qualityOptions.contains { $0.id == stored } ? stored : "best"
        }
        set {
            guard qualityOptions.contains(where: { $0.id == newValue }) else { return }
            UserDefaults.standard.set(newValue, forKey: qualityDefaultsKey)
        }
    }

    private var selectedQualityTitle: String {
        qualityOptions.first { $0.id == selectedQualityId }?.title ?? "Best Available"
    }

    private var selectedModeId: String {
        get {
            let stored = UserDefaults.standard.string(forKey: modeDefaultsKey) ?? "youtube"
            return modeOptions.contains { $0.id == stored } ? stored : "youtube"
        }
        set {
            guard modeOptions.contains(where: { $0.id == newValue }) else { return }
            UserDefaults.standard.set(newValue, forKey: modeDefaultsKey)
        }
    }

    private var selectedModeTitle: String {
        modeOptions.first { $0.id == selectedModeId }?.title ?? "YouTube Video"
    }

    func applicationDidFinishLaunching(_ notification: Notification) {
        appendDiagnostic("applicationDidFinishLaunching")
        NSApp.setActivationPolicy(.accessory)
        statusItem.button?.title = "YT"
        statusItem.button?.toolTip = "YTDLPGrab"
        rebuildMenu()
        startServer()
        refreshHealth()
        healthTimer = Timer.scheduledTimer(withTimeInterval: 3.0, repeats: true) { [weak self] _ in
            self?.refreshHealth()
        }
        perform(#selector(autoCheckForUpdates), with: nil, afterDelay: 20.0)
        updateTimer = Timer.scheduledTimer(withTimeInterval: 6 * 60 * 60.0, repeats: true) { [weak self] _ in
            self?.checkForUpdates(showResult: false)
        }
    }

    func applicationWillTerminate(_ notification: Notification) {
        healthTimer?.invalidate()
        updateTimer?.invalidate()
        stopServer()
    }

    @objc private func startServer() {
        appendDiagnostic("startServer requested")
        guard serverProcess == nil else {
            refreshHealth()
            return
        }

        guard FileManager.default.fileExists(atPath: serverScriptURL.path) else {
            lastError = "Missing bundled server script."
            appendDiagnostic("missing server script at \(serverScriptURL.path)")
            isHealthy = false
            rebuildMenu()
            return
        }

        guard let scriptRunner = resolveJavaScriptExecutable() else {
            lastError = "JavaScript runtime was not found."
            appendDiagnostic("JavaScript runtime missing")
            isHealthy = false
            rebuildMenu()
            return
        }

        do {
            try FileManager.default.createDirectory(
                at: logsDirectoryURL,
                withIntermediateDirectories: true
            )
            let outputURL = logsDirectoryURL.appendingPathComponent("helper.log")
            let errorURL = logsDirectoryURL.appendingPathComponent("helper.error.log")
            ensureFileExists(outputURL)
            ensureFileExists(errorURL)

            outputHandle = try FileHandle(forWritingTo: outputURL)
            errorHandle = try FileHandle(forWritingTo: errorURL)
            outputHandle?.seekToEndOfFile()
            errorHandle?.seekToEndOfFile()

            let process = Process()
            process.executableURL = URL(fileURLWithPath: scriptRunner)
            process.arguments = [serverScriptURL.path]
            process.currentDirectoryURL = resourcesURL
            var env = ProcessInfo.processInfo.environment
            env["PATH"] = "\(bundledBinURL.path):/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"
            env["PYTHONPATH"] = resourcesURL.appendingPathComponent("python").path
            env["YTDLPGRAB_HOST"] = "127.0.0.1"
            env["YTDLPGRAB_PORT"] = "17427"
            env["YTDLPGRAB_QUALITY"] = selectedQualityId
            env["YTDLPGRAB_MODE"] = selectedModeId
            process.environment = env
            process.standardOutput = outputHandle
            process.standardError = errorHandle
            process.terminationHandler = { [weak self] process in
                DispatchQueue.main.async {
                    guard let self else { return }
                    if self.serverProcess === process {
                        self.serverProcess = nil
                        self.closeLogHandles()
                        self.lastError = process.terminationStatus == 0
                            ? nil
                            : "Helper exited with code \(process.terminationStatus)."
                        let shouldRestart = self.restartAfterStop
                        self.restartAfterStop = false
                        if shouldRestart {
                            self.startServer()
                        } else {
                            self.refreshHealth()
                        }
                    }
                }
            }

            try process.run()
            serverProcess = process
            appendDiagnostic("server process launched using \(scriptRunner)")
            lastError = nil
            healthSummary = "Starting..."
            rebuildMenu()
        } catch {
            serverProcess = nil
            lastError = error.localizedDescription
            appendDiagnostic("failed to launch server: \(error.localizedDescription)")
            closeLogHandles()
            rebuildMenu()
        }
    }

    @objc private func stopServer() {
        requestServerStop(restart: false)
    }

    @objc private func toggleStartAtLogin() {
        guard #available(macOS 13.0, *) else {
            lastError = "Start at Login needs macOS 13 or newer."
            rebuildMenu()
            return
        }

        do {
            if SMAppService.mainApp.status == .enabled {
                try SMAppService.mainApp.unregister()
            } else {
                try SMAppService.mainApp.register()
            }
            lastError = nil
        } catch {
            lastError = error.localizedDescription
        }

        rebuildMenu()
    }

    @objc private func selectQuality(_ sender: NSMenuItem) {
        guard
            let qualityId = sender.representedObject as? String,
            qualityOptions.contains(where: { $0.id == qualityId })
        else {
            return
        }

        selectedQualityId = qualityId
        appendDiagnostic("quality changed to \(qualityId)")

        restartServerIfNeeded()
    }

    @objc private func selectMode(_ sender: NSMenuItem) {
        guard
            let modeId = sender.representedObject as? String,
            modeOptions.contains(where: { $0.id == modeId })
        else {
            return
        }

        selectedModeId = modeId
        appendDiagnostic("mode changed to \(modeId)")

        restartServerIfNeeded()
    }

    @objc private func openDesktop() {
        NSWorkspace.shared.open(desktopURL)
    }

    @objc private func openLogs() {
        do {
            try FileManager.default.createDirectory(
                at: logsDirectoryURL,
                withIntermediateDirectories: true
            )
        } catch {
            lastError = error.localizedDescription
            rebuildMenu()
        }
        NSWorkspace.shared.open(logsDirectoryURL)
    }

    @objc private func openExtensionFolder() {
        let extensionURL = resourcesURL.appendingPathComponent("extension", isDirectory: true)
        if !NSWorkspace.shared.open(extensionURL) {
            appendDiagnostic("failed to open extension folder at \(extensionURL.path)")
        }
    }

    @objc private func installUpdateAction() {
        installPendingUpdate()
    }

    @objc private func openReleaseNotes(_ sender: NSMenuItem) {
        guard
            let releaseUrl = sender.representedObject as? String,
            let url = URL(string: releaseUrl)
        else {
            return
        }
        NSWorkspace.shared.open(url)
    }

    @objc private func quitApp() {
        stopServer()
        NSApp.terminate(nil)
    }

    @objc private func autoCheckForUpdates() {
        checkForUpdates(showResult: false)
    }

    @objc private func checkForUpdatesManually() {
        checkForUpdates(showResult: true)
    }

    private func checkForUpdates(showResult: Bool) {
        guard !isInstallingUpdate else { return }

        isCheckingUpdate = true
        updateStatusLine = "Checking for updates..."
        rebuildMenu()

        var request = URLRequest(url: helperBaseURL.appendingPathComponent("update/check"))
        request.timeoutInterval = 20

        URLSession.shared.dataTask(with: request) { [weak self] data, _, error in
            DispatchQueue.main.async {
                guard let self else { return }
                self.isCheckingUpdate = false
                self.updateStatusLine = nil

                if let error {
                    self.pendingUpdate = nil
                    self.updateStatusLine = "Update check failed."
                    self.appendDiagnostic("update check failed: \(error.localizedDescription)")
                    self.rebuildMenu()
                    if showResult {
                        self.presentAlert(
                            title: "Update Check Failed",
                            message: "Could not reach the update service.\n\(error.localizedDescription)"
                        )
                    }
                    return
                }

                guard
                    let data,
                    let check = try? JSONDecoder().decode(UpdateCheck.self, from: data),
                    check.ok
                else {
                    self.updateStatusLine = "Update check unavailable."
                    self.rebuildMenu()
                    if showResult {
                        self.presentAlert(
                            title: "Update Check Unavailable",
                            message: "The helper could not fetch release information. Try again later."
                        )
                    }
                    return
                }

                if check.updateAvailable == true, let latest = check.latest {
                    self.pendingUpdate = check
                    self.updateStatusLine = "Version v\(latest) is available."
                    self.rebuildMenu()
                    if showResult {
                        self.offerPendingInstall()
                    }
                } else {
                    self.pendingUpdate = nil
                    let current = check.current ?? Bundle.main.infoDictionary?["CFBundleShortVersionString"] as? String ?? ""
                    self.updateStatusLine = "Up to date (v\(current))."
                    self.rebuildMenu()
                    if showResult {
                        self.presentAlert(
                            title: "You're Up to Date",
                            message: "YTDLPGrab v\(current) is the latest version."
                        )
                    }
                }
            }
        }.resume()
    }

    private func offerPendingInstall() {
        guard let update = pendingUpdate, let latest = update.latest else { return }

        let alert = NSAlert()
        alert.messageText = "Update Available"
        alert.informativeText = "YTDLPGrab v\(latest) is available. You are running v\(update.current ?? "?").\n\nInstall it now? The app will download the DMG, replace itself, and relaunch."
        alert.addButton(withTitle: "Install and Relaunch")
        alert.addButton(withTitle: "Later")
        alert.alertStyle = .informational

        if alert.runModal() == .alertFirstButtonReturn {
            installPendingUpdate()
        }
    }

    private func installPendingUpdate() {
        guard
            !isInstallingUpdate,
            let dmgURLString = pendingUpdate?.assets?.dmg,
            let dmgURL = URL(string: dmgURLString)
        else {
            if let releaseUrl = pendingUpdate?.releaseUrl, let url = URL(string: releaseUrl) {
                NSWorkspace.shared.open(url)
            }
            return
        }

        isInstallingUpdate = true
        updateStatusLine = "Downloading update..."
        rebuildMenu()
        appendDiagnostic("downloading update from \(dmgURLString)")

        let task = URLSession.shared.downloadTask(with: dmgURL) { [weak self] location, response, error in
            DispatchQueue.main.async {
                guard let self else { return }

                guard let location, error == nil,
                      let http = response as? HTTPURLResponse, http.statusCode == 200
                else {
                    self.isInstallingUpdate = false
                    self.updateStatusLine = "Update download failed."
                    self.rebuildMenu()
                    self.appendDiagnostic("update download failed: \(error?.localizedDescription ?? "HTTP error")")
                    return
                }

                let destination = FileManager.default.temporaryDirectory
                    .appendingPathComponent("YTDLPGrab-update-\(UUID().uuidString).dmg")
                do {
                    try? FileManager.default.removeItem(at: destination)
                    try FileManager.default.moveItem(at: location, to: destination)
                } catch {
                    self.isInstallingUpdate = false
                    self.updateStatusLine = "Update download failed."
                    self.rebuildMenu()
                    self.appendDiagnostic("failed to stage update: \(error.localizedDescription)")
                    return
                }

                self.updateStatusLine = "Installing update..."
                self.rebuildMenu()

                DispatchQueue.global(qos: .userInitiated).async {
                    self.applyUpdate(dmgPath: destination.path)
                }
            }
        }
        task.resume()
    }

    private func applyUpdate(dmgPath: String) {
        let fileManager = FileManager.default

        func fail(_ message: String, mountPoint: String? = nil) {
            if let mountPoint {
                _ = runTool("/usr/bin/hdiutil", ["detach", "-quiet", "-force", mountPoint])
            }
            appendDiagnostic(message)
            DispatchQueue.main.async {
                self.isInstallingUpdate = false
                self.updateStatusLine = "Update install failed."
                self.rebuildMenu()
                self.presentAlert(title: "Update Failed", message: message)
            }
        }

        guard
            let attachOutput = runTool("/usr/bin/hdiutil", [
                "attach", "-nobrowse", "-readonly", dmgPath
            ]),
            let mountPoint = findMountPoint(in: attachOutput)
        else {
            fail("Could not mount the update disk image.")
            return
        }

        let sourceApp = URL(fileURLWithPath: mountPoint)
            .appendingPathComponent("YTDLPGrab.app", isDirectory: true)
        guard fileManager.fileExists(atPath: sourceApp.path) else {
            fail("The downloaded image did not contain YTDLPGrab.app.", mountPoint: mountPoint)
            return
        }

        let currentBundle = Bundle.main.bundleURL
        let destinationApp = currentBundle.deletingLastPathComponent()
            .appendingPathComponent("YTDLPGrab.app", isDirectory: true)

        do {
            if fileManager.fileExists(atPath: destinationApp.path) {
                try fileManager.removeItem(at: destinationApp)
            }
            try fileManager.copyItem(at: sourceApp, to: destinationApp)
        } catch {
            fail("Could not replace the app bundle.\n\(error.localizedDescription)", mountPoint: mountPoint)
            return
        }

        _ = runTool("/usr/bin/hdiutil", ["detach", "-quiet", mountPoint])
        try? fileManager.removeItem(atPath: dmgPath)
        appendDiagnostic("installed update at \(destinationApp.path); relaunching")

        let relaunch = Process()
        relaunch.executableURL = URL(fileURLWithPath: "/bin/sh")
        relaunch.arguments = [
            "-c",
            "sleep 2 && open \"\(destinationApp.path)\""
        ]
        try? relaunch.run()

        DispatchQueue.main.async {
            NSApp.terminate(nil)
        }
    }

    private func runTool(_ launchPath: String, _ arguments: [String]) -> String? {
        let process = Process()
        process.executableURL = URL(fileURLWithPath: launchPath)
        process.arguments = arguments

        let pipe = Pipe()
        process.standardOutput = pipe
        process.standardError = Pipe()

        do {
            try process.run()
            let data = pipe.fileHandleForReading.readDataToEndOfFile()
            process.waitUntilExit()
            guard process.terminationStatus == 0 else {
                return nil
            }
            return String(data: data, encoding: .utf8)
        } catch {
            return nil
        }
    }

    private func findMountPoint(in hdiutilOutput: String) -> String? {
        let lines = hdiutilOutput.split(separator: "\n").map(String.init)
        guard let lastNonEmpty = lines.last(where: { !$0.trimmingCharacters(in: .whitespaces).isEmpty }) else {
            return nil
        }

        let columns = lastNonEmpty.components(separatedBy: "\t")
        guard let candidate = columns.last?.trimmingCharacters(in: .whitespaces), candidate.hasPrefix("/Volumes/") else {
            return nil
        }

        return candidate
    }

    private func presentAlert(title: String, message: String) {
        let alert = NSAlert()
        alert.messageText = title
        alert.informativeText = message
        alert.alertStyle = .informational
        alert.runModal()
    }

    private func refreshHealth() {
        var request = URLRequest(url: helperURL)
        request.timeoutInterval = 1.5

        URLSession.shared.dataTask(with: request) { [weak self] data, _, error in
            DispatchQueue.main.async {
                guard let self else { return }

                if let error {
                    self.isHealthy = false
                    self.healthSummary = self.serverProcess == nil ? "Stopped" : "Starting..."
                    self.toolSummary = ""
                    if self.serverProcess == nil {
                        self.lastError = nil
                    } else {
                        self.lastError = error.localizedDescription
                    }
                    self.rebuildMenu()
                    return
                }

                guard
                    let data,
                    let health = try? JSONDecoder().decode(Health.self, from: data),
                    health.ok
                else {
                    self.isHealthy = false
                    self.healthSummary = "Not ready"
                    self.toolSummary = ""
                    self.rebuildMenu()
                    return
                }

                self.isHealthy = true
                let saves = health.activeSaves ?? 0
                let jobs = health.activeJobs ?? 0
                if saves > 0 || jobs > 0 {
                    self.healthSummary = "Working..."
                } else {
                    self.healthSummary = "Ready"
                }
                self.toolSummary = [
                    health.tools?.ytDlp.available == true
                        ? "yt-dlp \(health.tools?.ytDlp.version ?? "")"
                        : "yt-dlp missing",
                    health.tools?.ffmpeg.available == true
                        ? "ffmpeg \(health.tools?.ffmpeg.version ?? "")"
                        : "ffmpeg missing"
                ].joined(separator: " | ")
                self.lastError = nil
                self.rebuildMenu()
            }
        }.resume()
    }

    private func rebuildMenu() {
        statusItem.button?.title = isHealthy ? "YT" : "YT!"

        let menu = NSMenu()

        let title = NSMenuItem(title: "YTDLPGrab", action: nil, keyEquivalent: "")
        title.isEnabled = false
        menu.addItem(title)

        let status = NSMenuItem(title: "Server: \(healthSummary)", action: nil, keyEquivalent: "")
        status.isEnabled = false
        menu.addItem(status)

        if !toolSummary.isEmpty {
            let tools = NSMenuItem(title: toolSummary, action: nil, keyEquivalent: "")
            tools.isEnabled = false
            menu.addItem(tools)
        }

        if let lastError {
            let errorItem = NSMenuItem(title: "Error: \(lastError)", action: nil, keyEquivalent: "")
            errorItem.isEnabled = false
            menu.addItem(errorItem)
        }

        menu.addItem(.separator())

        if serverProcess == nil {
            menu.addItem(withTitle: "Start Server", action: #selector(startServer), keyEquivalent: "")
        } else {
            menu.addItem(withTitle: "Stop Server", action: #selector(stopServer), keyEquivalent: "")
        }

        let modeItem = NSMenuItem(title: "Mode: \(selectedModeTitle)", action: nil, keyEquivalent: "")
        let modeMenu = NSMenu()
        for option in modeOptions {
            let item = NSMenuItem(
                title: option.title,
                action: #selector(selectMode(_:)),
                keyEquivalent: ""
            )
            item.target = self
            item.representedObject = option.id
            item.state = option.id == selectedModeId ? .on : .off
            modeMenu.addItem(item)
        }
        menu.addItem(modeItem)
        menu.setSubmenu(modeMenu, for: modeItem)

        let qualityItem = NSMenuItem(title: "Quality: \(selectedQualityTitle)", action: nil, keyEquivalent: "")
        let qualityMenu = NSMenu()
        for option in qualityOptions {
            let item = NSMenuItem(
                title: option.title,
                action: #selector(selectQuality(_:)),
                keyEquivalent: ""
            )
            item.target = self
            item.representedObject = option.id
            item.state = option.id == selectedQualityId ? .on : .off
            qualityMenu.addItem(item)
        }
        menu.addItem(qualityItem)
        menu.setSubmenu(qualityMenu, for: qualityItem)

        menu.addItem(withTitle: "Open Desktop", action: #selector(openDesktop), keyEquivalent: "")
        menu.addItem(withTitle: "Open Logs", action: #selector(openLogs), keyEquivalent: "")
        menu.addItem(withTitle: "Open Extension Folder", action: #selector(openExtensionFolder), keyEquivalent: "")

        menu.addItem(.separator())

        if let pendingUpdate, let latest = pendingUpdate.latest {
            let installItem = NSMenuItem(
                title: isInstallingUpdate ? "Installing Update..." : "Install Update v\(latest)",
                action: isInstallingUpdate ? nil : #selector(installUpdateAction),
                keyEquivalent: ""
            )
            installItem.target = self
            menu.addItem(installItem)

            if let releaseUrl = pendingUpdate.releaseUrl {
                let notes = NSMenuItem(
                    title: "Release Notes",
                    action: #selector(openReleaseNotes),
                    keyEquivalent: ""
                )
                notes.target = self
                notes.representedObject = releaseUrl
                menu.addItem(notes)
            }
        } else {
            let checkTitle = isCheckingUpdate
                ? (updateStatusLine ?? "Checking for Updates...")
                : "Check for Updates..."
            let checkItem = NSMenuItem(
                title: checkTitle,
                action: isCheckingUpdate ? nil : #selector(checkForUpdatesManually),
                keyEquivalent: ""
            )
            checkItem.target = self
            menu.addItem(checkItem)
        }

        menu.addItem(.separator())

        let loginItem = NSMenuItem(
            title: "Start at Login",
            action: #selector(toggleStartAtLogin),
            keyEquivalent: ""
        )
        loginItem.state = startAtLoginState()
        menu.addItem(loginItem)

        menu.addItem(.separator())
        menu.addItem(withTitle: "Quit YTDLPGrab", action: #selector(quitApp), keyEquivalent: "q")

        statusItem.menu = menu
    }

    private func restartServerIfNeeded() {
        if serverProcess != nil {
            requestServerStop(restart: true)
        } else {
            startServer()
        }
    }

    private func requestServerStop(restart: Bool) {
        guard let process = serverProcess else {
            restartAfterStop = false
            closeLogHandles()
            if restart {
                startServer()
            } else {
                healthSummary = "Stopped"
                refreshHealth()
            }
            return
        }

        restartAfterStop = restart
        healthSummary = restart ? "Restarting..." : "Stopping..."
        rebuildMenu()
        process.terminate()
    }

    private func startAtLoginState() -> NSControl.StateValue {
        guard #available(macOS 13.0, *) else {
            return .off
        }
        return SMAppService.mainApp.status == .enabled ? .on : .off
    }

    private func resolveJavaScriptExecutable() -> String? {
        for candidate in [
            bundledBinURL.appendingPathComponent("bun").path,
            bundledBinURL.appendingPathComponent("node").path,
            "/opt/homebrew/bin/node",
            "/usr/local/bin/node"
        ] where FileManager.default.isExecutableFile(atPath: candidate) {
            return candidate
        }
        return nil
    }

    private func ensureFileExists(_ url: URL) {
        if !FileManager.default.fileExists(atPath: url.path) {
            FileManager.default.createFile(atPath: url.path, contents: nil)
        }
    }

    private func closeLogHandles() {
        try? outputHandle?.close()
        try? errorHandle?.close()
        outputHandle = nil
        errorHandle = nil
    }

    private func appendDiagnostic(_ message: String) {
        do {
            try FileManager.default.createDirectory(
                at: logsDirectoryURL,
                withIntermediateDirectories: true
            )
            let formatter = ISO8601DateFormatter()
            let line = "[app] \(formatter.string(from: Date())) \(message)\n"
            let url = logsDirectoryURL.appendingPathComponent("app.log")
            ensureFileExists(url)
            let handle = try FileHandle(forWritingTo: url)
            try handle.seekToEnd()
            if let data = line.data(using: .utf8) {
                try handle.write(contentsOf: data)
            }
            try handle.close()
        } catch {
            // Diagnostics must never make the menu app fail to launch.
        }
    }
}

private struct QualityOption {
    let id: String
    let title: String
}

private struct DownloadModeOption {
    let id: String
    let title: String
}

private struct Health: Decodable {
    let ok: Bool
    let activeJobs: Int?
    let activeSaves: Int?
    let tools: Tools?
}

private struct Tools: Decodable {
    let ytDlp: ToolStatus
    let ffmpeg: ToolStatus
}

private struct ToolStatus: Decodable {
    let available: Bool
    let version: String?
}

private struct UpdateCheck: Decodable {
    let ok: Bool
    let current: String?
    let latest: String?
    let updateAvailable: Bool?
    let releaseUrl: String?
    let assets: UpdateAssets?
}

private struct UpdateAssets: Decodable {
    let dmg: String?
    let extensionZip: String?
}
